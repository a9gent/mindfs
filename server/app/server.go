package app

import (
	"context"
	"net/http"
	"os"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/api"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/relay"
)

type StartOptions struct {
	StaticDir string
	BindCode  string
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
	agentPool := agent.NewPool(agentConfig)
	agentProber := agent.NewProber(&agentConfig, agentPool, 5*time.Minute)
	agentProber.Start(ctx)

	services := &api.AppContext{
		Dirs:   registry,
		Agents: agentPool,
		Prober: agentProber,
	}
	httpHandler := &api.HTTPHandler{
		AppContext: services,
		StaticDir:  resolveStaticDir(opts.StaticDir),
	}
	wsHandler := &api.WSHandler{AppContext: services}

	mux := http.NewServeMux()
	mux.Handle("/", httpHandler.Routes())
	mux.Handle("/ws", wsHandler)

	handler := api.LoggingMiddleware(mux)

	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	relayMgr, err := relay.NewManager(addr, opts.BindCode)
	if err != nil {
		return err
	}
	services.Relay = relayMgr
	if err := relayMgr.Start(ctx); err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		agentProber.Stop()
		agentPool.CloseAll()
		server.Shutdown(context.Background())
	}()

	return server.ListenAndServe()
}

func resolveStaticDir(staticDir string) string {
	if staticDir == "" {
		return ""
	}
	if info, err := os.Stat(staticDir); err == nil && info.IsDir() {
		return staticDir
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
