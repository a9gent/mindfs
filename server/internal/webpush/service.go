package webpush

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/config"

	webpushgo "github.com/SherClockHolmes/webpush-go"
)

const (
	subscriptionsFileName = "web-push-subscriptions.json"
	vapidKeysFileName     = "web-push-vapid.json"
	defaultVAPIDSubject   = "mindfs@example.com"
	defaultTTLSeconds     = 60 * 60
	maxPayloadBytes       = 3800
)

type Config struct {
	Enabled    bool
	PublicKey  string
	PrivateKey string
	Subject    string
}

type persistedVAPIDKeys struct {
	PublicKey  string    `json:"public_key"`
	PrivateKey string    `json:"private_key"`
	Subject    string    `json:"subject,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

func EnsureConfig(enabled bool) (Config, error) {
	subject := defaultVAPIDSubject
	if !enabled {
		return Config{Enabled: false, Subject: subject}, nil
	}
	keys, err := ensureVAPIDKeys(subject)
	if err != nil {
		return Config{Enabled: false, Subject: subject}, err
	}
	return Config{
		Enabled:    keys.PublicKey != "" && keys.PrivateKey != "",
		PublicKey:  keys.PublicKey,
		PrivateKey: keys.PrivateKey,
		Subject:    subject,
	}, nil
}

func ensureVAPIDKeys(subject string) (persistedVAPIDKeys, error) {
	configDir, err := config.MindFSConfigDir()
	if err != nil {
		return persistedVAPIDKeys{}, err
	}
	path := filepath.Join(configDir, vapidKeysFileName)
	if keys, err := readVAPIDKeys(path); err == nil && keys.PublicKey != "" && keys.PrivateKey != "" {
		if strings.TrimSpace(keys.Subject) == "" {
			keys.Subject = subject
		}
		return keys, nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return persistedVAPIDKeys{}, err
	}
	privateKey, publicKey, err := webpushgo.GenerateVAPIDKeys()
	if err != nil {
		return persistedVAPIDKeys{}, err
	}
	keys := persistedVAPIDKeys{
		PublicKey:  publicKey,
		PrivateKey: privateKey,
		Subject:    subject,
		CreatedAt:  time.Now().UTC(),
	}
	return keys, writeVAPIDKeys(path, keys)
}

func readVAPIDKeys(path string) (persistedVAPIDKeys, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return persistedVAPIDKeys{}, err
	}
	var keys persistedVAPIDKeys
	if err := json.Unmarshal(b, &keys); err != nil {
		return persistedVAPIDKeys{}, err
	}
	return keys, nil
}

func writeVAPIDKeys(path string, keys persistedVAPIDKeys) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		if retryErr := os.Rename(tmp, path); retryErr != nil {
			return err
		}
	}
	return nil
}

type Store struct {
	mu   sync.Mutex
	path string
}

func NewStore() (*Store, error) {
	configDir, err := config.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(configDir, subscriptionsFileName)}, nil
}

type SubscriptionKeys struct {
	Auth   string `json:"auth"`
	P256dh string `json:"p256dh"`
}

type Subscription struct {
	ID        string           `json:"id"`
	Endpoint  string           `json:"endpoint"`
	Keys      SubscriptionKeys `json:"keys"`
	UserAgent string           `json:"user_agent,omitempty"`
	Platform  string           `json:"platform,omitempty"`
	Enabled   bool             `json:"enabled"`
	LastError string           `json:"last_error,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
}

func (s *Store) List() ([]Subscription, error) {
	if s == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadLocked()
}

func (s *Store) GetByEndpoint(endpoint string) (Subscription, bool, error) {
	if s == nil {
		return Subscription{}, false, nil
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return Subscription{}, false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return Subscription{}, false, err
	}
	for _, item := range items {
		if item.Endpoint == endpoint {
			return item, true, nil
		}
	}
	return Subscription{}, false, nil
}

func (s *Store) Upsert(in Subscription) (Subscription, error) {
	if s == nil {
		return Subscription{}, errors.New("web push store not configured")
	}
	in.Endpoint = strings.TrimSpace(in.Endpoint)
	in.Keys.Auth = strings.TrimSpace(in.Keys.Auth)
	in.Keys.P256dh = strings.TrimSpace(in.Keys.P256dh)
	if in.Endpoint == "" || in.Keys.Auth == "" || in.Keys.P256dh == "" {
		return Subscription{}, errors.New("web push subscription endpoint and keys are required")
	}
	now := time.Now().UTC()
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return Subscription{}, err
	}
	for i := range items {
		if items[i].Endpoint != in.Endpoint {
			continue
		}
		items[i].Keys = in.Keys
		items[i].UserAgent = strings.TrimSpace(in.UserAgent)
		items[i].Platform = strings.TrimSpace(in.Platform)
		items[i].Enabled = true
		items[i].LastError = ""
		items[i].UpdatedAt = now
		if err := s.saveLocked(items); err != nil {
			return Subscription{}, err
		}
		return items[i], nil
	}
	in.ID = subscriptionID(in.Endpoint)
	in.Enabled = true
	in.CreatedAt = now
	in.UpdatedAt = now
	items = append(items, in)
	if err := s.saveLocked(items); err != nil {
		return Subscription{}, err
	}
	return in, nil
}

func (s *Store) Delete(endpoint string) error {
	if s == nil {
		return nil
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return err
	}
	next := items[:0]
	for _, item := range items {
		if item.Endpoint != endpoint {
			next = append(next, item)
		}
	}
	return s.saveLocked(next)
}

func (s *Store) DeleteByID(id string) error {
	if s == nil {
		return nil
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return err
	}
	next := items[:0]
	for _, item := range items {
		if item.ID != id {
			next = append(next, item)
		}
	}
	return s.saveLocked(next)
}

func (s *Store) MarkError(id, message string) error {
	if s == nil {
		return nil
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	items, err := s.loadLocked()
	if err != nil {
		return err
	}
	for i := range items {
		if items[i].ID == id {
			items[i].LastError = strings.TrimSpace(message)
			items[i].UpdatedAt = time.Now().UTC()
			break
		}
	}
	return s.saveLocked(items)
}

func (s *Store) loadLocked() ([]Subscription, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Subscription{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return []Subscription{}, nil
	}
	var items []Subscription
	if err := json.Unmarshal(b, &items); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Store) saveLocked(items []Subscription) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(s.path)
		if retryErr := os.Rename(tmp, s.path); retryErr != nil {
			return err
		}
	}
	return nil
}

type Service struct {
	config Config
	store  *Store

	mu     sync.Mutex
	recent map[string]time.Time
}

func NewService(config Config, store *Store) *Service {
	return &Service{
		config: config,
		store:  store,
		recent: make(map[string]time.Time),
	}
}

func (s *Service) Enabled() bool {
	return s != nil && s.config.Enabled && s.config.PublicKey != "" && s.config.PrivateKey != "" && s.store != nil
}

func (s *Service) PublicKey() string {
	if s == nil || !s.config.Enabled {
		return ""
	}
	return s.config.PublicKey
}

func (s *Service) Status() map[string]any {
	enabled := s.Enabled()
	count := 0
	platforms := map[string]int{}
	if enabled {
		if items, err := s.store.List(); err == nil {
			for _, item := range items {
				if item.Enabled {
					count++
					platform := strings.TrimSpace(item.Platform)
					if platform == "" {
						platform = "unknown"
					}
					platforms[platform]++
				}
			}
		}
	}
	return map[string]any{
		"enabled":            enabled,
		"vapid_public_key":   s.PublicKey(),
		"subscription_count": count,
		"platform_counts":    platforms,
	}
}

func (s *Service) SaveSubscription(sub Subscription) (Subscription, error) {
	if !s.Enabled() {
		return Subscription{}, errors.New("web push is not configured")
	}
	return s.store.Upsert(sub)
}

func (s *Service) DeleteSubscription(endpoint string) error {
	if s == nil || s.store == nil {
		return nil
	}
	return s.store.Delete(endpoint)
}

type Payload struct {
	Type               string         `json:"type"`
	Title              string         `json:"title"`
	Body               string         `json:"body,omitempty"`
	Tag                string         `json:"tag,omitempty"`
	URL                string         `json:"url,omitempty"`
	Icon               string         `json:"icon,omitempty"`
	Badge              string         `json:"badge,omitempty"`
	Renotify           bool           `json:"renotify,omitempty"`
	RequireInteraction bool           `json:"requireInteraction,omitempty"`
	Data               map[string]any `json:"data,omitempty"`
}

type SessionNotification struct {
	Type         string
	RootID       string
	RootTitle    string
	SessionKey   string
	SessionTitle string
	Summary      string
	EventID      string
}

type ScheduledNotification struct {
	RootID     string
	RootTitle  string
	TaskID     string
	TaskName   string
	SessionKey string
	Summary    string
	Error      string
	Success    bool
	EventID    string
}

func (s *Service) NotifySession(ctx context.Context, in SessionNotification) {
	if s == nil || !s.Enabled() {
		return
	}
	payload := BuildSessionPayload(in)
	s.sendAsync(ctx, firstNonEmpty(in.EventID, payload.Tag), payload)
}

func (s *Service) NotifyScheduled(ctx context.Context, in ScheduledNotification) {
	if s == nil || !s.Enabled() {
		return
	}
	payload := BuildScheduledPayload(in)
	s.sendAsync(ctx, firstNonEmpty(in.EventID, payload.Tag), payload)
}

func (s *Service) SendTest(ctx context.Context) error {
	if !s.Enabled() {
		return errors.New("web push is not configured")
	}
	return s.send(ctx, testPayload())
}

func (s *Service) SendTestToEndpoint(ctx context.Context, endpoint string) error {
	if !s.Enabled() {
		return errors.New("web push is not configured")
	}
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return errors.New("web push subscription endpoint is required")
	}
	item, ok, err := s.store.GetByEndpoint(endpoint)
	if err != nil {
		return err
	}
	if !ok || !item.Enabled {
		return errors.New("web push subscription is not registered on this server")
	}
	return s.sendToItems(ctx, testPayload(), []Subscription{item})
}

func testPayload() Payload {
	eventID := "test:" + time.Now().UTC().Format(time.RFC3339Nano)
	return Payload{
		Type:  "test",
		Title: "MindFS",
		Body:  "通知已开启",
		URL:   "./",
		Data:  map[string]any{"type": "test", "eventId": eventID},
	}
}

func BuildSessionPayload(in SessionNotification) Payload {
	kind := strings.TrimSpace(in.Type)
	if kind == "" {
		kind = "session.done"
	}
	status := "完成"
	if kind == "session.ask_user" {
		status = "需要输入"
	}
	root := firstNonEmpty(in.RootTitle, in.RootID, "MindFS")
	sessionTitle := firstNonEmpty(in.SessionTitle, "会话")
	title := fmt.Sprintf("%s · %s · %s", root, sessionTitle, status)
	body := truncateRunes(strings.TrimSpace(in.Summary), 180)
	tag := fmt.Sprintf("mindfs:%s:%s:%s", kind, in.RootID, in.SessionKey)
	eventID := firstNonEmpty(in.EventID, tag)
	if kind == "session.done" {
		tag = fmt.Sprintf("mindfs:%s:%s:%s:%s", kind, in.RootID, in.SessionKey, eventID)
	}
	return Payload{
		Type:               kind,
		Title:              title,
		Body:               body,
		Tag:                tag,
		URL:                sessionURL(in.RootID, in.SessionKey),
		Icon:               "./pwa-192.png",
		Badge:              "./pwa-192.png",
		Renotify:           kind == "session.ask_user" || kind == "session.done",
		RequireInteraction: kind == "session.ask_user",
		Data: map[string]any{
			"type":       kind,
			"rootId":     in.RootID,
			"sessionKey": in.SessionKey,
			"eventId":    eventID,
		},
	}
}

func BuildScheduledPayload(in ScheduledNotification) Payload {
	root := firstNonEmpty(in.RootTitle, in.RootID, "MindFS")
	status := "定时任务完成"
	kind := "scheduled.done"
	body := strings.TrimSpace(in.Summary)
	renotify := false
	if !in.Success {
		status = "定时任务失败"
		kind = "scheduled.failed"
		body = strings.TrimSpace(in.Error)
		renotify = true
	}
	taskName := firstNonEmpty(in.TaskName, "未命名任务")
	if body == "" {
		body = taskName
	} else {
		body = taskName + ": " + body
	}
	tag := fmt.Sprintf("mindfs:%s:%s:%s", kind, in.RootID, in.TaskID)
	return Payload{
		Type:               kind,
		Title:              fmt.Sprintf("%s · %s", root, status),
		Body:               truncateRunes(body, 180),
		Tag:                tag,
		URL:                sessionURL(in.RootID, in.SessionKey),
		Icon:               "./pwa-192.png",
		Badge:              "./pwa-192.png",
		Renotify:           renotify,
		RequireInteraction: !in.Success,
		Data: map[string]any{
			"type":       kind,
			"rootId":     in.RootID,
			"sessionKey": in.SessionKey,
			"taskId":     in.TaskID,
			"eventId":    firstNonEmpty(in.EventID, tag),
		},
	}
}

func (s *Service) sendAsync(ctx context.Context, eventID string, payload Payload) {
	if !s.shouldSend(eventID) {
		return
	}
	go func() {
		if err := s.send(ctx, payload); err != nil {
			log.Printf("[webpush] send.error type=%s tag=%s err=%v", payload.Type, payload.Tag, err)
		}
	}()
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
		if now.Sub(seen) > 30*time.Minute {
			delete(s.recent, key)
		}
	}
	if _, ok := s.recent[eventID]; ok {
		return false
	}
	s.recent[eventID] = now
	return true
}

func (s *Service) send(ctx context.Context, payload Payload) error {
	items, err := s.store.List()
	if err != nil {
		return err
	}
	return s.sendToItems(ctx, payload, items)
}

func (s *Service) sendToItems(ctx context.Context, payload Payload, items []Subscription) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if len(body) > maxPayloadBytes {
		payload.Body = truncateRunes(payload.Body, 80)
		body, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	activeCount := 0
	successCount := 0
	var failures []string
	for _, item := range items {
		if !item.Enabled {
			continue
		}
		activeCount++
		resp, err := webpushgo.SendNotificationWithContext(ctx, body, &webpushgo.Subscription{
			Endpoint: item.Endpoint,
			Keys: webpushgo.Keys{
				Auth:   item.Keys.Auth,
				P256dh: item.Keys.P256dh,
			},
		}, &webpushgo.Options{
			Subscriber:      s.config.Subject,
			TTL:             defaultTTLSeconds,
			Urgency:         webpushgo.UrgencyNormal,
			VAPIDPublicKey:  s.config.PublicKey,
			VAPIDPrivateKey: s.config.PrivateKey,
		})
		responseStatus := ""
		responseBody := ""
		if resp != nil {
			responseStatus = resp.Status
			if b, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024)); readErr == nil {
				responseBody = strings.TrimSpace(string(b))
			}
			resp.Body.Close()
		}
		if err != nil {
			_ = s.store.MarkError(item.ID, err.Error())
			failures = append(failures, err.Error())
			continue
		}
		if resp != nil && (resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound) {
			_ = s.store.DeleteByID(item.ID)
			failure := responseFailureMessage(responseStatus, responseBody)
			failures = append(failures, failure)
			continue
		}
		if resp != nil && resp.StatusCode >= 300 {
			failure := responseFailureMessage(responseStatus, responseBody)
			_ = s.store.MarkError(item.ID, failure)
			failures = append(failures, failure)
			continue
		}
		successCount++
	}
	if activeCount == 0 {
		return errors.New("no web push subscriptions")
	}
	if successCount == 0 && len(failures) > 0 {
		return fmt.Errorf("web push delivery failed: %s", strings.Join(failures, "; "))
	}
	return nil
}

func responseFailureMessage(status, body string) string {
	status = strings.TrimSpace(status)
	body = strings.TrimSpace(body)
	if status == "" {
		status = "web push request failed"
	}
	if body == "" {
		return status
	}
	return status + ": " + body
}

func subscriptionID(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if len(endpoint) <= 24 {
		return endpoint
	}
	return endpoint[len(endpoint)-24:]
}

func sessionURL(rootID, sessionKey string) string {
	params := make([]string, 0, 2)
	if strings.TrimSpace(rootID) != "" {
		params = append(params, "root="+urlQueryEscape(rootID))
	}
	if strings.TrimSpace(sessionKey) != "" {
		params = append(params, "session="+urlQueryEscape(sessionKey))
	}
	if len(params) == 0 {
		return "./"
	}
	return "./?" + strings.Join(params, "&")
}

func urlQueryEscape(value string) string {
	return url.QueryEscape(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateRunes(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "..."
}
