package notifyscript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/notify"
)

const (
	defaultTimeout     = 10 * time.Second
	maxCapturedOutput  = 4096
	maxConcurrentRuns  = 4
	recentEventHorizon = 30 * time.Minute
)

type Config struct {
	Script  string
	Timeout time.Duration
}

type Service struct {
	config Config

	sem chan struct{}

	mu     sync.Mutex
	recent map[string]time.Time
}

func NewService(config Config) *Service {
	config.Script = strings.TrimSpace(config.Script)
	if config.Timeout <= 0 {
		config.Timeout = defaultTimeout
	}
	return &Service{
		config: config,
		sem:    make(chan struct{}, maxConcurrentRuns),
		recent: make(map[string]time.Time),
	}
}

func (s *Service) Enabled() bool {
	return s != nil && strings.TrimSpace(s.config.Script) != ""
}

func (s *Service) NotifyPayload(ctx context.Context, payload notify.Payload) {
	if !s.Enabled() || !s.shouldSend(notify.EventID(payload)) {
		return
	}
	go func() {
		if err := s.send(ctx, payload); err != nil {
			log.Printf("[notify-script] send.error type=%s tag=%s err=%v", payload.Type, payload.Tag, err)
		}
	}()
}

func (s *Service) send(ctx context.Context, payload notify.Payload) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	runCtx, cancel := context.WithTimeout(ctx, s.config.Timeout)
	defer cancel()
	cmd := commandForScript(runCtx, s.config.Script)
	cmd.Stdin = bytes.NewReader(body)
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return runCtx.Err()
		}
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = strings.TrimSpace(stdout.String())
		}
		if detail == "" {
			return err
		}
		return errors.New(err.Error() + ": " + detail)
	}
	return nil
}

func (s *Service) shouldSend(eventID string) bool {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return true
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, seen := range s.recent {
		if now.Sub(seen) > recentEventHorizon {
			delete(s.recent, key)
		}
	}
	if _, ok := s.recent[eventID]; ok {
		return false
	}
	s.recent[eventID] = now
	return true
}

func commandForScript(ctx context.Context, script string) *exec.Cmd {
	name, args := commandSpecForScript(runtime.GOOS, script)
	return exec.CommandContext(ctx, name, args...)
}

func commandSpecForScript(goos, script string) (string, []string) {
	if goos != "windows" {
		return script, nil
	}
	ext := strings.ToLower(filepath.Ext(script))
	switch ext {
	case ".bat", ".cmd":
		return "cmd.exe", []string{"/C", script}
	case ".ps1":
		return "powershell.exe", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script}
	default:
		return script, nil
	}
}

type limitedBuffer struct {
	buf bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	remaining := maxCapturedOutput - b.buf.Len()
	if remaining > 0 {
		if len(p) > remaining {
			_, _ = b.buf.Write(p[:remaining])
		} else {
			_, _ = b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string {
	return b.buf.String()
}
