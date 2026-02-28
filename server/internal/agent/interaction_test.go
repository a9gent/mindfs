package agent

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

// TestRealAgentInteraction verifies real end-to-end send/receive flow.
// It is intentionally opt-in because it depends on local agent binaries/auth.
//
// Run example:
//
//	MINDFS_RUN_REAL_AGENT=1 go test ./server/internal/agent -run TestRealAgentInteraction -v
//
// Optional overrides:
//
//	MINDFS_IT_AGENT_NAME=codex
func TestRealAgentInteraction(t *testing.T) {
	if os.Getenv("MINDFS_RUN_REAL_AGENT") != "1" {
		t.Skip("set MINDFS_RUN_REAL_AGENT=1 to run real agent interaction test")
	}

	cfg, err := LoadConfig("")
	if err != nil {
		t.Skipf("LoadConfig failed: %v", err)
	}

	agentName, ok := selectConfiguredAgent(cfg)
	if !ok {
		t.Skip("no runnable configured ACP agent found (set MINDFS_IT_AGENT_NAME)")
	}

	pool := NewPool(cfg)
	defer pool.CloseAll()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	sessionKey := "real-it-" + time.Now().UTC().Format("20060102-150405")
	sess, err := pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{
		SessionKey: sessionKey,
		AgentName:  agentName,
		RootPath:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("GetOrCreate failed: %v", err)
	}
	if err := VerifySessionInteraction(ctx, sess); err != nil {
		t.Fatalf("VerifySessionInteraction failed: %v", err)
	}
}

func selectConfiguredAgent(cfg Config) (string, bool) {
	want := strings.TrimSpace(os.Getenv("MINDFS_IT_AGENT_NAME"))
	if want != "" {
		def, ok := cfg.GetAgent(want)
		if !ok {
			return "", false
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			return "", false
		}
		return want, true
	}

	for _, name := range []string{"codex", "claude", "gemini"} {
		def, ok := cfg.GetAgent(name)
		if !ok || def.Protocol != ProtocolACP {
			continue
		}
		if _, err := exec.LookPath(def.Command); err != nil {
			continue
		}
		return name, true
	}
	return "", false
}
