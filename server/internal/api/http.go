package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/gitview"
	"mindfs/server/internal/session"

	"github.com/go-chi/chi/v5"
)

// HTTPHandler provides REST endpoints for health, tree, file, and action.
type HTTPHandler struct {
	AppContext *AppContext
	StaticDir  string
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
	e2eeHeaderName        = "X-MindFS-E2EE"
	clientIDHeaderName    = "X-MindFS-Client-ID"
	e2eeProofHeaderName   = "X-MindFS-Proof"
	e2eeTSHeaderName      = "X-MindFS-TS"
	fileProofMaxSkew      = 5 * time.Minute
)

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

func (h *HTTPHandler) requireFileProof(r *http.Request) error {
	manager := h.AppContext.GetE2EEManager()
	if manager == nil || !manager.Enabled() {
		return nil
	}
	clientID := strings.TrimSpace(r.Header.Get(clientIDHeaderName))
	ts := strings.TrimSpace(r.Header.Get(e2eeTSHeaderName))
	proof := strings.TrimSpace(r.Header.Get(e2eeProofHeaderName))
	if clientID == "" || ts == "" || proof == "" {
		return errInvalidRequest("e2ee_proof_required")
	}
	sess, err := manager.SessionForClient(clientID)
	if err != nil {
		return errInvalidRequest(err.Error())
	}
	timestamp, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return errInvalidRequest("invalid_e2ee_ts")
	}
	now := time.Now().UTC()
	if timestamp.Before(now.Add(-fileProofMaxSkew)) || timestamp.After(now.Add(fileProofMaxSkew)) {
		return errInvalidRequest("e2ee_proof_expired")
	}
	expected := e2ee.BuildRequestProof(sess.Key, r.Method, requestProofPath(r), ts, clientID)
	if !e2ee.VerifyProof(expected, proof) {
		return errInvalidRequest("e2ee_proof_invalid")
	}
	return nil
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
		sess, protected, err := h.requireProtectedHTTPSession(r)
		if !protected {
			next(w, r)
			return
		}
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

func (h *HTTPHandler) broadcastRootChanged(action, rootID string) {
	if h.AppContext == nil {
		return
	}
	h.AppContext.GetSessionStreamHub().BroadcastAll(WSResponse{
		Type: "root.changed",
		Payload: map[string]any{
			"action":  action,
			"root_id": rootID,
		},
	})
}

// Routes constructs the chi router with all endpoints.
func (h *HTTPHandler) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.handleFrontend)
	r.Get("/health", h.handleHealth)
	r.Get("/api/tree", h.handleTree)
	r.Get("/api/file", h.handleFile)
	r.Get("/api/git/status", h.handleGitStatus)
	r.Get("/api/git/diff", h.handleGitDiff)
	r.Post("/api/upload", h.handleUpload)
	r.Get("/api/candidates", h.handleCandidates)
	r.Post("/api/prompts", h.handlePromptSave)
	r.Get("/api/sessions", h.handleSessions)
	r.Get("/api/sessions/search", h.handleSessionSearch)
	r.Get("/api/sessions/external", h.handleExternalSessionsList)
	r.Post("/api/sessions/import", h.handleExternalSessionImport)
	r.Get("/api/sessions/{key}", h.protectedEndpoint(h.handleSessionGet))
	r.Get("/api/sessions/{key}/related-files", h.handleSessionRelatedFilesGet)
	r.Post("/api/sessions/{key}/rename", h.handleSessionRename)
	r.Delete("/api/sessions/{key}/related-files", h.handleSessionRelatedFilesDelete)
	r.Delete("/api/sessions/{key}", h.handleSessionDelete)
	r.Get("/api/dirs", h.handleDirs)
	r.Post("/api/dirs", h.handleAddDir)
	r.Delete("/api/dirs", h.handleRemoveDir)
	r.Get("/api/local_dirs", h.handleLocalDirs)
	r.Get("/api/relay/status", h.handleRelayStatus)
	r.Get("/api/relay/tips", h.handleRelayTips)
	r.Post("/api/e2ee/open", h.handleE2EEOpen)
	r.Get("/api/app/update", h.handleAppUpdateGet)
	r.Post("/api/app/update", h.handleAppUpdatePost)
	r.Post("/api/imports/github", h.handleGitHubImportStart)

	// Agent status API
	r.Get("/api/agents", h.handleAgentsList)
	r.NotFound(h.handleNotFound)

	return r
}

func (h *HTTPHandler) handleSessions(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
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
	uc := h.service()
	out, err := uc.ListSessions(r.Context(), usecase.ListSessionsInput{
		RootID:     rootID,
		BeforeTime: beforeTime,
		AfterTime:  afterTime,
		Limit:      sessionListPageSize,
	})
	if err != nil {
		respondError(w, http.StatusServiceUnavailable, err)
		return
	}
	payload := make([]map[string]any, 0, len(out.Sessions))
	for _, s := range out.Sessions {
		payload = append(payload, sessionListResponse(s))
	}
	respondJSON(w, http.StatusOK, payload)
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
	out, err := uc.GetSession(r.Context(), usecase.GetSessionInput{
		RootID: rootID,
		Key:    key,
		Seq:    afterSeq,
	})
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	var pendingUser *session.Exchange
	if h.AppContext != nil {
		pendingUser = h.AppContext.GetSessionStreamHub().GetPendingUserExchange(key)
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
	respondJSON(w, http.StatusOK, sessionResponse(out, pendingUser, contextWindow, exchangeAux))
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
					"key":        renamed.Key,
					"name":       renamed.Name,
					"model":      renamed.Model,
					"mode":       session.InferModeFromSession(renamed),
					"effort":     session.InferEffortFromSession(renamed),
					"updated_at": renamed.UpdatedAt,
				},
			},
		})
	}
	respondJSON(w, http.StatusOK, sessionListResponse(renamed))
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

func sessionResponse(
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
		"key":            s.Key,
		"type":           s.Type,
		"agent":          session.InferAgentFromSession(s),
		"model":          s.Model,
		"mode":           session.InferModeFromSession(s),
		"effort":         session.InferEffortFromSession(s),
		"name":           s.Name,
		"exchanges":      exchanges,
		"exchange_aux":   auxPayload,
		"related_files":  s.RelatedFiles,
		"context_window": contextWindow,
		"created_at":     s.CreatedAt,
		"updated_at":     s.UpdatedAt,
		"closed_at":      s.ClosedAt,
	}
}

func sessionListResponse(s *session.Session) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	return map[string]any{
		"key":        s.Key,
		"type":       s.Type,
		"agent":      session.InferAgentFromSession(s),
		"model":      s.Model,
		"mode":       session.InferModeFromSession(s),
		"effort":     session.InferEffortFromSession(s),
		"name":       s.Name,
		"created_at": s.CreatedAt,
		"updated_at": s.UpdatedAt,
		"closed_at":  s.ClosedAt,
	}
}

func externalSessionListResponse(s agenttypes.ExternalSessionSummary) map[string]any {
	name := strings.TrimSpace(s.FirstUserText)
	if name == "" {
		name = s.AgentSessionID
	}
	return map[string]any{
		"key":              s.AgentSessionID,
		"type":             session.TypeChat,
		"agent":            s.Agent,
		"model":            "",
		"name":             name,
		"created_at":       s.UpdatedAt,
		"updated_at":       s.UpdatedAt,
		"closed_at":        nil,
		"agent_session_id": s.AgentSessionID,
	}
}

func (h *HTTPHandler) handleAgentsList(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetProber() == nil {
		log.Printf("[http] agents.list.short_circuit returning_empty_array")
		respondJSON(w, http.StatusOK, []map[string]any{})
		return
	}
	statuses := h.AppContext.GetProber().GetInstalledStatuses()
	if prefs := h.AppContext.GetPreferences(); prefs != nil {
		statuses = prefs.ApplyAgentDefaults(statuses)
	}
	respondJSON(w, http.StatusOK, statuses)
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
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
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
	if isRelayedRequest(r) {
		w.Write([]byte(rewriteRelayedFrontendContent(indexHTML)))
		return
	}
	w.Write([]byte(indexHTML))
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
	if info, err := os.Stat(assetPath); err == nil && !info.IsDir() {
		applyStaticCacheHeaders(w, cleanPath)
		if isRelayedRequest(r) && shouldRewriteRelayedStaticAsset(cleanPath) {
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
		http.ServeFile(w, r, indexPath)
		return true
	}

	return false
}

func applyStaticCacheHeaders(w http.ResponseWriter, cleanPath string) {
	switch cleanPath {
	case "service-worker.js", "index.html":
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	}
}

func isRelayedRequest(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("X-MindFS-Relayed")) == "1"
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
	cleaned := filepath.Clean("/" + requestPath)
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
	if err := h.requireFileProof(r); err != nil {
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
	respondJSON(w, http.StatusOK, map[string]any{
		"file": out.File,
	})
}

func (h *HTTPHandler) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	uc := h.service()
	out, err := uc.GetGitStatus(r.Context(), usecase.GitStatusInput{RootID: rootID})
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

func (h *HTTPHandler) handleUpload(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if err := h.requireFileProof(r); err != nil {
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
	respondJSON(w, http.StatusOK, map[string]any{
		"files": out.Files,
	})
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
		respondError(w, http.StatusBadRequest, err)
		return
	}
	if h.AppContext != nil {
		h.broadcastRootChanged("added", out.Dir.ID)
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

func (h *HTTPHandler) handleRelayStatus(w http.ResponseWriter, _ *http.Request) {
	manager := h.AppContext.GetRelayManager()
	if manager == nil {
		respondError(w, http.StatusServiceUnavailable, errServiceUnavailable("relay manager not configured"))
		return
	}
	status := manager.Status()
	if e2eeManager := h.AppContext.GetE2EEManager(); e2eeManager != nil {
		status.E2EERequired = e2eeManager.Enabled()
		if status.E2EERequired {
			status.E2EENodeID = e2eeManager.NodeID()
			if strings.TrimSpace(status.NodeID) == "" {
				status.NodeID = e2eeManager.NodeID()
			}
		}
	}
	respondJSON(w, http.StatusOK, status)
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
      fetch("/api/tree?dir=.")
        .then(function (res) { return res.json(); })
        .then(function (payload) {
          var tree = Array.isArray(payload) ? payload : [];
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
