package agent

import (
	"context"

	"mindfs/server/internal/agent/unified"
)

// Process is the unified interface for all agent processes.
type Process interface {
	// SendMessage sends a message and streams responses via callback.
	SendMessage(ctx context.Context, content string, onUpdate func(unified.SessionUpdate)) error

	// SessionID returns the current session ID.
	SessionID() string

	// Close terminates the session (not the process).
	Close() error
}

// StreamChunk is the legacy streaming chunk type for backward compatibility.
type StreamChunk struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"`
	Tool    string `json:"tool,omitempty"`
	Path    string `json:"path,omitempty"`
	Size    int64  `json:"size,omitempty"`
	Percent int    `json:"percent,omitempty"`
}
