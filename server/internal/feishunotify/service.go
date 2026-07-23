// Package feishunotify delivers MindFS notification payloads to Feishu/Lark.
//
// Design notes (aligned with Codeg's Lark channel + MindFS notify fan-out):
//   - Codeg's Lark backend (src-tauri chat_channel/backends/lark.rs) uses
//     tenant_access_token + REST /im/v1/messages and optional WS receive.
//   - MindFS already fans session/scheduled events through AppContext.notifyPayload
//     to Web Push and notify-script. This package is another sink on that bus.
//   - First version is outbound push only (webhook and/or app+chat_id). Bidirectional
//     Feishu chat control can be layered later without changing the payload model.
package feishunotify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/config"
	"mindfs/server/internal/notify"
)

const (
	configFileName     = "feishu-notify.json"
	defaultTimeout     = 10 * time.Second
	maxConcurrentSends = 4
	tokenTTLSkew       = 60 * time.Second
	recentEventHorizon = 30 * time.Minute
	openAPIBase        = "https://open.feishu.cn"
)

// Config is persisted under MindFSConfigDir()/feishu-notify.json and can be
// overridden by startup flags/env.
type Config struct {
	Enabled    bool     `json:"enabled"`
	WebhookURL string   `json:"webhook_url,omitempty"`
	AppID      string   `json:"app_id,omitempty"`
	AppSecret  string   `json:"app_secret,omitempty"`
	ChatID     string   `json:"chat_id,omitempty"`
	// Events filters payload.Type; empty means all known types.
	Events []string `json:"events,omitempty"`
}

type persistedConfig = Config

type Service struct {
	config Config
	client *http.Client

	sem chan struct{}

	mu     sync.Mutex
	recent map[string]time.Time

	tokenMu     sync.Mutex
	accessToken string
	tokenExpiry time.Time
}

func NewService(cfg Config) *Service {
	cfg = normalizeConfig(cfg)
	return &Service{
		config: cfg,
		client: &http.Client{Timeout: defaultTimeout},
		sem:    make(chan struct{}, maxConcurrentSends),
		recent: make(map[string]time.Time),
	}
}

// LoadOrCreateConfig reads feishu-notify.json from the user config dir.
// Missing file is not an error: returns disabled config.
func LoadOrCreateConfig() (Config, error) {
	dir, err := config.MindFSConfigDir()
	if err != nil {
		return Config{}, err
	}
	path := filepath.Join(dir, configFileName)
	payload, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{Enabled: false}, nil
		}
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return Config{}, fmt.Errorf("decode %s: %w", path, err)
	}
	return normalizeConfig(cfg), nil
}

// MergeOverrides applies non-empty flag/env values onto a base config.
func MergeOverrides(base Config, webhookURL, appID, appSecret, chatID string, enabled *bool) Config {
	cfg := normalizeConfig(base)
	if enabled != nil {
		cfg.Enabled = *enabled
	}
	if v := strings.TrimSpace(webhookURL); v != "" {
		cfg.WebhookURL = v
		cfg.Enabled = true
	}
	if v := strings.TrimSpace(appID); v != "" {
		cfg.AppID = v
		cfg.Enabled = true
	}
	if v := strings.TrimSpace(appSecret); v != "" {
		cfg.AppSecret = v
	}
	if v := strings.TrimSpace(chatID); v != "" {
		cfg.ChatID = v
	}
	return normalizeConfig(cfg)
}

func normalizeConfig(cfg Config) Config {
	cfg.WebhookURL = strings.TrimSpace(cfg.WebhookURL)
	cfg.AppID = strings.TrimSpace(cfg.AppID)
	cfg.AppSecret = strings.TrimSpace(cfg.AppSecret)
	cfg.ChatID = strings.TrimSpace(cfg.ChatID)
	if len(cfg.Events) > 0 {
		out := make([]string, 0, len(cfg.Events))
		for _, e := range cfg.Events {
			e = strings.TrimSpace(e)
			if e != "" {
				out = append(out, e)
			}
		}
		cfg.Events = out
	}
	return cfg
}

func (s *Service) Enabled() bool {
	if s == nil {
		return false
	}
	if !s.config.Enabled {
		return false
	}
	if s.config.WebhookURL != "" {
		return true
	}
	return s.config.AppID != "" && s.config.AppSecret != "" && s.config.ChatID != ""
}

func (s *Service) NotifyPayload(ctx context.Context, payload notify.Payload) {
	if !s.Enabled() || !s.allowsEvent(payload.Type) || !s.shouldSend(notify.EventID(payload)) {
		return
	}
	go func() {
		if err := s.send(ctx, payload); err != nil {
			log.Printf("[feishu-notify] send.error type=%s tag=%s err=%v", payload.Type, payload.Tag, err)
		}
	}()
}

func (s *Service) allowsEvent(eventType string) bool {
	eventType = strings.TrimSpace(eventType)
	if len(s.config.Events) == 0 {
		return true
	}
	for _, e := range s.config.Events {
		if e == eventType {
			return true
		}
	}
	return false
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

func (s *Service) send(ctx context.Context, payload notify.Payload) error {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return ctx.Err()
	}

	body, err := buildFeishuBody(payload)
	if err != nil {
		return err
	}

	var firstErr error
	if s.config.WebhookURL != "" {
		if err := s.postJSON(ctx, s.config.WebhookURL, body); err != nil {
			firstErr = err
		}
	}
	if s.config.AppID != "" && s.config.AppSecret != "" && s.config.ChatID != "" {
		if err := s.sendAppMessage(ctx, body); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Service) sendAppMessage(ctx context.Context, interactiveBody map[string]any) error {
	token, err := s.getTenantAccessToken(ctx)
	if err != nil {
		return err
	}
	// Convert webhook-style interactive body into IM message API body.
	// Webhook: {msg_type, card}; IM API: {receive_id, msg_type, content: stringified card}
	card, _ := interactiveBody["card"]
	contentBytes, err := json.Marshal(card)
	if err != nil {
		return err
	}
	reqBody := map[string]any{
		"receive_id": s.config.ChatID,
		"msg_type":   "interactive",
		"content":    string(contentBytes),
	}
	url := openAPIBase + "/open-apis/im/v1/messages?receive_id_type=chat_id"
	return s.postJSONAuth(ctx, url, token, reqBody)
}

func (s *Service) getTenantAccessToken(ctx context.Context) (string, error) {
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	if s.accessToken != "" && time.Now().Before(s.tokenExpiry) {
		return s.accessToken, nil
	}
	reqBody := map[string]string{
		"app_id":     s.config.AppID,
		"app_secret": s.config.AppSecret,
	}
	raw, err := s.doJSON(ctx, http.MethodPost, openAPIBase+"/open-apis/auth/v3/tenant_access_token/internal", "", reqBody)
	if err != nil {
		return "", err
	}
	var resp struct {
		Code              int    `json:"code"`
		Msg               string `json:"msg"`
		TenantAccessToken string `json:"tenant_access_token"`
		Expire            int    `json:"expire"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", err
	}
	if resp.Code != 0 || strings.TrimSpace(resp.TenantAccessToken) == "" {
		return "", fmt.Errorf("feishu token error code=%d msg=%s", resp.Code, resp.Msg)
	}
	expire := time.Duration(resp.Expire) * time.Second
	if expire <= tokenTTLSkew {
		expire = 30 * time.Minute
	}
	s.accessToken = resp.TenantAccessToken
	s.tokenExpiry = time.Now().Add(expire - tokenTTLSkew)
	return s.accessToken, nil
}

func (s *Service) postJSON(ctx context.Context, url string, body any) error {
	raw, err := s.doJSON(ctx, http.MethodPost, url, "", body)
	if err != nil {
		return err
	}
	return checkFeishuResponse(raw)
}

func (s *Service) postJSONAuth(ctx context.Context, url, token string, body any) error {
	raw, err := s.doJSON(ctx, http.MethodPost, url, token, body)
	if err != nil {
		return err
	}
	return checkFeishuResponse(raw)
}

func (s *Service) doJSON(ctx context.Context, method, url, bearer string, body any) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	if strings.TrimSpace(bearer) != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("feishu http %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func checkFeishuResponse(raw []byte) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	var resp struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		// webhook sometimes uses StatusCode/StatusMessage
		StatusCode    int    `json:"StatusCode"`
		StatusMessage string `json:"StatusMessage"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		// Non-JSON success body is fine for some endpoints.
		return nil
	}
	if resp.Code != 0 {
		return fmt.Errorf("feishu api code=%d msg=%s", resp.Code, firstNonEmpty(resp.Msg, resp.StatusMessage))
	}
	if resp.StatusCode != 0 {
		return fmt.Errorf("feishu webhook status=%d msg=%s", resp.StatusCode, resp.StatusMessage)
	}
	return nil
}

func buildFeishuBody(payload notify.Payload) (map[string]any, error) {
	title := strings.TrimSpace(payload.Title)
	if title == "" {
		title = "MindFS"
	}
	body := strings.TrimSpace(payload.Body)
	if body == "" {
		body = payload.Type
	}
	// Interactive card similar to Codeg's build_lark_card (plain text elements).
	elements := []map[string]any{
		{
			"tag": "div",
			"text": map[string]any{
				"tag":     "plain_text",
				"content": body,
			},
		},
	}
	if url := strings.TrimSpace(payload.URL); url != "" && !strings.HasPrefix(url, "./") {
		elements = append(elements, map[string]any{
			"tag": "action",
			"actions": []map[string]any{
				{
					"tag": "button",
					"text": map[string]any{
						"tag":     "plain_text",
						"content": "打开会话",
					},
					"type": "primary",
					"url":  url,
				},
			},
		})
	} else if url := strings.TrimSpace(payload.URL); url != "" {
		elements = append(elements, map[string]any{
			"tag": "div",
			"text": map[string]any{
				"tag":     "plain_text",
				"content": "链接: " + url,
			},
		})
	}
	card := map[string]any{
		"header": map[string]any{
			"title": map[string]any{
				"tag":     "plain_text",
				"content": title,
			},
			"template": cardTemplate(payload.Type),
		},
		"elements": elements,
	}
	return map[string]any{
		"msg_type": "interactive",
		"card":     card,
	}, nil
}

func cardTemplate(eventType string) string {
	switch strings.TrimSpace(eventType) {
	case "session.ask_user", "scheduled.failed":
		return "orange"
	case "session.done", "scheduled.done":
		return "green"
	default:
		return "blue"
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
