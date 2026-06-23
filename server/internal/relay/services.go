package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	configpkg "mindfs/server/internal/config"
)

const serviceSlugHeader = "X-MindFS-Relay-Service-Slug"

var serviceSlugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`)

type LocalService struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	LocalURL string `json:"local_url"`
	Enabled  bool   `json:"enabled"`
}

type ServiceStore struct {
	mu       sync.RWMutex
	filePath string
}

func NewServiceStore() (*ServiceStore, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return nil, err
	}
	return &ServiceStore{filePath: filepath.Join(configDir, "relay-services.json")}, nil
}

func (s *ServiceStore) List() ([]LocalService, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loadLocked()
}

func (s *ServiceStore) Get(slug string) (LocalService, bool, error) {
	slug = NormalizeServiceSlug(slug)
	services, err := s.List()
	if err != nil {
		return LocalService{}, false, err
	}
	for _, service := range services {
		if service.Slug == slug {
			return service, true, nil
		}
	}
	return LocalService{}, false, nil
}

func (s *ServiceStore) Save(service LocalService) error {
	normalized, err := NormalizeLocalService(service)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	services, err := s.loadLocked()
	if err != nil {
		return err
	}
	replaced := false
	for i := range services {
		if services[i].Slug == normalized.Slug {
			services[i] = normalized
			replaced = true
			break
		}
	}
	if !replaced {
		services = append(services, normalized)
	}
	return s.saveLocked(services)
}

func (s *ServiceStore) Delete(slug string) error {
	slug = NormalizeServiceSlug(slug)
	s.mu.Lock()
	defer s.mu.Unlock()
	services, err := s.loadLocked()
	if err != nil {
		return err
	}
	next := services[:0]
	for _, service := range services {
		if service.Slug != slug {
			next = append(next, service)
		}
	}
	return s.saveLocked(next)
}

func (s *ServiceStore) loadLocked() ([]LocalService, error) {
	var payload struct {
		Services []LocalService `json:"services"`
	}
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return []LocalService{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return []LocalService{}, nil
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	out := make([]LocalService, 0, len(payload.Services))
	for _, service := range payload.Services {
		normalized, err := NormalizeLocalService(service)
		if err == nil {
			out = append(out, normalized)
		}
	}
	return out, nil
}

func (s *ServiceStore) saveLocked(services []LocalService) error {
	payload, err := json.MarshalIndent(struct {
		Services []LocalService `json:"services"`
	}{Services: services}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.filePath, payload, 0o600)
}

func NormalizeServiceSlug(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func ValidServiceSlug(value string) bool {
	value = NormalizeServiceSlug(value)
	return serviceSlugPattern.MatchString(value) && !strings.Contains(value, "--")
}

func NormalizeLocalService(service LocalService) (LocalService, error) {
	service.Slug = NormalizeServiceSlug(service.Slug)
	if !ValidServiceSlug(service.Slug) {
		return LocalService{}, errors.New("invalid_service_slug")
	}
	service.Name = strings.TrimSpace(service.Name)
	if service.Name == "" {
		service.Name = service.Slug
	}
	localURL, err := normalizeLocalServiceURL(service.LocalURL)
	if err != nil {
		return LocalService{}, err
	}
	service.LocalURL = localURL
	return service, nil
}

func normalizeLocalServiceURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", errors.New("invalid_local_service_url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("invalid_local_service_url")
	}
	host := strings.Trim(strings.ToLower(u.Hostname()), "[]")
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return "", errors.New("local_service_host_not_allowed")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	u.RawQuery = ""
	u.Fragment = ""
	return strings.TrimRight(u.String(), "/"), nil
}

func (m *Manager) ListServices() ([]LocalService, error) {
	return m.service.services.List()
}

func (m *Manager) SaveService(ctx context.Context, service LocalService) (LocalService, error) {
	normalized, err := NormalizeLocalService(service)
	if err != nil {
		return LocalService{}, err
	}
	previous, hadPrevious, err := m.service.services.Get(normalized.Slug)
	if err != nil {
		return LocalService{}, err
	}
	if normalized.Enabled {
		if err := m.registerService(ctx, normalized); err != nil {
			return LocalService{}, err
		}
	} else if hadPrevious && previous.Enabled {
		if err := m.updateRemoteServiceEnabled(ctx, normalized.Slug, false); err != nil {
			return LocalService{}, err
		}
	}
	if err := m.service.services.Save(normalized); err != nil {
		return LocalService{}, err
	}
	return normalized, nil
}

func (m *Manager) DeleteService(ctx context.Context, slug string) error {
	slug = NormalizeServiceSlug(slug)
	if !ValidServiceSlug(slug) {
		return errors.New("invalid_service_slug")
	}
	if err := m.deleteRemoteService(ctx, slug); err != nil {
		return err
	}
	return m.service.services.Delete(slug)
}

func (m *Manager) registerService(ctx context.Context, service LocalService) error {
	return m.saveRemoteService(ctx, service.Slug, service.Name, true)
}

func (m *Manager) updateRemoteServiceEnabled(ctx context.Context, slug string, enabled bool) error {
	return m.saveRemoteService(ctx, slug, slug, enabled)
}

func (m *Manager) saveRemoteService(ctx context.Context, slug, name string, enabled bool) error {
	creds, err := m.service.store.Load()
	if err != nil {
		return err
	}
	if creds.Relay.DeviceToken == "" || creds.Relay.NodeID == "" {
		return errors.New("relay_not_bound")
	}
	endpoint := strings.TrimSuffix(m.resolveRelayBase(), "/") + "/api/device/nodes/" + url.PathEscape(creds.Relay.NodeID) + "/services/" + url.PathEscape(slug)
	body, err := json.Marshal(map[string]any{"name": name, "enabled": enabled})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+creds.Relay.DeviceToken)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("relay_service_register_failed_%d", resp.StatusCode)
	}
	return nil
}

func (m *Manager) deleteRemoteService(ctx context.Context, slug string) error {
	creds, err := m.service.store.Load()
	if err != nil {
		return err
	}
	if creds.Relay.DeviceToken == "" || creds.Relay.NodeID == "" {
		return errors.New("relay_not_bound")
	}
	endpoint := strings.TrimSuffix(m.resolveRelayBase(), "/") + "/api/device/nodes/" + url.PathEscape(creds.Relay.NodeID) + "/services/" + url.PathEscape(slug)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+creds.Relay.DeviceToken)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("relay_service_delete_failed_%d", resp.StatusCode)
	}
	return nil
}
