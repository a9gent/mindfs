package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/apperr"

	"github.com/go-chi/chi/v5"
)

type agentMetadataPatchRequest struct {
	Label *string `json:"label"`
	URL   *string `json:"url"`
}

// handleAgentMetadataPatch stores an agent's display label and external URL.
// Only these two keys are accepted. The whole merged definition is written
// back to the user agents.json (same materialization writeAgentEnvConfig
// uses) — writing a thin {name,label} entry would wipe the inherited
// command/args/env of agents that only exist in the built-in layer.
func (h *HTTPHandler) handleAgentMetadataPatch(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(chi.URLParam(r, "name"))
	if name == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("agent name required"))
		return
	}
	var req agentMetadataPatchRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	if req.Label == nil && req.URL == nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("nothing to update"))
		return
	}
	label, urlValue := "", ""
	if req.Label != nil {
		label = strings.TrimSpace(*req.Label)
		if len(label) > 120 {
			respondError(w, http.StatusBadRequest, errInvalidRequest("label too long (max 120 chars)"))
			return
		}
	}
	if req.URL != nil {
		urlValue = strings.TrimSpace(*req.URL)
		if urlValue != "" {
			parsed, err := url.Parse(urlValue)
			if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" {
				respondError(w, http.StatusBadRequest, errInvalidRequest("url must be an absolute http(s) URL"))
				return
			}
		}
	}
	path, err := agent.ResolveConfigPath()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	cfg, err := agent.LoadConfig("")
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	index := -1
	for i := range cfg.Agents {
		if cfg.Agents[i].Name == name {
			index = i
			break
		}
	}
	if index < 0 {
		respondError(w, http.StatusNotFound, errInvalidRequest(fmt.Sprintf("agent not configured: %s", name)))
		return
	}
	if req.Label != nil {
		cfg.Agents[index].Label = label
	}
	if req.URL != nil {
		cfg.Agents[index].URL = urlValue
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		respondError(w, http.StatusServiceUnavailable, apperr.Wrap("mkdir", filepath.Dir(path), err))
		return
	}
	payload, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		respondError(w, http.StatusInternalServerError, err)
		return
	}
	if err := os.WriteFile(path, append(payload, '\n'), 0o644); err != nil {
		respondError(w, http.StatusServiceUnavailable, apperr.Wrap("write", path, err))
		return
	}
	// Prober 缓存立即生效：读时覆盖 + 推送监听者，无需重启或等下一轮探测。
	if prober := h.AppContext.GetProber(); prober != nil {
		prober.SetAgentMetadata(name, cfg.Agents[index].Label, cfg.Agents[index].URL)
	}
	status, ok := h.AppContext.GetProber().GetStatus(name)
	if !ok {
		status = agent.Status{Name: name, Label: cfg.Agents[index].Label, URL: cfg.Agents[index].URL}
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"agent": status,
	})
}

type agentVisibilityRequest struct {
	Hidden     []string `json:"hidden"`
	Customized bool     `json:"customized"`
}

func (h *HTTPHandler) handleAgentVisibilityGet(w http.ResponseWriter, _ *http.Request) {
	prefs := h.AppContext.GetPreferences()
	if prefs == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("preferences not configured"))
		return
	}
	hidden, customized := prefs.AgentVisibility()
	respondJSON(w, http.StatusOK, map[string]any{
		"hidden":     hidden,
		"customized": customized,
	})
}

func (h *HTTPHandler) handleAgentVisibilityPut(w http.ResponseWriter, r *http.Request) {
	prefs := h.AppContext.GetPreferences()
	if prefs == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("preferences not configured"))
		return
	}
	var req agentVisibilityRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid request body"))
		return
	}
	if err := prefs.UpdateAgentVisibility(req.Hidden, req.Customized); err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	hidden, customized := prefs.AgentVisibility()
	respondJSON(w, http.StatusOK, map[string]any{
		"hidden":     hidden,
		"customized": customized,
	})
}
