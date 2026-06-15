package app

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/api"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/scheduled"
	"mindfs/server/internal/tlsutil"
	"mindfs/server/internal/update"
)

const staticDirEnvKey = "MINDFS_STATIC_DIR"
const externalProjectDiscoveryInterval = time.Minute
const hostedAgentsRefreshInterval = 10 * time.Minute

type StartOptions struct {
	NoRelayer       bool
	RelayBaseURL    string
	Version         string
	Args            []string
	AgentConfigPath string
	E2EEConfig      E2EEConfig
	UseTLS          bool
	CertFile        string
	KeyFile         string
}

type E2EEConfig struct {
	Enabled       bool
	NodeID        string
	PairingSecret string
}

type E2EEEnsureResult struct {
	Config    E2EEConfig
	Generated bool
}

func EnsureE2EEConfig(enabled bool) (E2EEEnsureResult, error) {
	result, err := e2ee.EnsureConfig(enabled)
	if err != nil {
		return E2EEEnsureResult{}, err
	}
	return E2EEEnsureResult{
		Config: E2EEConfig{
			Enabled:       result.Config.Enabled,
			NodeID:        result.Config.NodeID,
			PairingSecret: result.Config.PairingSecret,
		},
		Generated: result.Generated,
	}, nil
}

// Start boots the HTTP/WS server.
func Start(ctx context.Context, addr string, opts StartOptions) error {
	registry, err := fs.NewDefaultRegistry()
	if err != nil {
		return err
	}
	if err := registry.Load(); err != nil {
		return err
	}
	autoAddExternalProjectRoots(registry)
	startExternalProjectDiscoveryLoop(ctx, registry)

	agentConfig, err := agent.LoadConfigWithExtra(opts.AgentConfigPath)
	if err != nil {
		return err
	}
	relayBaseURL := opts.RelayBaseURL
	if relayBaseURL == "" {
		relayBaseURL = agentConfig.RelayBaseURL
	}
	agentPool := agent.NewPool(agentConfig)
	agentProber := agent.NewProber(&agentConfig, agentPool, 5*time.Minute)
	agentProber.Start(ctx)
	startHostedAgentConfigLoop(ctx, relayBaseURL, agentConfig, agentPool, agentProber)
	prefs, err := preferences.NewStore()
	if err != nil {
		log.Printf("[preferences] init.error err=%v", err)
	}
	executable, _ := os.Executable()
	updateSvc := update.NewService("a9gent/mindfs", opts.Version, executable, opts.Args, 10*time.Minute)
	updateSvc.Start(ctx)

	services := &api.AppContext{
		Dirs:   registry,
		Agents: agentPool,
		Prober: agentProber,
		Update: updateSvc,
		Prefs:  prefs,
		E2EE: e2ee.NewManager(e2ee.Config{
			Enabled:       opts.E2EEConfig.Enabled,
			NodeID:        opts.E2EEConfig.NodeID,
			PairingSecret: opts.E2EEConfig.PairingSecret,
		}),
	}
	services.Scheduled = scheduled.NewService(services, services)
	services.Scheduled.Start(ctx)
	githubImportSvc, err := githubimport.NewService(services)
	if err != nil {
		return err
	}
	services.GitHub = githubImportSvc
	httpHandler := &api.HTTPHandler{
		AppContext: services,
		StaticDir:  resolveStaticDir(),
		Version:    opts.Version,
	}
	wsHandler := &api.WSHandler{AppContext: services}

	mux := http.NewServeMux()
	mux.Handle("/", httpHandler.Routes())
	mux.Handle("/ws", wsHandler)

	handler := api.LoggingMiddleware(api.CORSMiddleware(mux))

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer listener.Close()
	localCLIToken, err := EnsureLocalCLIToken(addr)
	if err != nil {
		return err
	}
	httpHandler.LocalCLIToken = localCLIToken

	relayMgr, err := relay.NewManager(addr, opts.NoRelayer, relayBaseURL, opts.UseTLS)
	if err != nil {
		return err
	}
	services.Relay = relayMgr
	services.RelayTips = relay.NewTipsService(relayMgr)
	if err := relayMgr.Start(ctx); err != nil {
		return err
	}
	services.RelayTips.Start(ctx)

	go func() {
		<-ctx.Done()
		agentProber.Stop()
		agentPool.CloseAll()
		server.Shutdown(context.Background())
	}()

	if services.E2EE != nil {
		services.E2EE.StartCleanup(ctx.Done())
	}

	if opts.UseTLS {
		return server.ServeTLS(listener, opts.CertFile, opts.KeyFile)
	}
	return server.Serve(listener)
}

func startHostedAgentConfigLoop(ctx context.Context, relayBaseURL string, localConfig agent.Config, pool *agent.Pool, prober *agent.Prober) {
	endpoint, err := hostedAgentsURL(relayBaseURL)
	if err != nil {
		log.Printf("[agents/hosted] disabled invalid_relay_base_url=%q err=%v", relayBaseURL, err)
		return
	}
	go func() {
		refresh := func() {
			merged, err := fetchHostedAgentConfig(ctx, endpoint, localConfig)
			if err != nil {
				log.Printf("[agents/hosted] refresh.error url=%s err=%v", endpoint, err)
				return
			}
			effective := pool.UpdateConfig(merged)
			prober.UpdateConfig(ctx, &effective)
			log.Printf("[agents/hosted] refresh.ok url=%s agents=%d", endpoint, len(effective.Agents))
		}
		refresh()
		ticker := time.NewTicker(hostedAgentsRefreshInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				refresh()
			}
		}
	}()
}

func hostedAgentsURL(relayBaseURL string) (string, error) {
	base := strings.TrimSpace(relayBaseURL)
	if base == "" {
		return "", fmt.Errorf("relay base url required")
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	if u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("relay base url must be absolute")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/agents"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

func fetchHostedAgentConfig(ctx context.Context, endpoint string, localConfig agent.Config) (agent.Config, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return agent.Config{}, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return agent.Config{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return agent.Config{}, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return agent.Config{}, err
	}
	hosted, err := agent.DecodeConfig(body)
	if err != nil {
		return agent.Config{}, err
	}
	return agent.MergeHostedConfig(hosted, localConfig), nil
}

func autoAddExternalProjectRoots(registry *fs.Registry) {
	if registry == nil {
		return
	}
	existing := make(map[string]struct{})
	for _, root := range registry.List() {
		normalized := agent.NormalizeComparablePath(root.RootPath)
		if normalized != "" {
			existing[normalized] = struct{}{}
		}
	}
	added := 0
	for _, projectPath := range agent.DiscoverExternalProjectPaths() {
		normalized := agent.NormalizeComparablePath(projectPath)
		if normalized == "" {
			continue
		}
		if _, ok := existing[normalized]; ok {
			continue
		}
		if hasMindFSMetadataDir(projectPath) {
			continue
		}
		if agent.IsTemporaryWorkDir(projectPath) {
			continue
		}
		if _, err := registry.Upsert(projectPath); err != nil {
			log.Printf("[startup/projects] auto add skipped path=%s err=%v", projectPath, err)
			continue
		}
		existing[normalized] = struct{}{}
		added++
	}
	if added > 0 {
		log.Printf("[startup/projects] auto added external project roots count=%d", added)
	}
}

func hasMindFSMetadataDir(projectPath string) bool {
	projectPath = strings.TrimSpace(projectPath)
	if projectPath == "" {
		return false
	}
	info, err := os.Stat(filepath.Join(projectPath, ".mindfs"))
	return err == nil && info.IsDir()
}

func startExternalProjectDiscoveryLoop(ctx context.Context, registry *fs.Registry) {
	if registry == nil {
		return
	}
	ticker := time.NewTicker(externalProjectDiscoveryInterval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				autoAddExternalProjectRoots(registry)
			}
		}
	}()
}

func resolveStaticDir() string {
	if hinted := strings.TrimSpace(os.Getenv(staticDirEnvKey)); hinted != "" {
		if info, err := os.Stat(hinted); err == nil && info.IsDir() {
			return hinted
		}
	}

	if exe, err := os.Executable(); err == nil {
		return resolveStaticDirFromExecutable(exe)
	}
	return ""
}

func resolveStaticDirFromExecutable(exe string) string {
	exe = strings.TrimSpace(exe)
	if exe == "" {
		return ""
	}
	exeDir := filepath.Dir(exe)
	// 本地构建布局为仓库根目录 mindfs + web/dist。
	candidate := filepath.Join(exeDir, "web", "dist")
	if isFrontendStaticDir(candidate) {
		return candidate
	}
	// 发布 zip 解压后，web 目录和可执行文件在同一层级。
	candidate = filepath.Join(exeDir, "web")
	if isFrontendStaticDir(candidate) {
		return candidate
	}
	// 安装布局为 <prefix>/bin/mindfs + <prefix>/share/mindfs/web。
	candidate = filepath.Join(filepath.Dir(exeDir), "share", "mindfs", "web")
	if isFrontendStaticDir(candidate) {
		return candidate
	}
	return ""
}

func isFrontendStaticDir(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	for _, name := range []string{"index.html", "favicon.svg"} {
		info, err := os.Stat(filepath.Join(path, name))
		if err != nil || info.IsDir() {
			return false
		}
	}
	return true
}

func RemoveManagedDirFromRegistry(path string) error {
	registry, err := fs.NewDefaultRegistry()
	if err != nil {
		return err
	}
	if err := registry.Load(); err != nil {
		return err
	}
	_, err = registry.Remove(path)
	return err
}

// EnsureTLSCert resolves TLS certificate and key file paths for the server.
// When certFlag or keyFlag are empty, a self-signed certificate is generated
// under os.UserConfigDir/mindfs/ and reused across restarts.
func EnsureTLSCert(certFlag, keyFlag string) (string, string, error) {
	return tlsutil.EnsureCert(certFlag, keyFlag)
}
