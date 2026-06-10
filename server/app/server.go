package app

import (
	"context"
	"log"
	"net"
	"net/http"
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

type StartOptions struct {
	NoRelayer    bool
	RelayBaseURL string
	Version      string
	Args         []string
	E2EEConfig   E2EEConfig
	UseTLS       bool
	CertFile     string
	KeyFile      string
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

	agentConfig, err := agent.LoadConfig("")
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
