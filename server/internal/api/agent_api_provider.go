package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/apperr"
	configpkg "mindfs/server/internal/config"
	"mindfs/server/internal/preferences"

	"gopkg.in/yaml.v3"
)

const (
	apiProviderProtocolOpenAICompatible    = "openai-compatible"
	apiProviderProtocolAnthropicCompatible = "anthropic-compatible"
	apiProviderProtocolGeminiCompatible    = "gemini-compatible"
)

type agentAPIProvider struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	BaseURL        string   `json:"baseUrl"`
	APIKey         string   `json:"apiKey,omitempty"`
	Protocols      []string `json:"protocols,omitempty"`
	ModelFamilies  []string `json:"modelFamilies"`
	Models         []string `json:"models"`
	CreatedAt      string   `json:"createdAt"`
	UpdatedAt      string   `json:"updatedAt"`
	activeProtocol string
}

type agentAPIProviderPublic struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	BaseURL       string   `json:"baseUrl"`
	Protocols     []string `json:"protocols,omitempty"`
	ModelFamilies []string `json:"modelFamilies"`
	Models        []string `json:"models,omitempty"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

type agentAPIProviderCreateRequest struct {
	Name    string `json:"name"`
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

type agentAPIProviderSyncRequest struct {
	Providers []agentAPIProviderCreateRequest `json:"providers"`
}

type agentAPIProviderSwitchRequest struct {
	Agent      string `json:"agent"`
	ProviderID string `json:"provider_id"`
}

type agentAPIProviderProbeResult struct {
	Protocols     []string
	Models        []string
	ModelFamilies []string
}

func (h *HTTPHandler) handleAgentAPIProvidersList(w http.ResponseWriter, r *http.Request) {
	agentName := strings.TrimSpace(r.URL.Query().Get("agent"))
	providers, err := readAgentAPIProviders()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	out := make([]agentAPIProviderPublic, 0, len(providers))
	for _, provider := range providers {
		if agentName != "" && !apiProviderCompatibleWithAgent(provider, agentName) {
			continue
		}
		out = append(out, publicAgentAPIProvider(provider))
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleAgentAPIProviderCreate(w http.ResponseWriter, r *http.Request) {
	var req agentAPIProviderCreateRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	provider, err := createAgentAPIProvider(r.Context(), req)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errAgentConfigConflict) {
			status = http.StatusConflict
		}
		respondError(w, status, err)
		return
	}
	respondJSON(w, http.StatusOK, publicAgentAPIProvider(provider))
}

func (h *HTTPHandler) handleAgentAPIProvidersSync(w http.ResponseWriter, r *http.Request) {
	var req agentAPIProviderSyncRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	providers, err := syncAgentAPIProviders(r.Context(), req.Providers)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	out := make([]agentAPIProviderPublic, 0, len(providers))
	for _, provider := range providers {
		out = append(out, publicAgentAPIProvider(provider))
	}
	respondJSON(w, http.StatusOK, map[string]any{"providers": out})
}

func (h *HTTPHandler) handleAgentAPIProviderDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("provider id required"))
		return
	}
	providers, err := deleteAgentAPIProvider(id)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	out := make([]agentAPIProviderPublic, 0, len(providers))
	for _, provider := range providers {
		out = append(out, publicAgentAPIProvider(provider))
	}
	respondJSON(w, http.StatusOK, map[string]any{"deleted": true, "id": id, "providers": out})
}

func (h *HTTPHandler) handleAgentAPIProviderSwitch(w http.ResponseWriter, r *http.Request) {
	var req agentAPIProviderSwitchRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	provider, err := switchAgentAPIProvider(req, h.AppContext)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"provider": publicAgentAPIProvider(provider),
	})
}

func createAgentAPIProvider(ctx context.Context, req agentAPIProviderCreateRequest) (agentAPIProvider, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return agentAPIProvider{}, errors.New("provider name required")
	}
	if strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		return agentAPIProvider{}, errors.New("provider name must not contain path separators")
	}
	baseURL, err := normalizeAPIProviderBaseURL(req.BaseURL)
	if err != nil {
		return agentAPIProvider{}, err
	}
	apiKey := strings.TrimSpace(req.APIKey)
	if apiKey == "" {
		return agentAPIProvider{}, errors.New("api key required")
	}
	probe, err := probeAgentAPIProvider(ctx, baseURL, apiKey)
	if err != nil {
		return agentAPIProvider{}, err
	}
	providers, err := readAgentAPIProviders()
	if err != nil {
		return agentAPIProvider{}, err
	}
	id := "api-" + slugifyAPIProviderName(name)
	if id == "api-" {
		id = fmt.Sprintf("api-%d", time.Now().UnixNano())
	}
	for _, provider := range providers {
		if provider.ID == id {
			return agentAPIProvider{}, errAgentConfigConflict
		}
	}
	now := time.Now().Format(time.RFC3339)
	provider := agentAPIProvider{
		ID:            id,
		Name:          name,
		BaseURL:       baseURL,
		APIKey:        apiKey,
		Protocols:     probe.Protocols,
		ModelFamilies: probe.ModelFamilies,
		Models:        probe.Models,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	providers = append(providers, provider)
	if err := writeAgentAPIProviders(providers); err != nil {
		return agentAPIProvider{}, err
	}
	return provider, nil
}

func syncAgentAPIProviders(ctx context.Context, requests []agentAPIProviderCreateRequest) ([]agentAPIProvider, error) {
	if len(requests) == 0 {
		return nil, errors.New("providers required")
	}
	providers, err := readAgentAPIProviders()
	if err != nil {
		return nil, err
	}
	byName := make(map[string]int, len(providers))
	for i, provider := range providers {
		byName[strings.TrimSpace(provider.Name)] = i
	}
	now := time.Now().Format(time.RFC3339)
	changed := make([]agentAPIProvider, 0, len(requests))
	seenNames := map[string]struct{}{}
	for _, req := range requests {
		name := strings.TrimSpace(req.Name)
		if name == "" {
			return nil, errors.New("provider name required")
		}
		if strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
			return nil, errors.New("provider name must not contain path separators")
		}
		if _, ok := seenNames[name]; ok {
			continue
		}
		seenNames[name] = struct{}{}
		baseURL, err := normalizeAPIProviderBaseURL(req.BaseURL)
		if err != nil {
			return nil, err
		}
		apiKey := strings.TrimSpace(req.APIKey)
		if apiKey == "" {
			return nil, errors.New("api key required")
		}
		probe, err := probeAgentAPIProvider(ctx, baseURL, apiKey)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if index, ok := byName[name]; ok {
			provider := providers[index]
			provider.Name = name
			provider.BaseURL = baseURL
			provider.APIKey = apiKey
			provider.Protocols = probe.Protocols
			provider.ModelFamilies = probe.ModelFamilies
			provider.Models = probe.Models
			provider.UpdatedAt = now
			providers[index] = provider
			changed = append(changed, provider)
			continue
		}
		id := "api-" + slugifyAPIProviderName(name)
		if id == "api-" {
			id = fmt.Sprintf("api-%d", time.Now().UnixNano())
		}
		if providerIDExists(providers, id) {
			id = fmt.Sprintf("%s-%d", id, time.Now().UnixNano())
		}
		provider := agentAPIProvider{
			ID:            id,
			Name:          name,
			BaseURL:       baseURL,
			APIKey:        apiKey,
			Protocols:     probe.Protocols,
			ModelFamilies: probe.ModelFamilies,
			Models:        probe.Models,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		providers = append(providers, provider)
		byName[name] = len(providers) - 1
		changed = append(changed, provider)
	}
	if len(changed) == 0 {
		return nil, errors.New("no valid providers")
	}
	if err := writeAgentAPIProviders(providers); err != nil {
		return nil, err
	}
	return changed, nil
}

func providerIDExists(providers []agentAPIProvider, id string) bool {
	for _, provider := range providers {
		if provider.ID == id {
			return true
		}
	}
	return false
}

func deleteAgentAPIProvider(id string) ([]agentAPIProvider, error) {
	providers, err := readAgentAPIProviders()
	if err != nil {
		return nil, err
	}
	next := make([]agentAPIProvider, 0, len(providers))
	found := false
	for _, provider := range providers {
		if provider.ID == id {
			found = true
			continue
		}
		next = append(next, provider)
	}
	if !found {
		return nil, errors.New("provider not found")
	}
	if err := writeAgentAPIProviders(next); err != nil {
		return nil, err
	}
	return next, nil
}

func switchAgentAPIProvider(req agentAPIProviderSwitchRequest, app *AppContext) (agentAPIProvider, error) {
	agentName := strings.TrimSpace(req.Agent)
	if agentName == "" {
		return agentAPIProvider{}, errors.New("agent required")
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		return agentAPIProvider{}, err
	}
	if _, ok := cfg.GetAgent(agentName); !ok {
		return agentAPIProvider{}, fmt.Errorf("agent not configured: %s", agentName)
	}
	providerID := strings.TrimSpace(req.ProviderID)
	if providerID == "" {
		return agentAPIProvider{}, errors.New("provider id required")
	}
	providers, err := readAgentAPIProviders()
	if err != nil {
		return agentAPIProvider{}, err
	}
	var provider agentAPIProvider
	for _, item := range providers {
		if item.ID == providerID {
			provider = item
			break
		}
	}
	if provider.ID == "" {
		return agentAPIProvider{}, errors.New("provider not found")
	}
	selectedProtocol, ok := selectAPIProviderProtocolForAgent(provider, agentName)
	if !ok {
		return agentAPIProvider{}, fmt.Errorf("provider protocols %s are not compatible with agent %s", strings.Join(agentAPIProviderProtocols(provider), ", "), agentName)
	}
	provider.activeProtocol = selectedProtocol
	if err := applyAgentAPIProvider(agentName, provider, app); err != nil {
		return agentAPIProvider{}, err
	}
	if app != nil && app.GetPreferences() != nil {
		if err := app.GetPreferences().UpdateAgentLastConfigSelection(agentName, preferences.LastConfigSelection{
			Type: "api_provider",
			ID:   provider.ID,
			Name: provider.Name,
		}); err != nil {
			return agentAPIProvider{}, err
		}
	}
	if app != nil && app.GetAgentPool() != nil {
		app.GetAgentPool().KillAgentProcess(agentName, 0)
	}
	triggerAgentConfigSwitchProbe(app, agentName)
	return provider, nil
}

func applyAgentAPIProvider(agentName string, provider agentAPIProvider, app *AppContext) error {
	switch normalizedAPIProviderAgent(agentName) {
	case "codex":
		if err := applyCodexAPIProvider(provider); err != nil {
			return err
		}
	case "claude":
		env, err := replaceAgentConfiguredEnv(agentName, map[string]string{
			"ANTHROPIC_BASE_URL":   provider.BaseURL,
			"ANTHROPIC_AUTH_TOKEN": provider.APIKey,
		})
		if err != nil {
			return err
		}
		if app != nil && app.GetAgentPool() != nil {
			if err := app.GetAgentPool().SetAgentEnv(agentName, env); err != nil {
				return err
			}
		}
		if app != nil && app.GetProber() != nil {
			if err := app.GetProber().SetAgentEnv(agentName, env); err != nil {
				return err
			}
		}
	case "gemini":
		if err := applyGeminiAPIProvider(provider); err != nil {
			return err
		}
	case "copilot":
		if err := applyAgentProviderEnv(agentName, copilotAPIProviderEnv(provider), app); err != nil {
			return err
		}
	case "qwen":
		if err := applyQwenAPIProvider(provider); err != nil {
			return err
		}
	case "kimi":
		if err := applyKimiAPIProvider(provider); err != nil {
			return err
		}
	case "opencode":
		if err := applyOpenCodeAPIProvider(provider); err != nil {
			return err
		}
	case "openclaw":
		if err := applyOpenClawAPIProvider(provider); err != nil {
			return err
		}
	case "omp":
		if err := applyOMPAPIProvider(provider); err != nil {
			return err
		}
	case "pi":
		if err := applyPiAPIProvider(provider); err != nil {
			return err
		}
	case "hermes":
		if err := applyHermesAPIProvider(provider); err != nil {
			return err
		}
	default:
		if err := applyAgentProviderEnv(agentName, map[string]string{
			"OPENAI_BASE_URL": provider.BaseURL,
			"OPENAI_API_KEY":  provider.APIKey,
		}, app); err != nil {
			return err
		}
	}
	return nil
}

func applyAgentProviderEnv(agentName string, updates map[string]string, app *AppContext) error {
	env, err := mergeAgentEnvConfig(agentName, updates)
	if err != nil {
		return err
	}
	if app != nil && app.GetAgentPool() != nil {
		if err := app.GetAgentPool().SetAgentEnv(agentName, env); err != nil {
			return err
		}
	}
	if app != nil && app.GetProber() != nil {
		if err := app.GetProber().SetAgentEnv(agentName, env); err != nil {
			return err
		}
	}
	return nil
}

func copilotAPIProviderEnv(provider agentAPIProvider) map[string]string {
	env := map[string]string{
		"COPILOT_PROVIDER_BASE_URL": provider.BaseURL,
		"COPILOT_PROVIDER_API_KEY":  provider.APIKey,
		"COPILOT_MODEL":             firstModelOrDefault(provider.Models, ""),
	}
	switch agentAPIProviderActiveProtocol(provider) {
	case apiProviderProtocolAnthropicCompatible:
		env["COPILOT_PROVIDER_TYPE"] = "anthropic"
	default:
		env["COPILOT_PROVIDER_TYPE"] = "openai"
	}
	return env
}

func applyCodexAPIProvider(provider agentAPIProvider) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".codex")
	configPath := filepath.Join(dir, "config.toml")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return apperr.Wrap("mkdir", dir, err)
	}
	existing, _ := os.ReadFile(configPath)
	configText := mergeCodexAPIProviderConfig(string(existing), provider)
	return apperr.Wrap("write", configPath, os.WriteFile(configPath, []byte(configText), 0o600))
}

func mergeCodexAPIProviderConfig(existing string, provider agentAPIProvider) string {
	providerName := agentAPIProviderConfigName(provider)
	providerTable := tomlDottedTable("model_providers", providerName)
	lines := strings.Split(strings.ReplaceAll(existing, "\r\n", "\n"), "\n")
	filtered := make([]string, 0, len(lines))
	skipTable := false
	currentTable := ""
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			currentTable = trimmed
			skipTable = trimmed == providerTable
			if skipTable {
				continue
			}
		}
		if skipTable {
			continue
		}
		if strings.HasPrefix(trimmed, "model_provider") || strings.HasPrefix(trimmed, "base_url") || strings.HasPrefix(trimmed, "wire_api") || strings.HasPrefix(trimmed, "experimental_bearer_token") {
			continue
		}
		if currentTable == "[tui.model_availability_nux]" && strings.HasPrefix(trimmed, "model =") {
			continue
		}
		filtered = append(filtered, line)
	}
	model := firstModelOrDefault(provider.Models, "gpt-5")
	base := insertCodexTopLevelProviderConfig(strings.Join(filtered, "\n"), model, providerName)
	addition := fmt.Sprintf(`%s
name = %q
base_url = %q
wire_api = "responses"
experimental_bearer_token = %q
`, providerTable, provider.Name, openAIModelsBaseURL(provider.BaseURL), provider.APIKey)
	if base == "" {
		return addition
	}
	return base + "\n\n" + addition
}

func insertCodexTopLevelProviderConfig(existing, model, providerName string) string {
	lines := strings.Split(strings.TrimRight(existing, "\n"), "\n")
	insertAt := len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			insertAt = i
			break
		}
	}
	top := make([]string, 0, insertAt+2)
	for _, line := range lines[:insertAt] {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "model =") || strings.HasPrefix(trimmed, "model_provider =") {
			continue
		}
		top = append(top, line)
	}
	top = append(top, fmt.Sprintf("model = %q", model), fmt.Sprintf("model_provider = %q", providerName))
	out := append([]string{}, top...)
	if insertAt < len(lines) {
		if len(out) > 0 && strings.TrimSpace(out[len(out)-1]) != "" {
			out = append(out, "")
		}
		out = append(out, lines[insertAt:]...)
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

func applyGeminiAPIProvider(provider agentAPIProvider) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".gemini")
	envPath := filepath.Join(dir, ".env")
	settingsPath := filepath.Join(dir, "settings.json")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return apperr.Wrap("mkdir", dir, err)
	}
	env := map[string]string{}
	if payload, err := os.ReadFile(envPath); err == nil {
		env = parseSimpleEnv(string(payload))
	}
	env["GEMINI_API_KEY"] = provider.APIKey
	env["GOOGLE_GEMINI_BASE_URL"] = provider.BaseURL
	if len(provider.Models) > 0 {
		env["GEMINI_MODEL"] = provider.Models[0]
	}
	if err := os.WriteFile(envPath, []byte(formatSimpleEnv(env)), 0o600); err != nil {
		return apperr.Wrap("write", envPath, err)
	}
	settings := map[string]any{}
	if payload, err := os.ReadFile(settingsPath); err == nil && len(strings.TrimSpace(string(payload))) > 0 {
		_ = json.Unmarshal(payload, &settings)
	}
	security, _ := settings["security"].(map[string]any)
	if security == nil {
		security = map[string]any{}
	}
	auth, _ := security["auth"].(map[string]any)
	if auth == nil {
		auth = map[string]any{}
	}
	auth["selectedType"] = "gemini-api-key"
	security["auth"] = auth
	settings["security"] = security
	payload, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return apperr.Wrap("write", settingsPath, os.WriteFile(settingsPath, append(payload, '\n'), 0o600))
}

func applyQwenAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".qwen", "settings.json")
	if err != nil {
		return err
	}
	settings, err := readJSONObject(path)
	if err != nil {
		return err
	}
	envKey := "OPENAI_API_KEY"
	providerKey := "openai"
	protocol := "openai"
	baseURL := openAIModelsBaseURL(provider.BaseURL)
	if agentAPIProviderActiveProtocol(provider) == apiProviderProtocolAnthropicCompatible {
		envKey = "ANTHROPIC_API_KEY"
		providerKey = "anthropic"
		protocol = "anthropic"
		baseURL = anthropicBaseURL(provider.BaseURL)
	}
	env := ensureJSONObject(settings, "env")
	env[envKey] = provider.APIKey
	modelProviders := ensureJSONObject(settings, "modelProviders")
	modelProviders[providerKey] = map[string]any{
		"protocol": protocol,
		"models":   qwenModelEntries(provider, envKey, baseURL),
	}
	model := ensureJSONObject(settings, "model")
	model["name"] = firstModelOrDefault(provider.Models, "")
	return writeJSONObject(path, settings, 0o600)
}

func applyKimiAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".kimi", "config.toml")
	if err != nil {
		return err
	}
	existing, _ := os.ReadFile(path)
	providerName := agentAPIProviderConfigName(provider)
	model := firstModelOrDefault(provider.Models, "")
	providerType := "openai_legacy"
	baseURL := openAIModelsBaseURL(provider.BaseURL)
	if agentAPIProviderActiveProtocol(provider) == apiProviderProtocolAnthropicCompatible {
		providerType = "anthropic"
		baseURL = anthropicBaseURL(provider.BaseURL)
	}
	block := fmt.Sprintf(`# BEGIN MINDFS API PROVIDER
default_model = %q

%s
type = %q
base_url = %q
api_key = %q

%s
provider = %q
model = %q
# END MINDFS API PROVIDER
`, providerName, tomlDottedTable("providers", providerName), providerType, baseURL, provider.APIKey, tomlDottedTable("models", providerName), providerName, model)
	return writeTextFile(path, replaceManagedBlock(string(existing), block, "# BEGIN MINDFS API PROVIDER", "# END MINDFS API PROVIDER"), 0o600)
}

func applyOpenCodeAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".config", "opencode", "opencode.json")
	if err != nil {
		return err
	}
	cfg, err := readJSONObject(path)
	if err != nil {
		return err
	}
	npm := "@ai-sdk/openai-compatible"
	baseURL := openAIModelsBaseURL(provider.BaseURL)
	if agentAPIProviderActiveProtocol(provider) == apiProviderProtocolAnthropicCompatible {
		npm = "@ai-sdk/anthropic"
		baseURL = anthropicBaseURL(provider.BaseURL)
	}
	providerName := agentAPIProviderConfigName(provider)
	providers := ensureJSONObject(cfg, "provider")
	providers[providerName] = map[string]any{
		"npm":  npm,
		"name": provider.Name,
		"options": map[string]any{
			"baseURL": baseURL,
			"apiKey":  provider.APIKey,
		},
		"models": modelObject(provider.Models),
	}
	if model := firstModelOrDefault(provider.Models, ""); model != "" {
		cfg["model"] = providerName + "/" + model
	}
	return writeJSONObject(path, cfg, 0o600)
}

func applyOpenClawAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".openclaw", "openclaw.json")
	if err != nil {
		return err
	}
	cfg, err := readJSONObject(path)
	if err != nil {
		return err
	}
	activeProtocol := agentAPIProviderActiveProtocol(provider)
	apiMode := additiveAgentAPI(activeProtocol)
	baseURL := provider.BaseURL
	if activeProtocol == apiProviderProtocolAnthropicCompatible {
		baseURL = anthropicBaseURL(provider.BaseURL)
	}
	models := ensureJSONObject(cfg, "models")
	if _, ok := models["mode"]; !ok {
		models["mode"] = "merge"
	}
	providerName := agentAPIProviderConfigName(provider)
	providers := ensureJSONObject(models, "providers")
	providers[providerName] = map[string]any{
		"baseUrl": baseURL,
		"apiKey":  provider.APIKey,
		"api":     apiMode,
		"models":  modelArray(provider.Models),
	}
	agents := ensureJSONObject(cfg, "agents")
	defaults := ensureJSONObject(agents, "defaults")
	if model := firstModelOrDefault(provider.Models, ""); model != "" {
		defaults["model"] = map[string]any{
			"primary":   providerName + "/" + model,
			"fallbacks": []any{},
		}
		catalog := ensureJSONObject(defaults, "models")
		for _, item := range provider.Models {
			item = strings.TrimSpace(item)
			if item == "" {
				continue
			}
			key := providerName + "/" + item
			if _, exists := catalog[key]; !exists {
				catalog[key] = map[string]any{"alias": item}
			}
		}
	}
	return writeJSONObject(path, cfg, 0o600)
}

func applyOMPAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".omp", "agent", "models.yml")
	if err != nil {
		return err
	}
	cfg, err := readYAMLMap(path)
	if err != nil {
		return err
	}
	activeProtocol := agentAPIProviderActiveProtocol(provider)
	baseURL := provider.BaseURL
	if activeProtocol == apiProviderProtocolAnthropicCompatible {
		baseURL = anthropicBaseURL(provider.BaseURL)
	}
	providerName := agentAPIProviderConfigName(provider)
	providers := ensureYAMLMap(cfg, "providers")
	providers[providerName] = map[string]any{
		"baseUrl":    baseURL,
		"apiKey":     provider.APIKey,
		"api":        additiveAgentAPI(activeProtocol),
		"authHeader": activeProtocol == apiProviderProtocolOpenAICompatible,
		"models":     modelArray(provider.Models),
	}
	if model := firstModelOrDefault(provider.Models, ""); model != "" {
		roles := ensureYAMLMap(cfg, "modelRoles")
		roles["main"] = providerName + "/" + model
	}
	return writeYAMLMap(path, cfg, 0o600)
}

func applyPiAPIProvider(provider agentAPIProvider) error {
	modelsPath, err := homePath(".pi", "agent", "models.json")
	if err != nil {
		return err
	}
	cfg, err := readJSONObject(modelsPath)
	if err != nil {
		return err
	}
	providerName := agentAPIProviderConfigName(provider)
	apiMode := piAgentAPI(agentAPIProviderActiveProtocol(provider))
	baseURL := piAgentBaseURL(provider)
	providers := ensureJSONObject(cfg, "providers")
	providers[providerName] = map[string]any{
		"baseUrl": baseURL,
		"apiKey":  provider.APIKey,
		"api":     apiMode,
		"models":  modelArray(provider.Models),
	}
	if err := writeJSONObject(modelsPath, cfg, 0o600); err != nil {
		return err
	}
	if model := firstModelOrDefault(provider.Models, ""); model != "" {
		settingsPath, err := homePath(".pi", "agent", "settings.json")
		if err != nil {
			return err
		}
		settings, err := readJSONObject(settingsPath)
		if err != nil {
			return err
		}
		settings["defaultProvider"] = providerName
		settings["defaultModel"] = model
		if err := writeJSONObject(settingsPath, settings, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func applyHermesAPIProvider(provider agentAPIProvider) error {
	path, err := homePath(".hermes", "config.yaml")
	if err != nil {
		return err
	}
	cfg, err := readYAMLMap(path)
	if err != nil {
		return err
	}
	providerName := agentAPIProviderConfigName(provider)
	model := firstModelOrDefault(provider.Models, "")
	entry := map[string]any{
		"name":     providerName,
		"base_url": provider.BaseURL,
		"api_key":  provider.APIKey,
		"api_mode": "chat_completions",
	}
	if model != "" {
		entry["model"] = model
	}
	modelCfg := ensureYAMLMap(cfg, "model")
	modelCfg["api_key"] = provider.APIKey
	modelCfg["api_mode"] = "chat_completions"
	modelCfg["base_url"] = provider.BaseURL
	modelCfg["provider"] = "custom"
	if model != "" {
		modelCfg["default"] = model
	}
	cfg["custom_providers"] = replaceNamedYAMLSequenceEntry(cfg["custom_providers"], providerName, entry)
	return writeYAMLMap(path, cfg, 0o600)
}

func mergeAgentEnvConfig(agentName string, updates map[string]string) (map[string]string, error) {
	return writeAgentEnvConfig(agentName, updates, false)
}

func replaceAgentConfiguredEnv(agentName string, updates map[string]string) (map[string]string, error) {
	return writeAgentEnvConfig(agentName, updates, true)
}

func writeAgentEnvConfig(agentName string, updates map[string]string, clearConfigured bool) (map[string]string, error) {
	path, err := agent.ResolveConfigPath()
	if err != nil {
		return nil, err
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		return nil, err
	}
	found := false
	var merged map[string]string
	for i := range cfg.Agents {
		if cfg.Agents[i].Name != agentName {
			continue
		}
		found = true
		merged = cloneStringMap(cfg.Agents[i].Env)
		if merged == nil {
			merged = map[string]string{}
		}
		if clearConfigured {
			for _, key := range cfg.Agents[i].ConfigBackup.EnvKeys {
				delete(merged, key)
			}
		}
		for key, value := range updates {
			if strings.TrimSpace(value) == "" {
				delete(merged, key)
				continue
			}
			merged[key] = value
		}
		cfg.Agents[i].Env = cloneStringMap(merged)
		break
	}
	if !found {
		return nil, fmt.Errorf("agent not configured: %s", agentName)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, apperr.Wrap("mkdir", filepath.Dir(path), err)
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}
	payload = append(payload, '\n')
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		return nil, apperr.Wrap("write", path, err)
	}
	return merged, nil
}

func probeAgentAPIProvider(ctx context.Context, baseURL, apiKey string) (agentAPIProviderProbeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	attempts := []struct {
		protocol string
		fn       func(context.Context, string, string) ([]string, error)
	}{
		{apiProviderProtocolOpenAICompatible, probeOpenAICompatibleModels},
		{apiProviderProtocolAnthropicCompatible, probeAnthropicCompatibleModels},
		{apiProviderProtocolGeminiCompatible, probeGeminiCompatibleModels},
	}
	type probeAttemptResult struct {
		protocol string
		models   []string
		err      error
	}
	results := make(chan probeAttemptResult, len(attempts))
	for _, attempt := range attempts {
		attempt := attempt
		go func() {
			models, err := attempt.fn(ctx, baseURL, apiKey)
			results <- probeAttemptResult{protocol: attempt.protocol, models: models, err: err}
		}()
	}
	var failures []string
	modelsByProtocol := map[string][]string{}
	for range attempts {
		result := <-results
		if result.err != nil {
			failures = append(failures, result.protocol+": "+result.err.Error())
			continue
		}
		if len(result.models) == 0 {
			failures = append(failures, result.protocol+": no models returned")
			continue
		}
		modelsByProtocol[result.protocol] = result.models
	}
	protocols := successfulProbeProtocols(modelsByProtocol)
	if len(protocols) > 0 {
		models := mergeProtocolModels(modelsByProtocol, protocols)
		families := inferModelFamilies(models)
		return agentAPIProviderProbeResult{
			Protocols:     protocols,
			Models:        models,
			ModelFamilies: families,
		}, nil
	}
	return agentAPIProviderProbeResult{}, fmt.Errorf("unable to identify API protocol: %s", strings.Join(failures, "; "))
}

func probeOpenAICompatibleModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openAIModelsURL(baseURL), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := doModelProbe(req, &payload); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if id := strings.TrimSpace(item.ID); id != "" {
			models = append(models, id)
		}
	}
	return normalizeModelIDs(models), nil
}

func probeAnthropicCompatibleModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, openAIModelsURL(baseURL), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	var payload struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := doModelProbe(req, &payload); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if id := strings.TrimSpace(item.ID); id != "" {
			models = append(models, id)
		}
	}
	return normalizeModelIDs(models), nil
}

func probeGeminiCompatibleModels(ctx context.Context, baseURL, apiKey string) ([]string, error) {
	endpoint, err := url.Parse(geminiModelsURL(baseURL))
	if err != nil {
		return nil, err
	}
	q := endpoint.Query()
	q.Set("key", apiKey)
	endpoint.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Models []struct {
			Name        string `json:"name"`
			DisplayName string `json:"displayName"`
		} `json:"models"`
	}
	if err := doModelProbe(req, &payload); err != nil {
		return nil, err
	}
	models := make([]string, 0, len(payload.Models))
	for _, item := range payload.Models {
		name := strings.TrimSpace(item.Name)
		name = strings.TrimPrefix(name, "models/")
		if name != "" {
			models = append(models, name)
		}
	}
	return normalizeModelIDs(models), nil
}

func doModelProbe(req *http.Request, target any) error {
	client := &http.Client{Timeout: 12 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("status %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(target); err != nil {
		return err
	}
	return nil
}

func readAgentAPIProviders() ([]agentAPIProvider, error) {
	path, err := agentAPIProvidersPath()
	if err != nil {
		return nil, err
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []agentAPIProvider{}, nil
		}
		return nil, apperr.Wrap("read", path, err)
	}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return []agentAPIProvider{}, nil
	}
	var providers []agentAPIProvider
	if err := json.Unmarshal(payload, &providers); err != nil {
		return nil, err
	}
	for i := range providers {
		providers[i].Protocols = agentAPIProviderProtocols(providers[i])
	}
	return providers, nil
}

func writeAgentAPIProviders(providers []agentAPIProvider) error {
	path, err := agentAPIProvidersPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return apperr.Wrap("mkdir", filepath.Dir(path), err)
	}
	payload, err := json.MarshalIndent(providers, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return apperr.Wrap("write", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(path)
		if retryErr := os.Rename(tmp, path); retryErr != nil {
			return apperr.Wrap("rename", path, err)
		}
	}
	return nil
}

func agentAPIProvidersPath() (string, error) {
	configDir, err := configpkg.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "api-providers.json"), nil
}

func publicAgentAPIProvider(provider agentAPIProvider) agentAPIProviderPublic {
	return agentAPIProviderPublic{
		ID:            provider.ID,
		Name:          provider.Name,
		BaseURL:       provider.BaseURL,
		Protocols:     agentAPIProviderProtocols(provider),
		ModelFamilies: append([]string(nil), provider.ModelFamilies...),
		Models:        append([]string(nil), provider.Models...),
		CreatedAt:     provider.CreatedAt,
		UpdatedAt:     provider.UpdatedAt,
	}
}

func normalizeAPIProviderBaseURL(input string) (string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(input), "/")
	if baseURL == "" {
		return "", errors.New("baseUrl required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("baseUrl must be an absolute URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("baseUrl scheme must be http or https")
	}
	return baseURL, nil
}

func openAIModelsURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/v1") {
		return base + "/models"
	}
	return base + "/v1/models"
}

func openAIModelsBaseURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/v1") {
		return base
	}
	return base + "/v1"
}

func geminiModelsURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/v1beta") {
		return base + "/models"
	}
	return base + "/v1beta/models"
}

func apiProviderCompatibleWithAgent(provider agentAPIProvider, agentName string) bool {
	_, ok := selectAPIProviderProtocolForAgent(provider, agentName)
	return ok
}

func selectAPIProviderProtocolForAgent(provider agentAPIProvider, agentName string) (string, bool) {
	providerProtocols := agentAPIProviderProtocols(provider)
	for _, supported := range agentSupportedAPIProtocols(agentName) {
		for _, protocol := range providerProtocols {
			if protocol == supported {
				return protocol, true
			}
		}
	}
	return "", false
}

func agentAPIProviderProtocols(provider agentAPIProvider) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(provider.Protocols))
	for _, protocol := range provider.Protocols {
		protocol = strings.TrimSpace(protocol)
		if protocol == "" || seen[protocol] {
			continue
		}
		seen[protocol] = true
		out = append(out, protocol)
	}
	return out
}

func agentAPIProviderActiveProtocol(provider agentAPIProvider) string {
	if protocol := strings.TrimSpace(provider.activeProtocol); protocol != "" {
		return protocol
	}
	protocols := agentAPIProviderProtocols(provider)
	if len(protocols) == 0 {
		return ""
	}
	return protocols[0]
}

func applyAgentAPIProviderCapabilities(statuses []agent.Status) []agent.Status {
	out := make([]agent.Status, len(statuses))
	for i, status := range statuses {
		protocols := agentSupportedAPIProtocols(status.Name)
		status.SupportedAPIProviderProtocols = append([]string(nil), protocols...)
		status.SupportsAPIProviderSwitch = len(protocols) > 0
		out[i] = status
	}
	return out
}

func agentSupportedAPIProtocols(agentName string) []string {
	switch normalizedAPIProviderAgent(agentName) {
	case "codex":
		return []string{apiProviderProtocolOpenAICompatible}
	case "claude":
		return []string{apiProviderProtocolAnthropicCompatible}
	case "gemini":
		return []string{apiProviderProtocolGeminiCompatible}
	case "copilot", "qwen", "kimi", "opencode", "openclaw", "omp":
		return []string{apiProviderProtocolOpenAICompatible, apiProviderProtocolAnthropicCompatible}
	case "pi":
		return []string{apiProviderProtocolOpenAICompatible, apiProviderProtocolAnthropicCompatible, apiProviderProtocolGeminiCompatible}
	case "hermes":
		return []string{apiProviderProtocolOpenAICompatible}
	default:
		return nil
	}
}

func successfulProbeProtocols(modelsByProtocol map[string][]string) []string {
	priority := []string{
		apiProviderProtocolOpenAICompatible,
		apiProviderProtocolAnthropicCompatible,
		apiProviderProtocolGeminiCompatible,
	}
	out := make([]string, 0, len(priority))
	for _, protocol := range priority {
		if len(modelsByProtocol[protocol]) > 0 {
			out = append(out, protocol)
		}
	}
	return out
}

func mergeProtocolModels(modelsByProtocol map[string][]string, protocols []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, protocol := range protocols {
		for _, model := range modelsByProtocol[protocol] {
			model = strings.TrimSpace(model)
			if model == "" || seen[model] {
				continue
			}
			seen[model] = true
			out = append(out, model)
		}
	}
	return out
}

func agentAPIProviderConfigName(provider agentAPIProvider) string {
	name := strings.TrimSpace(provider.Name)
	if name == "" {
		name = strings.TrimSpace(provider.ID)
	}
	if name == "" {
		return "api-provider"
	}
	return name
}

func tomlDottedTable(parent, key string) string {
	return "[" + parent + "." + tomlKey(key) + "]"
}

func tomlKey(key string) string {
	if isTOMLBareKey(key) {
		return key
	}
	return strconv.Quote(key)
}

func isTOMLBareKey(key string) bool {
	if key == "" {
		return false
	}
	for _, r := range key {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_' || r == '-':
			continue
		default:
			return false
		}
	}
	return true
}

func normalizedAPIProviderAgent(agentName string) string {
	name := strings.ToLower(strings.TrimSpace(agentName))
	switch name {
	case "claude", "claudecode", "claude-code":
		return "claude"
	case "github-copilot", "copilot-cli":
		return "copilot"
	case "pi", "pi-acp", "pi-coding-agent":
		return "pi"
	case "qwen-code", "qwencode":
		return "qwen"
	case "kimi-code":
		return "kimi"
	default:
		return name
	}
}

func slugifyAPIProviderName(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == '.' || r == '_' || r == '-' || r == ' ':
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

func normalizeModelIDs(input []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(input))
	for _, item := range input {
		id := strings.TrimSpace(item)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func inferModelFamilies(models []string) []string {
	seen := map[string]bool{}
	var families []string
	add := func(name string) {
		if !seen[name] {
			seen[name] = true
			families = append(families, name)
		}
	}
	for _, model := range models {
		lower := strings.ToLower(model)
		switch {
		case strings.Contains(lower, "deepseek"):
			add("deepseek")
		case strings.Contains(lower, "claude"):
			add("anthropic")
		case strings.Contains(lower, "gemini"):
			add("gemini")
		case strings.Contains(lower, "qwen"):
			add("qwen")
		case strings.Contains(lower, "glm") || strings.Contains(lower, "zhipu") || strings.Contains(lower, "bigmodel"):
			add("glm")
		case strings.Contains(lower, "kimi") || strings.Contains(lower, "moonshot"):
			add("kimi")
		case strings.Contains(lower, "doubao") || strings.Contains(lower, "seed"):
			add("doubao")
		case strings.HasPrefix(lower, "gpt-") || strings.HasPrefix(lower, "o1") || strings.HasPrefix(lower, "o3") || strings.HasPrefix(lower, "o4"):
			add("openai")
		}
	}
	if len(families) == 0 {
		families = append(families, "unknown")
	}
	sort.Strings(families)
	return families
}

func firstModelOrDefault(models []string, fallback string) string {
	for _, model := range models {
		if trimmed := strings.TrimSpace(model); trimmed != "" {
			return trimmed
		}
	}
	return fallback
}

func homePath(parts ...string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{home}, parts...)...), nil
}

func writeTextFile(path, text string, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return apperr.Wrap("mkdir", filepath.Dir(path), err)
	}
	return apperr.Wrap("write", path, os.WriteFile(path, []byte(text), perm))
}

func readJSONObject(path string) (map[string]any, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, apperr.Wrap("read", path, err)
	}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		normalized := normalizeJSONLikeConfig(string(payload))
		if normalized == string(payload) {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
		if fallbackErr := json.Unmarshal([]byte(normalized), &out); fallbackErr != nil {
			return nil, fmt.Errorf("parse %s: %w", path, err)
		}
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func writeJSONObject(path string, value map[string]any, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return apperr.Wrap("mkdir", filepath.Dir(path), err)
	}
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return apperr.Wrap("write", path, os.WriteFile(path, append(payload, '\n'), perm))
}

func normalizeJSONLikeConfig(input string) string {
	text := stripJSONLikeComments(input)
	text = replaceSingleQuotedStrings(text)
	text = quoteJSONLikeKeys(text)
	text = removeJSONTrailingCommas(text)
	return text
}

func stripJSONLikeComments(input string) string {
	var b strings.Builder
	inString := false
	quote := rune(0)
	escaped := false
	for i := 0; i < len(input); i++ {
		ch := rune(input[i])
		if inString {
			b.WriteByte(input[i])
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == quote {
				inString = false
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			inString = true
			quote = ch
			b.WriteByte(input[i])
			continue
		}
		if ch == '/' && i+1 < len(input) && input[i+1] == '/' {
			for i < len(input) && input[i] != '\n' {
				i++
			}
			if i < len(input) {
				b.WriteByte(input[i])
			}
			continue
		}
		if ch == '/' && i+1 < len(input) && input[i+1] == '*' {
			i += 2
			for i+1 < len(input) && !(input[i] == '*' && input[i+1] == '/') {
				i++
			}
			i++
			continue
		}
		b.WriteByte(input[i])
	}
	return b.String()
}

func replaceSingleQuotedStrings(input string) string {
	var b strings.Builder
	inSingle := false
	inDouble := false
	escaped := false
	for i := 0; i < len(input); i++ {
		ch := input[i]
		if inDouble {
			b.WriteByte(ch)
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
				continue
			}
			if ch == '"' {
				inDouble = false
			}
			continue
		}
		if !inSingle {
			if ch == '"' {
				inDouble = true
				b.WriteByte(ch)
				continue
			}
			if ch == '\'' {
				inSingle = true
				b.WriteByte('"')
				continue
			}
			b.WriteByte(ch)
			continue
		}
		if escaped {
			if ch == '\'' {
				b.WriteByte('\'')
			} else {
				b.WriteByte('\\')
				b.WriteByte(ch)
			}
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if ch == '"' {
			b.WriteString(`\"`)
			continue
		}
		if ch == '\'' {
			inSingle = false
			b.WriteByte('"')
			continue
		}
		b.WriteByte(ch)
	}
	return b.String()
}

func quoteJSONLikeKeys(input string) string {
	re := regexp.MustCompile(`([,{]\s*)([A-Za-z_$][A-Za-z0-9_$-]*)(\s*:)`)
	prev := ""
	out := input
	for out != prev {
		prev = out
		out = re.ReplaceAllString(out, `$1"$2"$3`)
	}
	return out
}

func removeJSONTrailingCommas(input string) string {
	re := regexp.MustCompile(`,\s*([}\]])`)
	prev := ""
	out := input
	for out != prev {
		prev = out
		out = re.ReplaceAllString(out, `$1`)
	}
	return out
}

func ensureJSONObject(parent map[string]any, key string) map[string]any {
	if child, ok := parent[key].(map[string]any); ok {
		return child
	}
	child := map[string]any{}
	parent[key] = child
	return child
}

func readYAMLMap(path string) (map[string]any, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, apperr.Wrap("read", path, err)
	}
	if len(strings.TrimSpace(string(payload))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := yaml.Unmarshal(payload, &out); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func writeYAMLMap(path string, value map[string]any, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return apperr.Wrap("mkdir", filepath.Dir(path), err)
	}
	payload, err := yaml.Marshal(value)
	if err != nil {
		return err
	}
	return apperr.Wrap("write", path, os.WriteFile(path, payload, perm))
}

func ensureYAMLMap(parent map[string]any, key string) map[string]any {
	return ensureJSONObject(parent, key)
}

func qwenModelEntries(provider agentAPIProvider, envKey, baseURL string) []map[string]any {
	out := make([]map[string]any, 0, len(provider.Models))
	for _, model := range provider.Models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		out = append(out, map[string]any{
			"id":      model,
			"name":    model,
			"envKey":  envKey,
			"baseUrl": baseURL,
		})
	}
	return out
}

func modelObject(models []string) map[string]any {
	out := map[string]any{}
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		out[model] = map[string]any{"name": model}
	}
	return out
}

func modelArray(models []string) []map[string]any {
	out := make([]map[string]any, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		out = append(out, map[string]any{"id": model, "name": model})
	}
	return out
}

func additiveAgentAPI(protocol string) string {
	if protocol == apiProviderProtocolAnthropicCompatible {
		return "anthropic-messages"
	}
	return "openai-completions"
}

func piAgentAPI(protocol string) string {
	switch protocol {
	case apiProviderProtocolAnthropicCompatible:
		return "anthropic-messages"
	case apiProviderProtocolGeminiCompatible:
		return "google-generative-ai"
	default:
		return "openai-completions"
	}
}

func piAgentBaseURL(provider agentAPIProvider) string {
	switch agentAPIProviderActiveProtocol(provider) {
	case apiProviderProtocolAnthropicCompatible:
		return anthropicBaseURL(provider.BaseURL)
	case apiProviderProtocolGeminiCompatible:
		return geminiModelsBaseURL(provider.BaseURL)
	default:
		return openAIModelsBaseURL(provider.BaseURL)
	}
}

func anthropicBaseURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	return strings.TrimSuffix(base, "/v1")
}

func geminiModelsBaseURL(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(base, "/v1beta") {
		return base
	}
	return base + "/v1beta"
}

func replaceManagedBlock(existing, block, startMarker, endMarker string) string {
	text := strings.TrimRight(strings.ReplaceAll(existing, "\r\n", "\n"), "\n")
	start := strings.Index(text, startMarker)
	if start >= 0 {
		end := strings.Index(text[start:], endMarker)
		if end >= 0 {
			end += start + len(endMarker)
			text = strings.TrimRight(text[:start], "\n") + "\n\n" + strings.TrimLeft(text[end:], "\n")
		}
	}
	block = strings.TrimRight(block, "\n")
	if strings.TrimSpace(text) == "" {
		return block + "\n"
	}
	return strings.TrimRight(text, "\n") + "\n\n" + block + "\n"
}

func upsertNamedYAMLSequence(existing any, name string, entry map[string]any) []any {
	var out []any
	if seq, ok := existing.([]any); ok {
		out = append(out, seq...)
	}
	for i, item := range out {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if objName, _ := obj["name"].(string); objName == name {
			merged := map[string]any{}
			for key, value := range obj {
				merged[key] = value
			}
			for key, value := range entry {
				merged[key] = value
			}
			out[i] = merged
			return out
		}
	}
	return append(out, entry)
}

func replaceNamedYAMLSequenceEntry(existing any, name string, entry map[string]any) []any {
	var out []any
	if seq, ok := existing.([]any); ok {
		out = append(out, seq...)
	}
	for i, item := range out {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if objName, _ := obj["name"].(string); objName == name {
			out[i] = entry
			return out
		}
	}
	return append(out, entry)
}

func parseSimpleEnv(input string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(input, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		out[key] = strings.Trim(strings.TrimSpace(value), `"'`)
	}
	return out
}

func formatSimpleEnv(env map[string]string) string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, key := range keys {
		value := strings.TrimSpace(env[key])
		if value == "" {
			continue
		}
		b.WriteString(key)
		b.WriteByte('=')
		b.WriteString(value)
		b.WriteByte('\n')
	}
	return b.String()
}
