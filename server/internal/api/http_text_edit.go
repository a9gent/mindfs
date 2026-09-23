package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"

	"mindfs/server/internal/fs"
)

func respondFileEditError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var bodyTooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &bodyTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, fs.ErrFileConflict), errors.Is(err, os.ErrExist):
		status = http.StatusConflict
	case errors.Is(err, fs.ErrFileTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, os.ErrNotExist):
		status = http.StatusNotFound
	case errors.Is(err, os.ErrPermission):
		status = http.StatusForbidden
	}
	respondError(w, status, err)
}

func (h *HTTPHandler) handleEditableFile(w http.ResponseWriter, r *http.Request) {
	file, err := h.service().ReadEditableFile(r.Context(), r.URL.Query().Get("root"), r.URL.Query().Get("path"))
	if err != nil {
		respondFileEditError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	respondJSON(w, http.StatusOK, map[string]any{"file": file})
}

func (h *HTTPHandler) handleFileSave(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Content      *string `json:"content"`
		BaseRevision string  `json:"base_revision"`
	}
	// JSON escaping can use six bytes for each source byte.
	r.Body = http.MaxBytesReader(w, r.Body, 6*fs.MaxEditableFileBytes+1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&input); err != nil {
		respondFileEditError(w, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		respondError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	if input.Content == nil {
		respondError(w, http.StatusBadRequest, errors.New("content required"))
		return
	}
	file, err := h.service().WriteEditableFile(r.URL.Query().Get("root"), r.URL.Query().Get("path"), *input.Content, input.BaseRevision)
	if err != nil {
		respondFileEditError(w, err)
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"file": file})
}

func (h *HTTPHandler) handleFileCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Dir  string `json:"dir"`
		Name string `json:"name"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&input); err != nil {
		respondFileEditError(w, err)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		respondError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	path, err := h.service().CreateBlankFile(r.URL.Query().Get("root"), input.Dir, input.Name)
	if err != nil {
		respondFileEditError(w, err)
		return
	}
	respondJSON(w, http.StatusCreated, map[string]any{"path": path})
}
