package session

import (
	"strings"
	"time"
)

const (
	TypeChat = "chat"
	TypeView = "view"
)

type Session struct {
	Key          string         `json:"key"`
	Type         string         `json:"type"`
	AgentCtxSeq  map[string]int `json:"agent_ctx_seq,omitempty"`
	Model        string         `json:"model,omitempty"`
	Name         string         `json:"name"`
	Exchanges    []Exchange     `json:"exchanges"`
	RelatedFiles []RelatedFile  `json:"related_files"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
	ClosedAt     *time.Time     `json:"closed_at,omitempty"`
}

type Exchange struct {
	Seq       int       `json:"seq"`
	Role      string    `json:"role"`
	Agent     string    `json:"agent,omitempty"`
	Model     string    `json:"model,omitempty"`
	Effort    string    `json:"effort,omitempty"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
}

type RelatedFile struct {
	Path             string `json:"path"`
	Relation         string `json:"relation"`
	CreatedBySession bool   `json:"created_by_session"`
}

// InferAgentFromSession derives the display agent from session data.
func InferAgentFromSession(s *Session) string {
	if s == nil {
		return ""
	}
	for i := len(s.Exchanges) - 1; i >= 0; i-- {
		if agent := strings.TrimSpace(s.Exchanges[i].Agent); agent != "" {
			return agent
		}
	}
	if len(s.AgentCtxSeq) == 1 {
		for agent := range s.AgentCtxSeq {
			return agent
		}
	}
	return ""
}

// InferEffortFromSession derives the latest non-empty effort from session data.
func InferEffortFromSession(s *Session) string {
	if s == nil || len(s.Exchanges) == 0 {
		return ""
	}
	return strings.TrimSpace(s.Exchanges[len(s.Exchanges)-1].Effort)
}
