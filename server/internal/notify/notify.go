package notify

import (
	"fmt"
	"net/url"
	"strings"
)

const BodyMaxRunes = 600

type Payload struct {
	Type               string         `json:"type"`
	Title              string         `json:"title"`
	Body               string         `json:"body,omitempty"`
	Tag                string         `json:"tag,omitempty"`
	URL                string         `json:"url,omitempty"`
	Icon               string         `json:"icon,omitempty"`
	Badge              string         `json:"badge,omitempty"`
	Renotify           bool           `json:"renotify,omitempty"`
	RequireInteraction bool           `json:"requireInteraction,omitempty"`
	Data               map[string]any `json:"data,omitempty"`
}

type SessionNotification struct {
	Type         string
	RootID       string
	RootTitle    string
	SessionKey   string
	SessionTitle string
	Summary      string
	EventID      string
}

type ScheduledNotification struct {
	RootID     string
	RootTitle  string
	TaskID     string
	TaskName   string
	SessionKey string
	Summary    string
	Error      string
	Success    bool
	EventID    string
}

func BuildSessionPayload(in SessionNotification) Payload {
	kind := strings.TrimSpace(in.Type)
	if kind == "" {
		kind = "session.done"
	}
	status := "完成"
	if kind == "session.ask_user" {
		status = "需要输入"
	}
	root := firstNonEmpty(in.RootTitle, in.RootID, "MindFS")
	sessionTitle := firstNonEmpty(in.SessionTitle, "会话")
	title := fmt.Sprintf("%s · %s · %s", root, sessionTitle, status)
	body := truncateRunes(strings.TrimSpace(in.Summary), BodyMaxRunes)
	tag := fmt.Sprintf("mindfs:%s:%s:%s", kind, in.RootID, in.SessionKey)
	eventID := firstNonEmpty(in.EventID, tag)
	if kind == "session.done" {
		tag = fmt.Sprintf("mindfs:%s:%s:%s:%s", kind, in.RootID, in.SessionKey, eventID)
	}
	return Payload{
		Type:               kind,
		Title:              title,
		Body:               body,
		Tag:                tag,
		URL:                sessionURL(in.RootID, in.SessionKey),
		Icon:               "./pwa-192.png",
		Badge:              "./pwa-192.png",
		Renotify:           kind == "session.ask_user" || kind == "session.done",
		RequireInteraction: kind == "session.ask_user",
		Data: map[string]any{
			"type":       kind,
			"rootId":     in.RootID,
			"sessionKey": in.SessionKey,
			"eventId":    eventID,
		},
	}
}

func BuildScheduledPayload(in ScheduledNotification) Payload {
	root := firstNonEmpty(in.RootTitle, in.RootID, "MindFS")
	status := "定时任务完成"
	kind := "scheduled.done"
	body := strings.TrimSpace(in.Summary)
	renotify := false
	if !in.Success {
		status = "定时任务失败"
		kind = "scheduled.failed"
		body = strings.TrimSpace(in.Error)
		renotify = true
	}
	taskName := firstNonEmpty(in.TaskName, "未命名任务")
	if body == "" {
		body = taskName
	} else {
		body = taskName + ": " + body
	}
	tag := fmt.Sprintf("mindfs:%s:%s:%s", kind, in.RootID, in.TaskID)
	return Payload{
		Type:               kind,
		Title:              fmt.Sprintf("%s · %s", root, status),
		Body:               truncateRunes(body, BodyMaxRunes),
		Tag:                tag,
		URL:                sessionURL(in.RootID, in.SessionKey),
		Icon:               "./pwa-192.png",
		Badge:              "./pwa-192.png",
		Renotify:           renotify,
		RequireInteraction: !in.Success,
		Data: map[string]any{
			"type":       kind,
			"rootId":     in.RootID,
			"sessionKey": in.SessionKey,
			"taskId":     in.TaskID,
			"eventId":    firstNonEmpty(in.EventID, tag),
		},
	}
}

func EventID(payload Payload) string {
	if payload.Data != nil {
		if value, ok := payload.Data["eventId"].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return strings.TrimSpace(payload.Tag)
}

func sessionURL(rootID, sessionKey string) string {
	params := make([]string, 0, 2)
	if strings.TrimSpace(rootID) != "" {
		params = append(params, "root="+url.QueryEscape(rootID))
	}
	if strings.TrimSpace(sessionKey) != "" {
		params = append(params, "session="+url.QueryEscape(sessionKey))
	}
	if len(params) == 0 {
		return "./"
	}
	return "./?" + strings.Join(params, "&")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateRunes(value string, max int) string {
	value = strings.TrimSpace(value)
	if max <= 0 || value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return "..." + string(runes[len(runes)-max:])
}
