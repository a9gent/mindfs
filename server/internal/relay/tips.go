package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const relayTipsRefreshInterval = 30 * time.Minute

type Tip struct {
	ID          string `json:"id"`
	Badge       string `json:"badge,omitempty"`
	Eyebrow     string `json:"eyebrow,omitempty"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	CTALabel    string `json:"cta_label,omitempty"`
	Href        string `json:"href,omitempty"`
	Target      string `json:"target,omitempty"`
	Dismissible bool   `json:"dismissible"`
}

type TipsService struct {
	manager *Manager
	client  *http.Client

	mu       sync.RWMutex
	current  []Tip
	lastErr  string
	lastSync time.Time
}

func NewTipsService(manager *Manager) *TipsService {
	return &TipsService{
		manager: manager,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (s *TipsService) Start(ctx context.Context) {
	if s == nil {
		return
	}
	s.refresh(ctx)
	go s.loop(ctx)
}

func (s *TipsService) loop(ctx context.Context) {
	ticker := time.NewTicker(relayTipsRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.refresh(ctx)
		}
	}
}

func (s *TipsService) Get() []Tip {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.current) == 0 {
		return nil
	}
	tips := make([]Tip, len(s.current))
	copy(tips, s.current)
	return tips
}

func (s *TipsService) refresh(ctx context.Context) {
	tips, err := s.fetch(ctx)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastSync = time.Now().UTC()
	if err != nil {
		s.lastErr = err.Error()
		return
	}
	s.lastErr = ""
	s.current = tips
}

func (s *TipsService) fetch(ctx context.Context) ([]Tip, error) {
	if s == nil || s.manager == nil {
		return nil, nil
	}
	status := s.manager.Status()
	if status.NoRelayer || strings.TrimSpace(status.RelayBaseURL) == "" {
		return nil, nil
	}
	endpoint, err := buildTipsURL(status.RelayBaseURL, status.NodeID)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	if s.manager != nil && s.manager.service != nil {
		if err := s.manager.service.attachDeviceID(req); err != nil {
			return nil, err
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("relay tips failed: %s %s", resp.Status, strings.TrimSpace(string(payload)))
	}
	var payload json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, err
	}

	var tips []Tip
	if len(payload) == 0 || string(payload) == "null" {
		return nil, nil
	}
	if payload[0] == '[' {
		if err := json.Unmarshal(payload, &tips); err != nil {
			return nil, err
		}
	} else {
		var tip Tip
		if err := json.Unmarshal(payload, &tip); err != nil {
			return nil, err
		}
		tips = []Tip{tip}
	}

	filtered := make([]Tip, 0, len(tips))
	for _, tip := range tips {
		if strings.TrimSpace(tip.ID) == "" || strings.TrimSpace(tip.Title) == "" {
			continue
		}
		filtered = append(filtered, tip)
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	return filtered, nil
}

func buildTipsURL(baseURL, nodeID string) (string, error) {
	baseURL = strings.TrimSuffix(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return "", fmt.Errorf("relay base URL required")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimSuffix(u.Path, "/") + "/api/tips"
	q := u.Query()
	if trimmedNodeID := strings.TrimSpace(nodeID); trimmedNodeID != "" {
		q.Set("node_id", trimmedNodeID)
	}
	u.RawQuery = q.Encode()
	u.Fragment = ""
	return u.String(), nil
}
