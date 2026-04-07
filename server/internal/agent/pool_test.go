package agent

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	agenttypes "mindfs/server/internal/agent/types"
)

func loadPoolTestConfig(t *testing.T) Config {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("runtime.Caller failed")
	}
	cfgPath := filepath.Join(filepath.Dir(thisFile), "testdata", "agents.json")
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadConfig(%s) failed: %v", cfgPath, err)
	}
	return cfg
}

func TestPoolGetOrCreateRequiresSessionKey(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "session key required") {
		t.Fatalf("expected session key required error, got: %v", err)
	}
}

func TestPoolGetOrCreateUnknownAgent(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-1",
		AgentName:  "unknown-agent",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "agent not configured") {
		t.Fatalf("expected agent not configured error, got: %v", err)
	}
}

func TestPoolGetOrCreateUsesAgentsJSONConfig(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	def, ok := cfg.GetAgent("gemini")
	if !ok {
		t.Fatalf("expected gemini in test agents.json")
	}
	def.Command = "this-command-should-not-exist-for-tests"
	for i := range cfg.Agents {
		if cfg.Agents[i].Name == "gemini" {
			cfg.Agents[i] = def
		}
	}

	pool := NewPool(cfg)
	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-2",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil {
		t.Fatalf("expected start error from non-existent command")
	}
	if !strings.Contains(err.Error(), "this-command-should-not-exist-for-tests") {
		t.Fatalf("expected overridden command in error, got: %v", err)
	}
}

func TestPoolCloseAndCloseAll(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	pool.sessions["s-3"] = &sessionEntry{
		agentName:  "test-agent",
		sessionKey: "s-3",
		session:    nil,
	}

	pool.Close("s-3")
	if _, ok := pool.sessions["s-3"]; ok {
		t.Fatalf("expected session removed after Close")
	}

	pool.CloseAll()
	if len(pool.sessions) != 0 {
		t.Fatalf("expected sessions cleared by CloseAll")
	}
}

func TestPoolGetOrCreateAfterCloseAll(t *testing.T) {
	pool := NewPool(loadPoolTestConfig(t))
	pool.CloseAll()

	_, err := pool.GetOrCreate(context.Background(), agenttypes.OpenSessionInput{
		SessionKey: "s-closed",
		AgentName:  "gemini",
		RootPath:   t.TempDir(),
	})
	if err == nil || !strings.Contains(err.Error(), "agent pool closed") {
		t.Fatalf("expected agent pool closed error, got: %v", err)
	}
}

func TestPoolConfigReturnsLoadedConfig(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	pool := NewPool(cfg)

	got := pool.Config()
	if _, ok := got.GetAgent("gemini"); !ok {
		t.Fatalf("expected gemini in pool config")
	}
}

func TestLoadConfigReadsRelayBaseURL(t *testing.T) {
	cfg := loadPoolTestConfig(t)
	if cfg.RelayBaseURL != "https://relay.example.com" {
		t.Fatalf("relay base url = %q", cfg.RelayBaseURL)
	}
}
