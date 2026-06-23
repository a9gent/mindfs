package session

import (
	"strings"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

const (
	TypeChat    = "chat"
	TypeView    = "view"
	TypeCommand = "command"
)

type Session struct {
	Key              string         `json:"key"`
	Type             string         `json:"type"`
	ParentSessionKey string         `json:"parent_session_key,omitempty"`
	ParentToolCallID string         `json:"parent_tool_call_id,omitempty"`
	Source           string         `json:"source,omitempty"`
	AgentCtxSeq      map[string]int `json:"agent_ctx_seq,omitempty"`
	Model            string         `json:"model,omitempty"`
	Shell            string         `json:"shell,omitempty"`
	PlanMode         bool           `json:"plan_mode,omitempty"`
	Name             string         `json:"name"`
	Exchanges        []Exchange     `json:"exchanges"`
	RelatedFiles     []RelatedFile  `json:"related_files"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
	ClosedAt         *time.Time     `json:"closed_at,omitempty"`
}

type Exchange struct {
	Seq              int       `json:"seq"`
	Role             string    `json:"role"`
	Agent            string    `json:"agent,omitempty"`
	Model            string    `json:"model,omitempty"`
	ModelDisplayName string    `json:"model_display_name,omitempty"`
	Mode             string    `json:"mode,omitempty"`
	Effort           string    `json:"effort,omitempty"`
	FastService      string    `json:"fast_service,omitempty"`
	Content          string    `json:"content"`
	Timestamp        time.Time `json:"timestamp"`
}

type ExchangeAux struct {
	Seq       int                       `json:"seq"`
	Line      int                       `json:"line"`
	ToolCall  *agenttypes.ToolCall      `json:"toolcall,omitempty"`
	Thought   string                    `json:"thought,omitempty"`
	ThoughtID string                    `json:"thought_id,omitempty"`
	Plan      *agenttypes.PlanUpdate    `json:"plan,omitempty"`
	Compact   *agenttypes.CompactNotice `json:"compact,omitempty"`
}

func CompactExchangeAux(aux ExchangeAux) (ExchangeAux, bool) {
	if aux.ToolCall == nil {
		if aux.Plan != nil || aux.Compact != nil {
			return aux, true
		}
		return ExchangeAux{}, false
	}

	toolCall := CompactToolCall(*aux.ToolCall)
	aux.ToolCall = &toolCall
	aux.Thought = ""
	return aux, true
}

func CompactToolCall(toolCall agenttypes.ToolCall) agenttypes.ToolCall {
	preserveContent := PreserveToolCallContent(toolCall.Kind)
	switch {
	case preserveContent:
	case PreserveCommandExecutionContent(toolCall):
		toolCall.Content = truncateToolCallContent(toolCall.Content, maxExecToolCallContentBytes)
	default:
		toolCall.Content = nil
	}
	if !preserveContent {
		toolCall.Meta = compactToolCallMeta(toolCall.Meta)
	}
	return toolCall
}

func compactToolCallMeta(meta map[string]any) map[string]any {
	if len(meta) == 0 {
		return meta
	}
	out := make(map[string]any, len(meta))
	for key, value := range meta {
		switch key {
		case "output":
			continue
		default:
			out[key] = value
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func PreserveToolCallContent(kind agenttypes.ToolKind) bool {
	switch kind {
	case agenttypes.ToolKindEdit,
		agenttypes.ToolKindDelete,
		agenttypes.ToolKindMove,
		agenttypes.ToolKindAskUser,
		agenttypes.ToolKindTodo,
		agenttypes.ToolKindTask:
		return true
	default:
		return false
	}
}

const maxExecToolCallContentBytes = 128 * 1024
const truncationMarker = "\n...(truncated)"

func PreserveCommandExecutionContent(toolCall agenttypes.ToolCall) bool {
	if toolCall.Kind != agenttypes.ToolKindExecute || toolCall.RawType != "commandExecution" {
		return false
	}
	if toolCall.Meta == nil {
		return false
	}
	source, _ := toolCall.Meta["source"].(string)
	return strings.EqualFold(strings.TrimSpace(source), "userShell")
}

func InferCommandShellFromAux(aux map[int][]ExchangeAux) string {
	bestSeq := 0
	shell := ""
	for seq, items := range aux {
		if seq < bestSeq {
			continue
		}
		for _, item := range items {
			if item.ToolCall == nil || item.ToolCall.Meta == nil {
				continue
			}
			toolCall := item.ToolCall
			if toolCall.Kind != agenttypes.ToolKindExecute || toolCall.RawType != "commandExecution" {
				continue
			}
			source, _ := toolCall.Meta["source"].(string)
			phase, _ := toolCall.Meta["phase"].(string)
			value, _ := toolCall.Meta["shell"].(string)
			value = strings.TrimSpace(value)
			if !strings.EqualFold(strings.TrimSpace(source), "userShell") || strings.TrimSpace(phase) != "final" || value == "" {
				continue
			}
			bestSeq = seq
			shell = value
		}
	}
	return shell
}

func truncateToolCallContent(items []agenttypes.ToolCallContentItem, maxBytes int) []agenttypes.ToolCallContentItem {
	if maxBytes <= 0 || len(items) == 0 {
		return nil
	}
	out := make([]agenttypes.ToolCallContentItem, 0, len(items))
	remaining := maxBytes
	for _, item := range items {
		if remaining <= 0 {
			break
		}
		if item.Type == "text" {
			limit := remaining
			if len(item.Text) > limit {
				if remaining <= len(truncationMarker) {
					item.Text = truncationMarker[:remaining]
					out = append(out, item)
					break
				}
				limit -= len(truncationMarker)
			}
			text, used, truncated := truncateStringBytes(item.Text, limit)
			item.Text = text
			remaining -= used
			if truncated {
				item.Text += truncationMarker
				out = append(out, item)
				break
			}
		}
		out = append(out, item)
	}
	return out
}

func truncateStringBytes(value string, maxBytes int) (string, int, bool) {
	if maxBytes <= 0 {
		return "", 0, value != ""
	}
	if len(value) <= maxBytes {
		return value, len(value), false
	}
	end := maxBytes
	for end > 0 && (value[end]&0xC0) == 0x80 {
		end--
	}
	if end == 0 {
		return "", 0, true
	}
	return value[:end], end, true
}

type RelatedFile struct {
	Path             string `json:"path"`
	Relation         string `json:"relation"`
	CreatedBySession bool   `json:"created_by_session"`
}

type SearchOptions struct {
	Query string
	Limit int
}

type SearchHit struct {
	Key              string     `json:"key"`
	Type             string     `json:"type"`
	ParentSessionKey string     `json:"parent_session_key,omitempty"`
	ParentToolCallID string     `json:"parent_tool_call_id,omitempty"`
	Agent            string     `json:"agent,omitempty"`
	Model            string     `json:"model,omitempty"`
	Shell            string     `json:"shell,omitempty"`
	Name             string     `json:"name"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	ClosedAt         *time.Time `json:"closed_at,omitempty"`
	MatchType        string     `json:"match_type"`
	MatchScore       int        `json:"match_score"`
	Seq              int        `json:"seq"`
	Snippet          string     `json:"snippet,omitempty"`
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

// InferFastServiceFromSession derives the latest fast-service setting from session data.
func InferFastServiceFromSession(s *Session) string {
	if s == nil || len(s.Exchanges) == 0 {
		return ""
	}
	return strings.TrimSpace(s.Exchanges[len(s.Exchanges)-1].FastService)
}

// InferModeFromSession derives the latest non-empty mode from session data.
func InferModeFromSession(s *Session) string {
	if s == nil || len(s.Exchanges) == 0 {
		return ""
	}
	return strings.TrimSpace(s.Exchanges[len(s.Exchanges)-1].Mode)
}
