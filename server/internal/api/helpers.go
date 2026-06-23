package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"mindfs/server/internal/apperr"
)

func respondJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func respondError(w http.ResponseWriter, status int, err error) {
	payload := map[string]any{"error": err.Error()}
	if appErr, ok := apperr.Classify(err); ok {
		payload["code"] = appErr.Code
		payload["message"] = appErr.Message
		if appErr.Op != "" {
			payload["operation"] = appErr.Op
		}
		if appErr.Path != "" {
			payload["path"] = appErr.Path
		}
		if appErr.Detail != "" {
			payload["detail"] = appErr.Detail
		}
	}
	respondJSON(w, status, payload)
}

func errInvalidRequest(message string) error {
	return errors.New(message)
}

func errServiceUnavailable(message string) error {
	return errors.New(message)
}
