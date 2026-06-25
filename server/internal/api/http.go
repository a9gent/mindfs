package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	htmpl "html/template"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"os"
	stdpath "path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/commandexec"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/gitview"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/session"

	"github.com/go-chi/chi/v5"
)

// HTTPHandler provides REST endpoints for health, tree, file, and action.
type HTTPHandler struct {
	AppContext    *AppContext
	StaticDir     string
	Version       string
	LocalCLIToken string
}

type protectedResponseWriter struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

const (
	maxUploadRequestBytes = 64 << 20
	maxUploadFileCount    = 20
	sessionListPageSize   = 50
	multiRootSessionLimit = 6
	childSessionPageSize  = 20
	childSessionMaxLimit  = 50
	e2eeHeaderName        = "X-MindFS-E2EE"
	clientIDHeaderName    = "X-MindFS-Client-ID"
	e2eeProofHeaderName   = "X-MindFS-Proof"
	e2eeTSHeaderName      = "X-MindFS-TS"
	localCLIHeaderName    = "X-MindFS-Local-CLI-Token"
	requestProofMaxSkew   = 5 * time.Minute
)

var indexResourceRefPattern = regexp.MustCompile(`(?i)\b(?:src|href)\s*=\s*["']([^"']+)["']`)

func (h *HTTPHandler) service() *usecase.Service {
	return &usecase.Service{Registry: h.AppContext}
}

func (h *HTTPHandler) requireProtectedHTTPSession(r *http.Request) (*e2ee.Session, bool, error) {
	manager := h.AppContext.GetE2EEManager()
	if manager == nil || !manager.Enabled() {
		return nil, false, nil
	}
	if strings.TrimSpace(r.Header.Get(e2eeHeaderName)) == "" {
		return nil, true, errInvalidRequest("e2ee_required")
	}
	clientID := strings.TrimSpace(r.Header.Get(clientIDHeaderName))
	if clientID == "" {
		return nil, true, errInvalidRequest("client_id required")
	}
	sess, err := manager.SessionForClient(clientID)
	if err != nil {
		return nil, true, errInvalidRequest(err.Error())
	}
	return sess, true, nil
}

func (h *HTTPHandler) requireRequestProof(r *http.Request) (*e2ee.Session, error) {
	manager := h.AppContext.GetE2EEManager()
	if manager == nil || !manager.Enabled() {
		return nil, nil
	}
	clientID := strings.TrimSpace(r.Header.Get(clientIDHeaderName))
	ts := strings.TrimSpace(r.Header.Get(e2eeTSHeaderName))
	proof := strings.TrimSpace(r.Header.Get(e2eeProofHeaderName))
	if clientID == "" || ts == "" || proof == "" {
		return nil, errInvalidRequest("e2ee_proof_required")
	}
	sess, err := manager.SessionForClient(clientID)
	if err != nil {
		return nil, errInvalidRequest(err.Error())
	}
	timestamp, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return nil, errInvalidRequest("invalid_e2ee_ts")
	}
	now := time.Now().UTC()
	if timestamp.Before(now.Add(-requestProofMaxSkew)) || timestamp.After(now.Add(requestProofMaxSkew)) {
		return nil, errInvalidRequest("e2ee_proof_expired")
	}
	expected := e2ee.BuildRequestProof(sess.Key, r.Method, requestProofPath(r), ts, clientID)
	if !e2ee.VerifyProof(expected, proof) {
		return nil, errInvalidRequest("e2ee_proof_invalid")
	}
	return sess, nil
}

func requestProofPath(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	if r.URL.RawQuery == "" {
		return r.URL.Path
	}
	return r.URL.Path + "?" + r.URL.RawQuery
}

func writeProtectedJSON(w http.ResponseWriter, status int, key []byte, value any) error {
	envelope, err := e2ee.EncryptJSON(key, value)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(e2eeHeaderName, "1")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(envelope)
}

func (w *protectedResponseWriter) Header() http.Header {
	return w.ResponseWriter.Header()
}

func (w *protectedResponseWriter) WriteHeader(status int) {
	w.status = status
}

func (w *protectedResponseWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(payload)
}

func (h *HTTPHandler) protectedEndpoint(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.isLocalCLIRequest(r) {
			next(w, r)
			return
		}
		sess, protected, err := h.requireProtectedHTTPSession(r)
		if !protected {
			next(w, r)
			return
		}
		if err != nil {
			respondError(w, http.StatusUnauthorized, err)
			return
		}
		sess, err = h.requireRequestProof(r)
		if err != nil {
			respondError(w, http.StatusUnauthorized, err)
			return
		}
		if r.Body != nil && r.ContentLength != 0 && r.Method != http.MethodGet && r.Method != http.MethodHead {
			var envelope e2ee.CipherEnvelope
			if err := json.NewDecoder(io.LimitReader(r.Body, maxUploadRequestBytes)).Decode(&envelope); err != nil {
				respondError(w, http.StatusBadRequest, errInvalidRequest("invalid protected payload"))
				return
			}
			plaintext, err := e2ee.DecryptBytes(sess.Key, &envelope)
			if err != nil {
				respondError(w, http.StatusBadRequest, errInvalidRequest("e2ee_proof_invalid"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(plaintext))
			r.ContentLength = int64(len(plaintext))
		}
		recorder := &protectedResponseWriter{ResponseWriter: w}
		next(recorder, r)
		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}
		if recorder.status == http.StatusNoContent || recorder.status == http.StatusNotModified || recorder.body.Len() == 0 {
			w.WriteHeader(recorder.status)
			return
		}
		var payload any
		if err := json.Unmarshal(recorder.body.Bytes(), &payload); err != nil {
			respondError(w, http.StatusServiceUnavailable, err)
			return
		}
		if err := writeProtectedJSON(w, recorder.status, sess.Key, payload); err != nil {
			respondError(w, http.StatusServiceUnavailable, err)
			return
		}
	}
}

func (h *HTTPHandler) isLocalCLIRequest(r *http.Request) bool {
	token := strings.TrimSpace(h.LocalCLIToken)
	if token == "" || subtle.ConstantTimeCompare([]byte(strings.TrimSpace(r.Header.Get(localCLIHeaderName))), []byte(token)) != 1 {
		return false
	}
	if !isLocalCLIPath(r) {
		return false
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		host = strings.TrimSpace(r.RemoteAddr)
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLocalCLIPath(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	switch r.Method {
	case http.MethodPost:
		return r.URL.Path == "/api/dirs" || r.URL.Path == "/api/relay/bind/start"
	case http.MethodDelete:
		return r.URL.Path == "/api/dirs"
	default:
		return false
	}
}

func (h *HTTPHandler) broadcastRootChanged(action, rootID string, extra ...map[string]any) {
	if h.AppContext == nil {
		return
	}
	payload := map[string]any{
		"action":  action,
		"root_id": rootID,
	}
	for _, fields := range extra {
		for key, value := range fields {
			payload[key] = value
		}
	}
	h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
		Type:    "root.changed",
		Payload: payload,
	})
}

// Routes constructs the chi router with all endpoints.
func (h *HTTPHandler) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.handleFrontend)
	r.Get("/health", h.handleHealth)
	r.Get("/api/tree", h.protectedEndpoint(h.handleTree))
	r.Get("/api/file", h.handleFile)
	r.Get("/api/git/status", h.protectedEndpoint(h.handleGitStatus))
	r.Get("/api/git/diff", h.protectedEndpoint(h.handleGitDiff))
	r.Get("/api/git/history", h.protectedEndpoint(h.handleGitHistory))
	r.Get("/api/git/commit/files", h.protectedEndpoint(h.handleGitCommitFiles))
	r.Get("/api/git/commit/diff", h.protectedEndpoint(h.handleGitCommitDiff))
	r.Get("/api/git/branches", h.protectedEndpoint(h.handleGitBranches))
	r.Get("/api/git/worktrees", h.protectedEndpoint(h.handleGitWorktreeList))
	r.Post("/api/git/checkout", h.protectedEndpoint(h.handleGitCheckout))
	r.Post("/api/git/pull", h.protectedEndpoint(h.handleGitPull))
	r.Post("/api/git/push", h.protectedEndpoint(h.handleGitPush))
	r.Post("/api/git/commit", h.protectedEndpoint(h.handleGitCommit))
	r.Post("/api/git/stage", h.protectedEndpoint(h.handleGitStage))
	r.Post("/api/git/unstage", h.protectedEndpoint(h.handleGitUnstage))
	r.Post("/api/git/discard", h.protectedEndpoint(h.handleGitDiscard))
	r.Post("/api/git/worktrees", h.protectedEndpoint(h.handleGitWorktreeCreate))
	r.Delete("/api/git/worktrees", h.protectedEndpoint(h.handleGitWorktreeRemove))
	r.Post("/api/upload", h.handleUpload)
	r.Get("/api/candidates", h.protectedEndpoint(h.handleCandidates))
	r.Post("/api/prompts", h.protectedEndpoint(h.handlePromptSave))
	r.Get("/api/sessions", h.protectedEndpoint(h.handleSessions))
	r.Get("/api/replying-sessions", h.protectedEndpoint(h.handleReplyingSessions))
	r.Get("/api/sessions/search", h.protectedEndpoint(h.handleSessionSearch))
	r.Get("/api/sessions/children", h.protectedEndpoint(h.handleSessionChildren))
	r.Get("/api/sessions/external", h.protectedEndpoint(h.handleExternalSessionsList))
	r.Post("/api/sessions/import", h.protectedEndpoint(h.handleExternalSessionImport))
	r.Post("/api/sessions/import/batch", h.protectedEndpoint(h.handleExternalSessionImportBatch))
	r.Post("/api/sessions/fork", h.protectedEndpoint(h.handleSessionFork))
	r.Get("/api/sessions/{key}/toolcalls/{callID}", h.protectedEndpoint(h.handleSessionToolCallGet))
	r.Get("/api/sessions/{key}", h.protectedEndpoint(h.handleSessionGet))
	r.Get("/api/sessions/{key}/related-files", h.protectedEndpoint(h.handleSessionRelatedFilesGet))
	r.Post("/api/sessions/{key}/rename", h.protectedEndpoint(h.handleSessionRename))
	r.Delete("/api/sessions/{key}/related-files", h.protectedEndpoint(h.handleSessionRelatedFilesDelete))
	r.Delete("/api/sessions/{key}", h.protectedEndpoint(h.handleSessionDelete))
	r.Get("/api/scheduled-agent-tasks", h.protectedEndpoint(h.handleScheduledAgentTasksList))
	r.Post("/api/scheduled-agent-tasks", h.protectedEndpoint(h.handleScheduledAgentTaskCreate))
	r.Put("/api/scheduled-agent-tasks/{id}", h.protectedEndpoint(h.handleScheduledAgentTaskUpdate))
	r.Delete("/api/scheduled-agent-tasks/{id}", h.protectedEndpoint(h.handleScheduledAgentTaskDelete))
	r.Post("/api/scheduled-agent-tasks/{id}/run", h.protectedEndpoint(h.handleScheduledAgentTaskRun))
	r.Get("/api/dirs", h.protectedEndpoint(h.handleDirs))
	r.Post("/api/dirs", h.protectedEndpoint(h.handleAddDir))
	r.Post("/api/dirs/{id}/rename", h.protectedEndpoint(h.handleRenameDir))
	r.Delete("/api/dirs", h.protectedEndpoint(h.handleRemoveDir))
	r.Get("/api/local_dirs", h.protectedEndpoint(h.handleLocalDirs))
	r.Get("/api/relay/status", h.handleRelayStatus)
	r.Post("/api/relay/bind/start", h.protectedEndpoint(h.handleRelayBindStart))
	r.Get("/api/relay/tips", h.protectedEndpoint(h.handleRelayTips))
	r.Get("/api/relay/services", h.protectedEndpoint(h.handleRelayServicesList))
	r.Post("/api/relay/services", h.protectedEndpoint(h.handleRelayServiceSave))
	r.Delete("/api/relay/services/{slug}", h.protectedEndpoint(h.handleRelayServiceDelete))
	r.Post("/api/e2ee/open", h.handleE2EEOpen)
	r.Get("/api/app/update", h.protectedEndpoint(h.handleAppUpdateGet))
	r.Post("/api/app/update", h.protectedEndpoint(h.handleAppUpdatePost))
	r.Post("/api/imports/github", h.protectedEndpoint(h.handleGitHubImportStart))
	r.Get("/api/web-push/status", h.protectedEndpoint(h.handleWebPushStatus))
	r.Post("/api/web-push/subscriptions", h.protectedEndpoint(h.handleWebPushSubscriptionSave))
	r.Delete("/api/web-push/subscriptions", h.protectedEndpoint(h.handleWebPushSubscriptionDelete))
	r.Post("/api/web-push/test", h.protectedEndpoint(h.handleWebPushTest))

	// Agent status API
	r.Get("/api/agents", h.protectedEndpoint(h.handleAgentsList))
	r.Post("/api/agents/restart", h.protectedEndpoint(h.handleAgentRestart))
	r.Get("/api/agent-config/defaults", h.protectedEndpoint(h.handleAgentConfigDefaults))
	r.Get("/api/agent-config/backups", h.protectedEndpoint(h.handleAgentConfigBackupsList))
	r.Post("/api/agent-config/backups", h.protectedEndpoint(h.handleAgentConfigBackupCreate))
	r.Delete("/api/agent-config/backups", h.protectedEndpoint(h.handleAgentConfigBackupDelete))
	r.Post("/api/agent-config/switch", h.protectedEndpoint(h.handleAgentConfigSwitch))
	r.NotFound(h.handleNotFound)

	return r
}

func (h *HTTPHandler) handleSessions(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	if truthyQuery(r, "multi_root") {
		h.handleMultiRootSessions(w, r)
		return
	}
	beforeTime, err := parseOptionalTimeQuery(r, "before_time")
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	afterTime, err := parseOptionalTimeQuery(r, "after_time")
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if !beforeTime.IsZero() && !afterTime.IsZero() {
		respondError(w, http.StatusBadRequest, errInvalidRequest("before_time and after_time are mutually exclusive"))
		return
	}
	limit, err := parsePositiveIntQuery(r, "limit")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("limit must be a positive integer"))
		return
	}
	if limit <= 0 {
		limit = sessionListPageSize
	}
	uc := h.service()
	out, err := uc.ListSessions(r.Context(), usecase.ListSessionsInput{
		RootID:          rootID,
		BeforeTime:      beforeTime,
		AfterTime:       afterTime,
		Limit:           limit,
		TopLevelOnly:    truthyQuery(r, "top_level"),
		IncludeChildren: truthyQuery(r, "include_children"),
	})
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	payload := make([]map[string]any, 0, len(out.Sessions))
	for _, s := range out.Sessions {
		payload = append(payload, h.sessionListResponse(s))
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"items":       payload,
		"total_count": out.TotalCount,
	})
}

func (h *HTTPHandler) handleMultiRootSessions(w http.ResponseWriter, r *http.Request) {
	limit, err := parsePositiveIntQuery(r, "limit_per_root")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("limit_per_root must be a positive integer"))
		return
	}
	if limit <= 0 {
		limit = multiRootSessionLimit
	}
	out, err := h.service().ListMultiRootSessions(r.Context(), usecase.ListMultiRootSessionsInput{
		LimitPerRoot: limit,
	})
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	groups := make([]map[string]any, 0, len(out.Groups))
	for _, group := range out.Groups {
		items := make([]map[string]any, 0, len(group.Sessions))
		for _, s := range group.Sessions {
			item := h.sessionListResponse(s)
			item["root_id"] = group.RootID
			items = append(items, item)
		}
		groups = append(groups, map[string]any{
			"root_id":             group.RootID,
			"root_name":           group.RootName,
			"latest_session_time": group.LatestSessionTime,
			"items":               items,
			"total_count":         group.TotalCount,
		})
	}
	respondJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (h *HTTPHandler) handleSessionChildren(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	parentSessionKey := strings.TrimSpace(r.URL.Query().Get("parent_session_key"))
	if parentSessionKey == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("parent_session_key required"))
		return
	}
	beforeTime, err := parseOptionalTimeQuery(r, "before_time")
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	limit, err := parsePositiveIntQuery(r, "limit")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("limit must be a positive integer"))
		return
	}
	if limit <= 0 {
		limit = childSessionPageSize
	} else if limit > childSessionMaxLimit {
		limit = childSessionMaxLimit
	}
	out, err := h.service().ListChildSessions(r.Context(), usecase.ListChildSessionsInput{
		RootID:           rootID,
		ParentSessionKey: parentSessionKey,
		BeforeTime:       beforeTime,
		Limit:            limit,
	})
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	payload := make([]map[string]any, 0, len(out.Sessions))
	for _, s := range out.Sessions {
		payload = append(payload, h.sessionListResponse(s))
	}
	respondJSON(w, http.StatusOK, payload)
}

func (h *HTTPHandler) handleReplyingSessions(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetSessionStreamHub() == nil {
		respondJSON(w, http.StatusOK, map[string]any{"sessions": []map[string]any{}})
		return
	}
	items := h.AppContext.GetSessionStreamHub().ListReplyingSessions()
	payload := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rootTitle := item.RootID
		sessionTitle := strings.TrimSpace(item.SessionTitle)
		if root, err := h.AppContext.GetRoot(item.RootID); err == nil {
			if strings.TrimSpace(root.Name) != "" {
				rootTitle = root.Name
			}
			if sessionTitle == "" {
				if manager, err := h.AppContext.GetSessionManager(item.RootID); err == nil {
					if sess, err := manager.Get(r.Context(), item.SessionKey, 0); err == nil && sess != nil {
						sessionTitle = sess.Name
					}
				}
			}
		}
		payload = append(payload, map[string]any{
			"rootId":       item.RootID,
			"rootTitle":    rootTitle,
			"sessionKey":   item.SessionKey,
			"sessionTitle": sessionTitle,
			"status":       item.Status,
			"summary":      item.Summary,
			"updatedAt":    item.UpdatedAt,
		})
	}
	respondJSON(w, http.StatusOK, map[string]any{"sessions": payload})
}

func (h *HTTPHandler) handleSessionSearch(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	query := r.URL.Query().Get("q")
	limit, err := parsePositiveIntQuery(r, "limit")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("limit must be a positive integer"))
		return
	}
	out, err := h.service().SearchSessions(r.Context(), usecase.SearchSessionsInput{
		RootID: rootID,
		Query:  query,
		Limit:  limit,
	})
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"items": out.Items,
	})
}

func (h *HTTPHandler) handleCandidates(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	candidateType := usecase.CandidateType(strings.TrimSpace(r.URL.Query().Get("type")))
	agent := strings.TrimSpace(r.URL.Query().Get("agent"))
	uc := h.service()
	out, err := uc.SearchCandidates(r.Context(), usecase.SearchCandidatesInput{
		RootID: rootID,
		Type:   candidateType,
		Query:  r.URL.Query().Get("q"),
		Agent:  agent,
	})
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "root not found") {
			status = http.StatusNotFound
		}
		respondError(w, status, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Items)
}

func (h *HTTPHandler) handlePromptSave(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid prompt payload"))
		return
	}
	out, err := h.service().SavePrompt(r.Context(), usecase.SavePromptInput{
		Text: input.Text,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleExternalSessionsList(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	agentName := strings.TrimSpace(r.URL.Query().Get("agent"))
	if rootID == "" || agentName == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root and agent are required"))
		return
	}
	beforeTime, err := parseOptionalTimeQuery(r, "before_time")
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	afterTime, err := parseOptionalTimeQuery(r, "after_time")
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if !beforeTime.IsZero() && !afterTime.IsZero() {
		respondError(w, http.StatusBadRequest, errInvalidRequest("before_time and after_time are mutually exclusive"))
		return
	}
	limit, err := parsePositiveIntQuery(r, "limit")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("limit must be a positive integer"))
		return
	}
	filterBound := false
	switch strings.TrimSpace(r.URL.Query().Get("filter_bound")) {
	case "1", "true", "TRUE", "True":
		filterBound = true
	}
	uc := h.service()
	out, err := uc.ListExternalSessions(r.Context(), usecase.ListExternalSessionsInput{
		RootID:      rootID,
		Agent:       agentName,
		BeforeTime:  beforeTime,
		AfterTime:   afterTime,
		Limit:       limit,
		FilterBound: filterBound,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	payload := make([]map[string]any, 0, len(out.Items))
	for _, item := range out.Items {
		payload = append(payload, externalSessionListResponse(item))
	}
	respondJSON(w, http.StatusOK, payload)
}

func (h *HTTPHandler) handleExternalSessionImport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID         string `json:"root_id"`
		Agent          string `json:"agent"`
		AgentSessionID string `json:"agent_session_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	req.RootID = strings.TrimSpace(req.RootID)
	req.Agent = strings.TrimSpace(req.Agent)
	req.AgentSessionID = strings.TrimSpace(req.AgentSessionID)
	if req.RootID == "" || req.Agent == "" || req.AgentSessionID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root_id, agent, agent_session_id are required"))
		return
	}
	uc := h.service()
	out, err := uc.ImportExternalSession(r.Context(), usecase.ImportExternalSessionInput{
		RootID:         req.RootID,
		Agent:          req.Agent,
		AgentSessionID: req.AgentSessionID,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
			Type: "session.imported",
			Payload: map[string]any{
				"root_id":          req.RootID,
				"session_key":      out.SessionKey,
				"agent":            out.Agent,
				"agent_session_id": out.AgentSessionID,
				"imported_count":   out.ImportedCount,
			},
		})
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleExternalSessionImportBatch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID          string   `json:"root_id"`
		Agent           string   `json:"agent"`
		AgentSessionIDs []string `json:"agent_session_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	req.RootID = strings.TrimSpace(req.RootID)
	req.Agent = strings.TrimSpace(req.Agent)
	if req.RootID == "" || req.Agent == "" || len(req.AgentSessionIDs) == 0 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root_id, agent, agent_session_ids are required"))
		return
	}
	uc := h.service()
	out, err := uc.ImportExternalSessionsBatch(r.Context(), usecase.ImportExternalSessionsBatchInput{
		RootID:          req.RootID,
		Agent:           req.Agent,
		AgentSessionIDs: req.AgentSessionIDs,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		for _, item := range out.Items {
			if !item.Success || strings.TrimSpace(item.SessionKey) == "" {
				continue
			}
			h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
				Type: "session.imported",
				Payload: map[string]any{
					"root_id":          req.RootID,
					"session_key":      item.SessionKey,
					"agent":            req.Agent,
					"agent_session_id": item.AgentSessionID,
					"imported_count":   item.ImportedCount,
				},
			})
		}
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	afterSeq, err := parsePositiveIntQuery(r, "seq")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("seq must be a positive integer"))
		return
	}
	uc := h.service()
	var pendingUser *session.Exchange
	if h.AppContext != nil {
		pendingUser = h.AppContext.GetSessionStreamHub().GetPendingUserExchange(key)
	}
	if pendingUser == nil {
		if _, err := uc.SyncExternalSessionDelta(r.Context(), usecase.SyncExternalSessionDeltaInput{
			RootID: rootID,
			Key:    key,
		}); err != nil {
			log.Printf("[session/sync] external delta best-effort failed root=%s session=%s err=%v", strings.TrimSpace(rootID), strings.TrimSpace(key), err)
		}
	}
	out, err := uc.GetSession(r.Context(), usecase.GetSessionInput{
		RootID: rootID,
		Key:    key,
		Seq:    afterSeq,
	})
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	contextWindow, _ := uc.GetSessionContextWindow(r.Context(), usecase.GetSessionContextWindowInput{
		RootID: rootID,
		Key:    key,
	})
	exchangeAux, _ := uc.GetSessionExchangeAux(r.Context(), usecase.GetSessionExchangeAuxInput{
		RootID: rootID,
		Key:    key,
		Seq:    afterSeq,
	})
	respondJSON(w, http.StatusOK, h.sessionResponse(out, pendingUser, contextWindow, exchangeAux))
}

func (h *HTTPHandler) handleSessionToolCallGet(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	callID := chi.URLParam(r, "callID")
	if strings.TrimSpace(key) == "" || strings.TrimSpace(callID) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key and tool call id required"))
		return
	}
	toolCall, err := h.service().GetSessionToolCall(r.Context(), usecase.GetSessionToolCallInput{
		RootID: rootID,
		Key:    key,
		CallID: callID,
	})
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			respondError(w, http.StatusNotFound, err)
			return
		}
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"toolcall": toolCall})
}

func (h *HTTPHandler) handleSessionRelatedFilesGet(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	uc := h.service()
	out, err := uc.GetSessionRelatedFiles(r.Context(), usecase.GetSessionRelatedFilesInput{
		RootID: rootID,
		Key:    key,
	})
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleSessionRelatedFilesDelete(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	uc := h.service()
	if err := uc.RemoveSessionRelatedFile(r.Context(), usecase.RemoveSessionRelatedFileInput{
		RootID: rootID,
		Key:    key,
		Path:   path,
	}); err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
			Type: "session.related_files.updated",
			Payload: map[string]any{
				"root_id":     rootID,
				"session_key": key,
			},
		})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) handleSessionFork(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID     string `json:"root_id"`
		SessionKey string `json:"session_key"`
		Seq        int    `json:"seq"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	if strings.TrimSpace(req.RootID) == "" || strings.TrimSpace(req.SessionKey) == "" || req.Seq <= 0 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root_id, session_key and seq are required"))
		return
	}
	out, err := h.service().ForkSession(r.Context(), usecase.ForkSessionInput{
		RootID: req.RootID,
		Key:    req.SessionKey,
		Seq:    req.Seq,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil && out.Session != nil {
		h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
			Type: "session.created",
			Payload: map[string]any{
				"root_id": req.RootID,
				"session": h.sessionListResponse(out.Session),
			},
		})
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"session_key": out.Session.Key,
		"session":     h.sessionResponse(out.Session, nil, agenttypes.ContextWindow{}, nil),
	})
}

func (h *HTTPHandler) handleSessionRename(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	uc := h.service()
	renamed, err := uc.RenameSession(r.Context(), usecase.RenameSessionInput{
		RootID: rootID,
		Key:    key,
		Name:   req.Name,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
			Type: "session.meta.updated",
			Payload: map[string]any{
				"root_id": rootID,
				"session": map[string]any{
					"key":          renamed.Key,
					"name":         renamed.Name,
					"model":        renamed.Model,
					"mode":         session.InferModeFromSession(renamed),
					"effort":       session.InferEffortFromSession(renamed),
					"fast_service": session.InferFastServiceFromSession(renamed),
					"plan_mode":    renamed.PlanMode,
					"updated_at":   renamed.UpdatedAt,
				},
			},
		})
	}
	respondJSON(w, http.StatusOK, h.sessionListResponse(renamed))
}

func (h *HTTPHandler) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	uc := h.service()
	if err := uc.DeleteSession(r.Context(), usecase.DeleteSessionInput{
		RootID: rootID,
		Key:    key,
	}); err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) sessionResponse(
	s *session.Session,
	pendingUser *session.Exchange,
	contextWindow agenttypes.ContextWindow,
	exchangeAux map[int][]session.ExchangeAux,
) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	exchanges := append([]session.Exchange{}, s.Exchanges...)
	if pendingUser != nil {
		pendingUser.Seq = 0
		exchanges = append(exchanges, *pendingUser)
	}
	auxPayload := make(map[string][]session.ExchangeAux, len(exchangeAux))
	for seq, items := range exchangeAux {
		if seq <= 0 || len(items) == 0 {
			continue
		}
		auxPayload[strconv.Itoa(seq)] = append([]session.ExchangeAux(nil), items...)
	}
	return map[string]any{
		"key":                 s.Key,
		"type":                s.Type,
		"parent_session_key":  s.ParentSessionKey,
		"parent_tool_call_id": s.ParentToolCallID,
		"source":              s.Source,
		"agent":               session.InferAgentFromSession(s),
		"model":               s.Model,
		"mode":                session.InferModeFromSession(s),
		"effort":              session.InferEffortFromSession(s),
		"fast_service":        session.InferFastServiceFromSession(s),
		"plan_mode":           s.PlanMode,
		"shell":               h.commandShellForResponse(s, exchangeAux),
		"name":                s.Name,
		"exchanges":           exchanges,
		"exchange_aux":        auxPayload,
		"related_files":       s.RelatedFiles,
		"context_window":      contextWindow,
		"created_at":          s.CreatedAt,
		"updated_at":          s.UpdatedAt,
		"closed_at":           s.ClosedAt,
	}
}

func (h *HTTPHandler) sessionListResponse(s *session.Session) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	return map[string]any{
		"key":                 s.Key,
		"type":                s.Type,
		"parent_session_key":  s.ParentSessionKey,
		"parent_tool_call_id": s.ParentToolCallID,
		"source":              s.Source,
		"agent":               session.InferAgentFromSession(s),
		"model":               s.Model,
		"mode":                session.InferModeFromSession(s),
		"effort":              session.InferEffortFromSession(s),
		"fast_service":        session.InferFastServiceFromSession(s),
		"plan_mode":           s.PlanMode,
		"shell":               h.commandShellForSession(s),
		"name":                s.Name,
		"created_at":          s.CreatedAt,
		"updated_at":          s.UpdatedAt,
		"closed_at":           s.ClosedAt,
	}
}

func (h *HTTPHandler) configuredShells() []commandexec.ShellSpec {
	if h == nil || h.AppContext == nil || h.AppContext.GetAgentPool() == nil {
		return nil
	}
	cfg := h.AppContext.GetAgentPool().Config()
	shells := make([]commandexec.ShellSpec, 0, len(cfg.Shells))
	for _, shell := range cfg.Shells {
		shells = append(shells, commandexec.ShellSpec{
			Command:       shell.Command,
			Args:          append([]string(nil), shell.Args...),
			LongShellArgs: append([]string(nil), shell.LongShellArgs...),
			CommandPrefix: shell.CommandPrefix,
		})
	}
	return shells
}

func (h *HTTPHandler) commandShellForSession(s *session.Session) string {
	if s == nil || s.Type != session.TypeCommand {
		return ""
	}
	if strings.TrimSpace(s.Shell) != "" {
		return strings.TrimSpace(s.Shell)
	}
	return commandexec.ResolveShell(h.configuredShells())
}

func (h *HTTPHandler) commandShellForResponse(s *session.Session, aux map[int][]session.ExchangeAux) string {
	if s == nil || s.Type != session.TypeCommand {
		return ""
	}
	if shell := session.InferCommandShellFromAux(aux); strings.TrimSpace(shell) != "" {
		return strings.TrimSpace(shell)
	}
	return h.commandShellForSession(s)
}

func externalSessionListResponse(s agenttypes.ExternalSessionSummary) map[string]any {
	name := strings.TrimSpace(s.Title)
	if name == "" {
		name = strings.TrimSpace(s.FirstUserText)
	}
	if name == "" {
		name = s.AgentSessionID
	}
	return map[string]any{
		"key":              s.AgentSessionID,
		"type":             session.TypeChat,
		"agent":            s.Agent,
		"model":            "",
		"name":             name,
		"title":            strings.TrimSpace(s.Title),
		"created_at":       s.UpdatedAt,
		"updated_at":       s.UpdatedAt,
		"closed_at":        nil,
		"agent_session_id": s.AgentSessionID,
	}
}

func (h *HTTPHandler) handleAgentsList(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetProber() == nil {
		log.Printf("[http] agents.list.short_circuit returning_empty_response")
		respondJSON(w, http.StatusOK, map[string]any{
			"agents": []map[string]any{},
			"shells": []map[string]any{},
		})
		return
	}
	statuses := h.AppContext.GetProber().GetInstalledStatuses()
	if r.URL.Query().Get("all") == "1" {
		statuses = h.AppContext.GetProber().GetConfiguredStatuses()
	}
	if prefs := h.AppContext.GetPreferences(); prefs != nil {
		statuses = prefs.ApplyAgentDefaults(statuses)
	}
	shells := []agent.ShellStatus{}
	if pool := h.AppContext.GetAgentPool(); pool != nil {
		shells = pool.AvailableShells()
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"agents": statuses,
		"shells": shells,
	})
}

func (h *HTTPHandler) handleAppUpdateGet(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetUpdateService() == nil {
		respondJSON(w, http.StatusOK, map[string]any{
			"status": "idle",
		})
		return
	}
	respondJSON(w, http.StatusOK, h.AppContext.GetUpdateService().GetStatus())
}

func (h *HTTPHandler) handleAppUpdatePost(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetUpdateService() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("update service not configured"))
		return
	}
	if err := h.AppContext.GetUpdateService().TriggerUpdate(r.Context()); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, h.AppContext.GetUpdateService().GetStatus())
}

func (h *HTTPHandler) handleLocalDirs(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	out, err := h.service().ListLocalDirs(r.Context(), usecase.ListLocalDirsInput{
		Path: path,
	})
	if err != nil {
		status := http.StatusBadRequest
		if os.IsNotExist(err) {
			status = http.StatusNotFound
		}
		respondError(w, status, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleGitHubImportStart(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetGitHubImportService() == nil {
		respondError(w, http.StatusServiceUnavailable, errInvalidRequest("github import service not configured"))
		return
	}
	var req struct {
		URL        string `json:"url"`
		ParentPath string `json:"parent_path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	status, err := h.AppContext.GetGitHubImportService().Start(r.Context(), githubimport.StartInput{
		URL:        req.URL,
		ParentPath: req.ParentPath,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest(err.Error()))
		return
	}
	respondJSON(w, http.StatusAccepted, map[string]any{
		"task_id": status.TaskID,
		"status":  "accepted",
	})
}

func (h *HTTPHandler) handleFrontend(w http.ResponseWriter, r *http.Request) {
	if h.serveStaticAsset(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if h.shouldRewriteRelayedAssets(r) {
		w.Write([]byte(rewriteRelayedFrontendContent(indexHTML)))
		return
	}
	w.Write([]byte(renderFallbackFrontend(indexHTML, frontendAssetMissingNotice(r.URL.Path))))
}

func (h *HTTPHandler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

func (h *HTTPHandler) handleNotFound(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" || r.URL.Path == "/ws" || r.URL.Path == "/health" {
		http.NotFound(w, r)
		return
	}
	h.handleFrontend(w, r)
}

func (h *HTTPHandler) serveStaticAsset(w http.ResponseWriter, r *http.Request) bool {
	staticDir := strings.TrimSpace(h.StaticDir)
	if staticDir == "" {
		return false
	}

	cleanPath := pathForStaticAsset(r.URL.Path)
	if cleanPath == "" {
		cleanPath = "index.html"
	}

	assetPath := filepath.Join(staticDir, cleanPath)
	info, statErr := os.Stat(assetPath)
	if statErr == nil && !info.IsDir() {
		applyStaticCacheHeaders(w, cleanPath)
		if cleanPath == "index.html" {
			h.serveFrontendIndex(w, r, staticDir, assetPath)
			return true
		}
		if h.shouldRewriteRelayedAssets(r) && shouldRewriteRelayedStaticAsset(cleanPath) {
			serveRewrittenStaticAsset(w, r, assetPath)
			return true
		}
		http.ServeFile(w, r, assetPath)
		return true
	}

	if filepath.Ext(cleanPath) != "" {
		http.NotFound(w, r)
		return true
	}

	indexPath := filepath.Join(staticDir, "index.html")
	if info, err := os.Stat(indexPath); err == nil && !info.IsDir() {
		applyStaticCacheHeaders(w, "index.html")
		h.serveFrontendIndex(w, r, staticDir, indexPath)
		return true
	}

	return false
}

func (h *HTTPHandler) serveFrontendIndex(w http.ResponseWriter, r *http.Request, staticDir, indexPath string) {
	content, err := os.ReadFile(indexPath)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(renderFallbackFrontend(indexHTML, frontendAssetMissingNotice(r.URL.Path))))
		return
	}
	if missing := missingFrontendIndexResource(staticDir, content); missing != "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(renderFallbackFrontend(indexHTML, frontendAssetMissingNotice(missing))))
		return
	}
	if h.shouldRewriteRelayedAssets(r) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(rewriteRelayedFrontendContent(string(content))))
		return
	}
	http.ServeFile(w, r, indexPath)
}

func missingFrontendIndexResource(staticDir string, indexContent []byte) string {
	matches := indexResourceRefPattern.FindAllSubmatch(indexContent, -1)
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		cleanPath := cleanFrontendResourcePath(string(match[1]))
		if cleanPath == "" {
			continue
		}
		info, err := os.Stat(filepath.Join(staticDir, cleanPath))
		if err != nil || info.IsDir() {
			return "/" + filepath.ToSlash(cleanPath)
		}
	}
	return ""
}

func cleanFrontendResourcePath(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || strings.HasPrefix(value, "#") {
		return ""
	}
	lower := strings.ToLower(value)
	for _, prefix := range []string{"http://", "https://", "data:", "blob:", "mailto:", "tel:"} {
		if strings.HasPrefix(lower, prefix) {
			return ""
		}
	}
	if idx := strings.IndexAny(value, "?#"); idx >= 0 {
		value = value[:idx]
	}
	value = strings.TrimPrefix(value, "./")
	value = strings.TrimPrefix(value, "/")
	value = filepath.Clean(value)
	if value == "." || strings.HasPrefix(value, ".."+string(filepath.Separator)) || value == ".." || filepath.IsAbs(value) {
		return ""
	}
	return value
}

func frontendAssetMissingNotice(requestPath string) string {
	cleanPath := pathForStaticAsset(requestPath)
	if cleanPath == "" {
		cleanPath = "index.html"
	}
	displayPath := filepath.ToSlash(cleanPath)
	return fmt.Sprintf("frontend assets missing: web/%s not found. Please reinstall or check the install directory.", displayPath)
}

func renderFallbackFrontend(content, notice string) string {
	out := content
	noticeHTML := ""
	if strings.TrimSpace(notice) != "" {
		noticeHTML = `<div class="notice is-visible">` + htmpl.HTMLEscapeString(notice) + `</div>`
	}
	out = strings.ReplaceAll(out, "__FALLBACK_NOTICE__", noticeHTML)
	return out
}

func applyStaticCacheHeaders(w http.ResponseWriter, cleanPath string) {
	switch cleanPath {
	case "service-worker.js", "index.html":
		w.Header().Set("Cache-Control", "no-cache")
		return
	}

	if strings.HasPrefix(cleanPath, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
}

func isRelayedRequest(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("X-MindFS-Relayed")) == "1"
}

func (h *HTTPHandler) shouldRewriteRelayedAssets(r *http.Request) bool {
	return isRelayedRequest(r) && isStandardReleaseVersion(h.Version)
}

func isStandardReleaseVersion(version string) bool {
	version = strings.TrimSpace(version)
	if version == "" {
		return false
	}
	version, _ = strings.CutPrefix(version, "v")
	parts := strings.Split(version, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, ch := range part {
			if ch < '0' || ch > '9' {
				return false
			}
		}
	}
	return true
}

func shouldRewriteRelayedStaticAsset(cleanPath string) bool {
	switch cleanPath {
	case "index.html", "service-worker.js":
		return true
	default:
		return false
	}
}

func rewriteRelayedFrontendContent(content string) string {
	return strings.ReplaceAll(content, "./assets/", "/mindfs-assets/")
}

func serveRewrittenStaticAsset(w http.ResponseWriter, r *http.Request, assetPath string) {
	content, err := os.ReadFile(assetPath)
	if err != nil {
		http.ServeFile(w, r, assetPath)
		return
	}
	switch filepath.Base(assetPath) {
	case "index.html":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case "service-worker.js":
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	w.Write([]byte(rewriteRelayedFrontendContent(string(content))))
}

func pathForStaticAsset(requestPath string) string {
	// requestPath 是 URL path，分隔符固定为正斜杠。这里不能用 filepath，
	// 否则 Windows 会把前导 // 当成 UNC 路径，最终泄漏成 web/// 这类路径。
	cleaned := stdpath.Clean("/" + requestPath)
	if cleaned == "/" {
		return ""
	}
	return strings.TrimPrefix(cleaned, "/")
}

func (h *HTTPHandler) handleTree(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	uc := h.service()
	out, err := uc.ListTree(r.Context(), usecase.ListTreeInput{
		RootID: rootID,
		Dir:    r.URL.Query().Get("dir"),
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"entries": out.Entries,
	})
}

func (h *HTTPHandler) handleFile(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	uc := h.service()
	path := r.URL.Query().Get("path")
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	cursor, err := parseNonNegativeInt64Query(r, "cursor")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("cursor must be a non-negative integer"))
		return
	}
	readMode := strings.TrimSpace(r.URL.Query().Get("read"))
	if readMode == "" {
		readMode = "incremental"
	}
	if readMode != "incremental" && readMode != "full" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("read must be incremental or full"))
		return
	}
	cachedMTime, err := parseOptionalTimeQuery(r, "mtime")
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("mtime must be RFC3339"))
		return
	}
	raw := r.URL.Query().Get("raw")
	proofSession, err := h.requireRequestProof(r)
	if err != nil {
		respondError(w, http.StatusUnauthorized, err)
		return
	}
	if raw == "1" {
		rawOut, err := uc.OpenFileRaw(r.Context(), usecase.OpenFileRawInput{
			RootID: rootID,
			Path:   path,
		})
		if err != nil {
			respondError(w, http.StatusBadRequest, err)
			return
		}
		defer rawOut.File.Close()
		w.Header().Set("Content-Length", strconv.FormatInt(rawOut.Info.Size(), 10))
		ext := filepath.Ext(rawOut.RelPath)
		if mimeType := mime.TypeByExtension(ext); mimeType != "" {
			w.Header().Set("Content-Type", mimeType)
		} else {
			w.Header().Set("Content-Type", "application/octet-stream")
		}
		if r.URL.Query().Get("download") == "1" {
			w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filepath.Base(rawOut.RelPath)))
		}
		w.WriteHeader(http.StatusOK)
		io.Copy(w, rawOut.File)
		return
	}
	if !cachedMTime.IsZero() {
		info, err := uc.GetFileInfo(r.Context(), usecase.GetFileInfoInput{
			RootID: rootID,
			Path:   path,
		})
		if err != nil {
			respondError(w, http.StatusBadRequest, err)
			return
		}
		if info.MTime.Equal(cachedMTime) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	out, err := uc.ReadFile(r.Context(), usecase.ReadFileInput{
		RootID:   rootID,
		Path:     path,
		MaxBytes: 128 * 1024,
		Cursor:   cursor,
		ReadMode: readMode,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	payload := map[string]any{
		"file": out.File,
	}
	if proofSession != nil {
		if err := writeProtectedJSON(w, http.StatusOK, proofSession.Key, payload); err != nil {
			respondError(w, http.StatusServiceUnavailable, err)
		}
		return
	}
	respondJSON(w, http.StatusOK, payload)
}

func (h *HTTPHandler) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	rootPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootID == "" && rootPath == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root or path required"))
		return
	}
	uc := h.service()
	out, err := uc.GetGitStatus(r.Context(), usecase.GitStatusInput{RootID: rootID, RootPath: rootPath})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Status)
}

func (h *HTTPHandler) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	uc := h.service()
	out, err := uc.GetGitDiff(r.Context(), usecase.GitDiffInput{
		RootID: rootID,
		Path:   path,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Diff)
}

func (h *HTTPHandler) handleGitHistory(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	limit := 10
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil {
			respondError(w, http.StatusBadRequest, errInvalidRequest("invalid limit"))
			return
		}
		limit = parsed
	}
	uc := h.service()
	out, err := uc.GetGitHistory(r.Context(), usecase.GitHistoryInput{
		RootID:       rootID,
		Limit:        limit,
		BeforeCommit: strings.TrimSpace(r.URL.Query().Get("before_commit")),
		AfterCommit:  strings.TrimSpace(r.URL.Query().Get("after_commit")),
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.History)
}

func (h *HTTPHandler) handleGitCommitFiles(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	commit := strings.TrimSpace(r.URL.Query().Get("commit"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if commit == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("commit required"))
		return
	}
	uc := h.service()
	out, err := uc.GetGitCommitFiles(r.Context(), usecase.GitCommitFilesInput{
		RootID: rootID,
		Commit: commit,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Files)
}

func (h *HTTPHandler) handleGitCommitDiff(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	commit := strings.TrimSpace(r.URL.Query().Get("commit"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if commit == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("commit required"))
		return
	}
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	uc := h.service()
	out, err := uc.GetGitCommitDiff(r.Context(), usecase.GitCommitDiffInput{
		RootID: rootID,
		Commit: commit,
		Path:   path,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Diff)
}

func (h *HTTPHandler) handleGitBranches(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	uc := h.service()
	out, err := uc.ListGitBranches(r.Context(), usecase.ListGitBranchesInput{RootID: rootID})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleGitCheckout(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID string `json:"root"`
		Branch string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	req.RootID = strings.TrimSpace(req.RootID)
	req.Branch = strings.TrimSpace(req.Branch)
	if req.RootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if req.Branch == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("branch required"))
		return
	}
	uc := h.service()
	out, err := uc.CheckoutGitBranch(r.Context(), usecase.CheckoutGitBranchInput{
		RootID: req.RootID,
		Branch: req.Branch,
	})
	if err != nil {
		respondJSON(w, http.StatusConflict, map[string]any{
			"error":   "git_checkout_failed",
			"message": err.Error(),
		})
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleGitPull(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, false, false)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitPull(r.Context(), usecase.GitActionInput{RootID: req.RootID})
	respondGitAction(w, out, err, "git_pull_failed")
}

func (h *HTTPHandler) handleGitPush(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, false, false)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitPush(r.Context(), usecase.GitActionInput{RootID: req.RootID})
	respondGitAction(w, out, err, "git_push_failed")
}

func (h *HTTPHandler) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, false, true)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitCommit(r.Context(), usecase.GitActionInput{
		RootID:  req.RootID,
		Message: req.Message,
	})
	respondGitAction(w, out, err, "git_commit_failed")
}

func (h *HTTPHandler) handleGitStage(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, true, false)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitStagePath(r.Context(), usecase.GitActionInput{
		RootID: req.RootID,
		Path:   req.Path,
	})
	respondGitAction(w, out, err, "git_stage_failed")
}

func (h *HTTPHandler) handleGitUnstage(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, true, false)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitUnstagePath(r.Context(), usecase.GitActionInput{
		RootID: req.RootID,
		Path:   req.Path,
	})
	respondGitAction(w, out, err, "git_unstage_failed")
}

func (h *HTTPHandler) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeGitActionRequest(w, r, true, false)
	if !ok {
		return
	}
	uc := h.service()
	out, err := uc.GitDiscardPath(r.Context(), usecase.GitActionInput{
		RootID: req.RootID,
		Path:   req.Path,
		Status: req.Status,
	})
	respondGitAction(w, out, err, "git_discard_failed")
}

type gitActionRequest struct {
	RootID  string `json:"root"`
	Path    string `json:"path"`
	Status  string `json:"status"`
	Message string `json:"message"`
}

func decodeGitActionRequest(w http.ResponseWriter, r *http.Request, requirePath bool, requireMessage bool) (gitActionRequest, bool) {
	var req gitActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return req, false
	}
	req.RootID = strings.TrimSpace(req.RootID)
	req.Path = strings.TrimSpace(req.Path)
	req.Status = strings.TrimSpace(req.Status)
	req.Message = strings.TrimSpace(req.Message)
	if req.RootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return req, false
	}
	if requirePath && req.Path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return req, false
	}
	if requireMessage && req.Message == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("message required"))
		return req, false
	}
	return req, true
}

func respondGitAction(w http.ResponseWriter, out usecase.GitActionOutput, err error, code string) {
	if err != nil {
		respondJSON(w, http.StatusConflict, map[string]any{
			"error":   code,
			"message": err.Error(),
		})
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleGitWorktreeList(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	uc := h.service()
	out, err := uc.ListGitWorktrees(r.Context(), usecase.ListGitWorktreesInput{RootID: rootID})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out)
}

func (h *HTTPHandler) handleGitWorktreeCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID     string `json:"root"`
		ParentPath string `json:"parent_path"`
		Name       string `json:"name"`
		BranchMode string `json:"branch_mode"`
		Branch     string `json:"branch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.CreateGitWorktree(r.Context(), usecase.CreateGitWorktreeInput{
		RootID:     req.RootID,
		ParentPath: req.ParentPath,
		Name:       req.Name,
		BranchMode: req.BranchMode,
		Branch:     req.Branch,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		h.broadcastRootChanged("added", out.Dir.ID)
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func (h *HTTPHandler) handleGitWorktreeRemove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID string `json:"root"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.RemoveGitWorktree(r.Context(), usecase.RemoveGitWorktreeInput{RootID: req.RootID})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		h.broadcastRootChanged("removed", out.Dir.ID)
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func (h *HTTPHandler) handleUpload(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	proofSession, err := h.requireRequestProof(r)
	if err != nil {
		respondError(w, http.StatusUnauthorized, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadRequestBytes)
	if err := r.ParseMultipartForm(maxUploadRequestBytes); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid multipart form"))
		return
	}
	if r.MultipartForm == nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("files required"))
		return
	}
	fileHeaders := r.MultipartForm.File["files"]
	if len(fileHeaders) == 0 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("files required"))
		return
	}
	if len(fileHeaders) > maxUploadFileCount {
		respondError(w, http.StatusBadRequest, errInvalidRequest("too many files"))
		return
	}
	files, err := buildUploadFiles(fileHeaders)
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	defer closeMultipartFiles(files)

	uc := h.service()
	out, err := uc.SaveUploadedFiles(r.Context(), usecase.SaveUploadedFilesInput{
		RootID: rootID,
		Dir:    strings.TrimSpace(r.FormValue("dir")),
		Files:  files,
	})
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "root not found") {
			status = http.StatusNotFound
		}
		respondError(w, status, err)
		return
	}
	payload := map[string]any{
		"files": out.Files,
	}
	if proofSession != nil {
		if err := writeProtectedJSON(w, http.StatusOK, proofSession.Key, payload); err != nil {
			respondError(w, http.StatusServiceUnavailable, err)
		}
		return
	}
	respondJSON(w, http.StatusOK, payload)
}

func buildUploadFiles(headers []*multipart.FileHeader) ([]usecase.UploadFile, error) {
	files := make([]usecase.UploadFile, 0, len(headers))
	for _, header := range headers {
		file, err := header.Open()
		if err != nil {
			closeMultipartFiles(files)
			return nil, errInvalidRequest("failed to open uploaded file")
		}
		files = append(files, usecase.UploadFile{
			Name:        header.Filename,
			ContentType: header.Header.Get("Content-Type"),
			Reader:      file,
		})
	}
	return files, nil
}

func closeMultipartFiles(files []usecase.UploadFile) {
	for _, file := range files {
		closer, ok := file.Reader.(io.Closer)
		if !ok {
			continue
		}
		_ = closer.Close()
	}
}

func parseNonNegativeInt64Query(r *http.Request, key string) (int64, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, errInvalidRequest(key + " must be non-negative")
	}
	return value, nil
}

func parseOptionalTimeQuery(r *http.Request, key string) (time.Time, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return time.Time{}, nil
	}
	value, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		value, err = time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return time.Time{}, errInvalidRequest(key + " must be RFC3339")
		}
	}
	return value.UTC(), nil
}

func parsePositiveIntQuery(r *http.Request, key string) (int, error) {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return 0, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return 0, errInvalidRequest(key + " must be positive")
	}
	return value, nil
}

func truthyQuery(r *http.Request, key string) bool {
	switch strings.ToLower(strings.TrimSpace(r.URL.Query().Get(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func (h *HTTPHandler) handleDirs(w http.ResponseWriter, _ *http.Request) {
	uc := h.service()
	out, err := uc.ListManagedDirs(nil)
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	resp := make([]map[string]any, 0, len(out.Dirs))
	for _, dir := range out.Dirs {
		resp = append(resp, managedDirResponse(dir))
	}
	respondJSON(w, http.StatusOK, resp)
}

func (h *HTTPHandler) handleAddDir(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path   string `json:"path"`
		Create bool   `json:"create"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.AddManagedDir(r.Context(), usecase.AddManagedDirInput{Path: req.Path, Create: req.Create})
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fs.ErrRootNameConflict) {
			status = http.StatusConflict
		}
		respondError(w, status, err)
		return
	}
	if h.AppContext != nil {
		h.broadcastRootChanged("added", out.Dir.ID)
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func (h *HTTPHandler) handleRenameDir(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(chi.URLParam(r, "id"))
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.RenameManagedDir(r.Context(), usecase.RenameManagedDirInput{
		RootID: rootID,
		Name:   req.Name,
	})
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, fs.ErrRootNameConflict) || strings.Contains(err.Error(), "already exists") {
			status = http.StatusConflict
		} else if strings.Contains(err.Error(), "root not found") {
			status = http.StatusNotFound
		}
		respondError(w, status, err)
		return
	}
	if h.AppContext != nil {
		rootPayload := managedDirResponse(out.Dir)
		h.broadcastRootChanged("renamed", out.Dir.ID, map[string]any{
			"old_root_id": out.OldRootID,
			"root":        rootPayload,
		})
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func (h *HTTPHandler) handleRemoveDir(w http.ResponseWriter, r *http.Request) {
	path := readManagedDirPath(r)
	uc := h.service()
	out, err := uc.RemoveManagedDir(r.Context(), usecase.RemoveManagedDirInput{Path: path})
	if err != nil {
		status := http.StatusBadRequest
		if strings.Contains(err.Error(), "root not found") {
			status = http.StatusNotFound
		}
		respondError(w, status, err)
		return
	}
	if h.AppContext != nil {
		h.broadcastRootChanged("removed", out.Dir.ID)
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func readManagedDirPath(r *http.Request) string {
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path != "" {
		return path
	}

	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return ""
	}
	return strings.TrimSpace(req.Path)
}

func (h *HTTPHandler) handleRelayStatus(w http.ResponseWriter, r *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	status := h.relayStatusWithE2EE(manager.Status())
	if !status.E2EERequired {
		respondJSON(w, http.StatusOK, status)
		return
	}

	sess, err := h.relayStatusSession(r)
	if err != nil {
		respondError(w, http.StatusUnauthorized, err)
		return
	}
	if sess == nil {
		respondJSON(w, http.StatusOK, publicRelayStatus(status))
		return
	}
	if err := writeProtectedJSON(w, http.StatusOK, sess.Key, status); err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
}

func (h *HTTPHandler) relayStatusSession(r *http.Request) (*e2ee.Session, error) {
	if strings.TrimSpace(r.Header.Get(e2eeHeaderName)) == "" {
		return nil, nil
	}
	sess, protected, err := h.requireProtectedHTTPSession(r)
	if !protected {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess, err = h.requireRequestProof(r)
	if err != nil {
		return nil, err
	}
	return sess, nil
}

func (h *HTTPHandler) handleRelayBindStart(w http.ResponseWriter, _ *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	status, err := manager.StartBinding()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable(err.Error()))
		return
	}
	respondJSON(w, http.StatusOK, h.relayStatusWithE2EE(status))
}

func (h *HTTPHandler) relayStatusWithE2EE(status relay.Status) relay.Status {
	if h == nil || h.AppContext == nil {
		return status
	}
	e2eeManager := h.AppContext.GetE2EEManager()
	if e2eeManager == nil || !e2eeManager.Enabled() {
		status.E2EERequired = false
		status.E2EENodeID = ""
		return status
	}
	status.E2EERequired = true
	status.E2EENodeID = e2eeManager.NodeID()
	return status
}

func publicRelayStatus(status relay.Status) relay.Status {
	return relay.Status{
		NoRelayer:    status.NoRelayer,
		E2EERequired: status.E2EERequired,
		E2EENodeID:   status.E2EENodeID,
	}
}

func (h *HTTPHandler) handleRelayTips(w http.ResponseWriter, _ *http.Request) {
	if h.AppContext == nil || h.AppContext.GetRelayTipsService() == nil {
		respondJSON(w, http.StatusOK, nil)
		return
	}
	respondJSON(w, http.StatusOK, h.AppContext.GetRelayTipsService().Get())
}

func (h *HTTPHandler) handleE2EEOpen(w http.ResponseWriter, r *http.Request) {
	manager := h.AppContext.GetE2EEManager()
	if manager == nil || !manager.Enabled() {
		respondError(w, http.StatusForbidden, errServiceUnavailable("e2ee_required"))
		return
	}
	var req struct {
		ClientID    string `json:"client_id"`
		NodeID      string `json:"node_id"`
		ClientEphPK string `json:"client_eph_pk"`
		ClientNonce string `json:"client_nonce"`
		Proof       string `json:"proof"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid e2ee open payload"))
		return
	}
	req.ClientID = strings.TrimSpace(req.ClientID)
	req.NodeID = strings.TrimSpace(req.NodeID)
	req.ClientEphPK = strings.TrimSpace(req.ClientEphPK)
	req.ClientNonce = strings.TrimSpace(req.ClientNonce)
	req.Proof = strings.TrimSpace(req.Proof)
	if req.ClientID == "" || req.NodeID == "" || req.ClientEphPK == "" || req.ClientNonce == "" || req.Proof == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("client_id, node_id, client_eph_pk, client_nonce and proof are required"))
		return
	}
	if req.NodeID != manager.NodeID() {
		respondError(w, http.StatusForbidden, errInvalidRequest("e2ee_proof_invalid"))
		return
	}
	expectedProof := e2ee.BuildOpenProof(manager.PairingSecret(), req.NodeID, req.ClientEphPK, req.ClientNonce)
	if !e2ee.VerifyProof(expectedProof, req.Proof) {
		respondError(w, http.StatusForbidden, errInvalidRequest("e2ee_proof_invalid"))
		return
	}
	nodePriv, nodeEphPK, err := e2ee.GenerateECDHKeypair()
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	clientPub, err := e2ee.DecodePublicKey(req.ClientEphPK)
	if err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid client_eph_pk"))
		return
	}
	serverNonceBytes := make([]byte, 16)
	if _, err := rand.Read(serverNonceBytes); err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	serverNonce := base64.StdEncoding.EncodeToString(serverNonceBytes)
	derived, err := e2ee.DeriveKey(manager.PairingSecret(), req.NodeID, req.ClientEphPK, nodeEphPK, req.ClientNonce, serverNonce, nodePriv, clientPub)
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	if _, err := manager.OpenSessionForClient(req.ClientID, derived); err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"node_eph_pk":  nodeEphPK,
		"server_nonce": serverNonce,
		"server_proof": e2ee.BuildAcceptProof(manager.PairingSecret(), req.NodeID, req.ClientEphPK, nodeEphPK, req.ClientNonce, serverNonce),
	})
}

func managedDirResponse(dir fs.RootInfo) map[string]any {
	resp := map[string]any{
		"id":           dir.ID,
		"display_name": dir.Name,
		"root_path":    dir.RootPath,
		"created_at":   dir.CreatedAt,
		"updated_at":   dir.UpdatedAt,
	}
	if info, err := dir.StatRoot(); err == nil {
		resp["size"] = info.Size()
		resp["mtime"] = info.ModTime().UTC().Format(time.RFC3339Nano)
	}
	if ok, err := gitview.HasRepo(context.Background(), dir.RootPath); err == nil {
		resp["is_git_repo"] = ok
	}
	if ok, err := gitview.IsWorktree(dir.RootPath); err == nil {
		resp["is_git_worktree"] = ok
	}
	return resp
}

const indexHTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MindFS</title>
    <style>
      :root {
        color-scheme: light;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Helvetica Neue", Arial, sans-serif;
        background: #f7f7f5;
        color: #222;
      }
      .notice {
        display: none;
        margin: 12px;
        padding: 10px 12px;
        border: 1px solid #d8b4b4;
        border-radius: 6px;
        background: #fff5f5;
        color: #8a1f1f;
        font-size: 13px;
        line-height: 1.45;
      }
      .notice.is-visible {
        display: block;
      }
      .shell {
        display: grid;
        grid-template-columns: 260px 1fr;
        grid-template-rows: 1fr 64px;
        height: 100vh;
        background: #fff;
      }
      aside {
        grid-row: 1 / span 2;
        border-right: 1px solid #e5e5e5;
        padding: 12px;
        overflow: auto;
        background: linear-gradient(180deg, #faf9f6 0%, #ffffff 100%);
      }
      main {
        padding: 16px;
        overflow: auto;
      }
      footer {
        border-top: 1px solid #e5e5e5;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .file-button {
        display: block;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        padding: 4px 0;
        cursor: pointer;
        color: #333;
      }
      .card {
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        padding: 10px 12px;
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        background: #fff;
      }
      .status {
        font-size: 12px;
        color: #666;
      }
      input[type="text"] {
        flex: 1;
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid #ccc;
      }
      button {
        padding: 8px 12px;
        border-radius: 6px;
        border: 1px solid #ccc;
        background: #f5f5f5;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    __FALLBACK_NOTICE__
    <div class="shell">
      <aside>
        <h3>Files</h3>
        <div id="tree">加载中...</div>
      </aside>
      <main>
        <h2 style="margin-top: 0;">Workspace</h2>
        <div id="list"></div>
      </main>
      <footer>
        <input type="text" placeholder="Ask or type a command..." />
        <button type="button">Run</button>
        <span class="status" id="status">Connected</span>
      </footer>
    </div>
    <script>
      var root = new URLSearchParams(window.location.search).get("root") || "";
      fetch("/api/tree?" + new URLSearchParams({ root: root, dir: "." }).toString())
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          var tree = Array.isArray(payload) ? payload : (Array.isArray(payload.entries) ? payload.entries : []);
          var treeEl = document.getElementById("tree");
          var listEl = document.getElementById("list");
          treeEl.innerHTML = "";
          listEl.innerHTML = "";
          tree.forEach(function (entry) {
            var btn = document.createElement("button");
            btn.className = "file-button";
            btn.textContent = (entry.is_dir ? "📁 " : "📄 ") + entry.name;
            treeEl.appendChild(btn);

            var card = document.createElement("div");
            card.className = "card";
            card.innerHTML = "<span>" + entry.name + "</span><span>" + (entry.is_dir ? "Folder" : "File") + "</span>";
            listEl.appendChild(card);
          });
        })
        .catch(function () {
          var treeEl = document.getElementById("tree");
          treeEl.textContent = "无法加载目录树";
        });
    </script>
  </body>
</html>`
