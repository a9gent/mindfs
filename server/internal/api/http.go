package api

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

// HTTPHandler provides REST endpoints for health, tree, file, and action.
type HTTPHandler struct {
	AppContext *AppContext
}

func (h *HTTPHandler) service() *usecase.Service {
	return &usecase.Service{Registry: h.AppContext}
}

// Routes constructs the chi router with all endpoints.
func (h *HTTPHandler) Routes() http.Handler {
	r := chi.NewRouter()
	r.Get("/", h.handleIndex)
	r.Get("/health", h.handleHealth)
	r.Get("/api/tree", h.handleTree)
	r.Get("/api/file", h.handleFile)
	r.Get("/api/sessions", h.handleSessions)
	r.Get("/api/sessions/{key}", h.handleSessionGet)
	r.Post("/api/skills/{id}/execute", h.handleSkillExecute)
	r.Get("/api/dirs", h.handleDirs)
	r.Post("/api/dirs", h.handleAddDir)

	// Directory skills API
	r.Get("/api/dirs/{id}/skills", h.handleDirSkills)

	// Agent status API
	r.Get("/api/agents", h.handleAgentsList)

	return r
}

func (h *HTTPHandler) handleSessions(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	uc := h.service()
	out, err := uc.ListSessions(r.Context(), usecase.ListSessionsInput{RootID: rootID})
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

func (h *HTTPHandler) handleSessionGet(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	key := chi.URLParam(r, "key")
	if strings.TrimSpace(key) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("session key required"))
		return
	}
	uc := h.service()
	out, err := uc.GetSession(r.Context(), usecase.GetSessionInput{
		RootID: rootID,
		Key:    key,
	})
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	clientID := strings.TrimSpace(r.URL.Query().Get("client_id"))
	if h.AppContext != nil {
		h.AppContext.GetSessionStreamHub().BindSessionClient(key, clientID)
	}
	respondJSON(w, http.StatusOK, sessionResponse(out))
}

func sessionResponse(s *session.Session) map[string]any {
	if s == nil {
		return map[string]any{}
	}
	return map[string]any{
		"key":           s.Key,
		"type":          s.Type,
		"agent":         session.InferAgentFromSession(s),
		"name":          s.Name,
		"exchanges":     s.Exchanges,
		"related_files": s.RelatedFiles,
		"created_at":    s.CreatedAt,
		"updated_at":    s.UpdatedAt,
		"closed_at":     s.ClosedAt,
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
		"name":       s.Name,
		"created_at": s.CreatedAt,
		"updated_at": s.UpdatedAt,
		"closed_at":  s.ClosedAt,
	}
}

func (h *HTTPHandler) handleSkillExecute(w http.ResponseWriter, r *http.Request) {
	rootID := r.URL.Query().Get("root")
	skillID := chi.URLParam(r, "id")
	if strings.TrimSpace(skillID) == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("skill id required"))
		return
	}
	var req struct {
		Params map[string]any `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.ExecuteSkill(r.Context(), usecase.ExecuteSkillInput{
		RootID:  rootID,
		SkillID: skillID,
		Params:  req.Params,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Result)
}

func (h *HTTPHandler) handleAgentsList(w http.ResponseWriter, r *http.Request) {
	if h.AppContext == nil || h.AppContext.GetProber() == nil {
		respondJSON(w, http.StatusOK, []map[string]any{})
		return
	}
	statuses := h.AppContext.GetProber().GetAllStatuses()
	respondJSON(w, http.StatusOK, statuses)
}

func (h *HTTPHandler) handleIndex(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(indexHTML))
}

func (h *HTTPHandler) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
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
	raw := r.URL.Query().Get("raw")
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
		w.WriteHeader(http.StatusOK)
		io.Copy(w, rawOut.File)
		return
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
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json"))
		return
	}
	uc := h.service()
	out, err := uc.AddManagedDir(r.Context(), usecase.AddManagedDirInput{Path: req.Path})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, managedDirResponse(out.Dir))
}

func (h *HTTPHandler) handleDirSkills(w http.ResponseWriter, r *http.Request) {
	rootID := chi.URLParam(r, "id")
	uc := h.service()
	out, err := uc.ListDirectorySkills(r.Context(), usecase.ListDirectorySkillsInput{
		RootID: rootID,
	})
	if err != nil {
		respondError(w, http.StatusNotFound, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Skills)
}

func managedDirResponse(dir fs.RootInfo) map[string]any {
	return map[string]any{
		"id":           dir.ID,
		"display_name": dir.Name,
		"created_at":   dir.CreatedAt,
		"updated_at":   dir.UpdatedAt,
	}
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
