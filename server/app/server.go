package app

import (
	"context"
	"log"
	"net/http"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/api"
	"mindfs/server/internal/fs"
)

// Start boots the HTTP/WS server.
func Start(ctx context.Context, addr string) error {
	registry, err := fs.NewDefaultRegistry()
	if err != nil {
		return err
	}
	_ = registry.Load()

	agentConfig, err := agent.LoadConfig("")
	if err != nil {
		return err
	}
	agentPool := agent.NewPool(agentConfig)
	agentProber := agent.NewProber(&agentConfig, 5*time.Minute)
	agentProber.Start(ctx)

	services := &api.AppContext{
		Dirs:   registry,
		Agents: agentPool,
		Prober: agentProber,
	}
	httpHandler := &api.HTTPHandler{AppContext: services}
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

	go func() {
		<-ctx.Done()
		agentProber.Stop()
		agentPool.CloseAll()
		_ = server.Shutdown(context.Background())
	}()

	log.Printf("[server] listening addr=%s", addr)
	return server.ListenAndServe()
}
