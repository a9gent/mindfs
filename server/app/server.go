package app

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/api"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/update"
)

type StartOptions struct {
	NoRelayer    bool
	RelayBaseURL string
	Version      string
	Args         []string
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
	executable, _ := os.Executable()
	updateSvc := update.NewService("a9gent/mindfs", opts.Version, executable, opts.Args, 10*time.Minute)
	updateSvc.Start(ctx)

	services := &api.AppContext{
		Dirs:   registry,
		Agents: agentPool,
		Prober: agentProber,
		Update: updateSvc,
	}
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

	relayMgr, err := relay.NewManager(addr, opts.NoRelayer, relayBaseURL)
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

	return server.ListenAndServe()
}

func resolveStaticDir() string {
	if exe, err := os.Executable(); err == nil {
		prefix := filepath.Dir(filepath.Dir(exe))
		candidate := filepath.Join(prefix, "share", "mindfs", "web")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		
		// Fallback for development (running from workspace root)
		cwdCandidate := filepath.Join(filepath.Dir(exe), "web", "dist")
		if info, err := os.Stat(cwdCandidate); err == nil && info.IsDir() {
			return cwdCandidate
		}
	}
	return ""
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
