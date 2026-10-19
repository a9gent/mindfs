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
	"sync"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/apperr"

	"github.com/go-chi/chi/v5"
)

type agentMetadataPatchRequest struct {
	Label *string `json:"label"`
	URL   *string `json:"url"`
}

// agentConfigMu serializes whole-file read-modify-write cycles on agents.json
// (this PATCH vs the provider env writers in writeAgentEnvConfig). Both load
// the full file, mutate one aspect and write the whole snapshot back; run
// concurrently the later write silently drops the earlier one's change.
var agentConfigMu sync.Mutex

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
	agentConfigMu.Lock()
	defer agentConfigMu.Unlock()
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
		// hosted extra 层的 agent 不在 agents.json 里：整文件快照写不进去，
		// 也不能凭空物化一个只有 {name,label} 的残缺条目（会丢继承的
		// command/args/env），所以必须明确拒绝而不是默默 404。
		if prober := h.AppContext.GetProber(); prober != nil {
			if _, ok := prober.DefinitionForAgent(name); ok {
				respondError(w, http.StatusNotFound, errInvalidRequest(fmt.Sprintf("agent %s is managed by the hosted config layer and cannot be edited here", name)))
				return
			}
		}
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
	// Prober 可能未装配（单测/独立进程），GetStatus 也要走同一个 nil 闸。
	var status agent.Status
	if prober := h.AppContext.GetProber(); prober != nil {
		prober.SetAgentMetadata(name, cfg.Agents[index].Label, cfg.Agents[index].URL)
		if cached, ok := prober.GetStatus(name); ok {
			status = cached
		}
	}
	if status.Name == "" {
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
