package api

import (
	"encoding/json"
	"errors"
	"net/http"
)

func respondJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func respondError(w http.ResponseWriter, status int, err error) {
	respondJSON(w, status, map[string]any{"error": err.Error()})
}

func errInvalidRequest(message string) error {
	return errors.New(message)
}

func errServiceUnavailable(message string) error {
	return errors.New(message)
}
