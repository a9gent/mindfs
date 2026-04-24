package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
)

type ImporterOptions struct {
	AgentName string
}

type Importer struct {
	agentName string
	baseDir   string
	mu        sync.RWMutex
	index     map[string]codexSessionFile
}

type codexSessionFile struct {
	Path           string
	AgentSessionID string
	Cwd            string
	FirstUserText  string
	UpdatedAt      time.Time
}

func NewImporter(opts ImporterOptions) *Importer {
	home, _ := os.UserHomeDir()
	return &Importer{
		agentName: strings.TrimSpace(opts.AgentName),
		baseDir:   filepath.Join(strings.TrimSpace(home), ".codex", "sessions"),
		index:     make(map[string]codexSessionFile),
	}
}

func (i *Importer) AgentName() string {
	return i.agentName
}

func (i *Importer) ListExternalSessions(_ context.Context, in agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	files, err := i.scanSessionFiles(in.BeforeTime, in.AfterTime, limit)
	if err != nil {
		return agenttypes.ListExternalSessionsResult{}, err
	}

	items := make([]agenttypes.ExternalSessionSummary, 0, len(files))
	for _, item := range files {
		items = append(items, agenttypes.ExternalSessionSummary{
			Agent:          i.agentName,
			AgentSessionID: item.AgentSessionID,
			Cwd:            item.Cwd,
			FirstUserText:  item.FirstUserText,
			UpdatedAt:      item.UpdatedAt,
		})
	}

	return agenttypes.ListExternalSessionsResult{Items: items}, nil
}

func (i *Importer) ImportExternalSession(_ context.Context, in agenttypes.ImportExternalSessionInput) (agenttypes.ImportedExternalSession, error) {
	rootPath := normalizeComparablePath(in.RootPath)
	if rootPath == "" {
		return agenttypes.ImportedExternalSession{}, errors.New("root path required")
	}
	targetID := strings.TrimSpace(in.AgentSessionID)
	if targetID == "" {
		return agenttypes.ImportedExternalSession{}, errors.New("agent session id required")
	}
	if file, ok := i.lookupSessionFile(targetID, rootPath); ok {
		exchanges, err := readCodexImportedExchanges(file.Path)
		if err != nil {
			log.Printf("[agent/codex/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
			return agenttypes.ImportedExternalSession{}, err
		}
		return agenttypes.ImportedExternalSession{
			Agent:          i.agentName,
			AgentSessionID: targetID,
			Cwd:            file.Cwd,
			Exchanges:      exchanges,
		}, nil
	}
	files, err := i.scanSessionFiles(time.Time{}, time.Time{}, int(^uint(0)>>1))
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	for _, file := range files {
		if file.AgentSessionID != targetID {
			continue
		}
		exchanges, err := readCodexImportedExchanges(file.Path)
		if err != nil {
			log.Printf("[agent/codex/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
			return agenttypes.ImportedExternalSession{}, err
		}
		return agenttypes.ImportedExternalSession{
			Agent:          i.agentName,
			AgentSessionID: targetID,
			Cwd:            file.Cwd,
			Exchanges:      exchanges,
		}, nil
	}
	return agenttypes.ImportedExternalSession{}, errors.New("external session not found")
}

func (i *Importer) scanSessionFiles(before, after time.Time, limit int) ([]codexSessionFile, error) {
	if strings.TrimSpace(i.baseDir) == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	items := make([]codexSessionFile, 0)
	err := filepath.WalkDir(i.baseDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d == nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		item, ok, err := inspectCodexSessionFile(path)
		if err != nil {
			log.Printf("[agent/codex/importer] inspect session file failed path=%s err=%v", path, err)
			return nil
		}
		if !ok {
			return nil
		}
		if !before.IsZero() && !item.UpdatedAt.Before(before) {
			return nil
		}
		if !after.IsZero() && !item.UpdatedAt.After(after) {
			return nil
		}
		items = appendSortedCodexSession(items, item)
		if len(items) > limit {
			items = items[:limit]
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	i.storeSessionFiles(items)
	return items, nil
}

func (i *Importer) storeSessionFiles(items []codexSessionFile) {
	i.mu.Lock()
	defer i.mu.Unlock()
	for _, item := range items {
		if strings.TrimSpace(item.AgentSessionID) == "" {
			continue
		}
		i.index[item.AgentSessionID] = item
	}
}

func (i *Importer) lookupSessionFile(sessionID, rootPath string) (codexSessionFile, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	item, ok := i.index[strings.TrimSpace(sessionID)]
	if !ok {
		return codexSessionFile{}, false
	}
	if normalizeComparablePath(item.Cwd) != normalizeComparablePath(rootPath) {
		return codexSessionFile{}, false
	}
	return item, true
}

func inspectCodexSessionFile(path string) (codexSessionFile, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return codexSessionFile{}, false, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return codexSessionFile{}, false, err
	}
	var sessionID, cwd, firstUserText string
	err = forEachJSONLLine(file, func(line string) error {
		line = strings.TrimSpace(line)
		if line == "" {
			return nil
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return nil
		}
		if sessionID == "" && raw["type"] == "session_meta" {
			if payload, _ := raw["payload"].(map[string]any); payload != nil {
				sessionID = strings.TrimSpace(asString(payload["id"]))
			}
			return nil
		}
		if cwd == "" && raw["type"] == "turn_context" {
			if payload, _ := raw["payload"].(map[string]any); payload != nil {
				cwd = normalizeComparablePath(asString(payload["cwd"]))
			}
			return nil
		}
		if firstUserText == "" && raw["type"] == "response_item" {
			if payload, _ := raw["payload"].(map[string]any); payload != nil {
				if payload["type"] == "message" && strings.EqualFold(asString(payload["role"]), "user") {
					if text := extractCodexMessageText(payload["content"]); isMeaningfulCodexUserText(text) {
						firstUserText = text
					}
				}
			}
		}
		if sessionID != "" && cwd != "" && firstUserText != "" {
			return errStopJSONL
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopJSONL) {
		return codexSessionFile{}, false, err
	}
	if sessionID == "" || cwd == "" {
		return codexSessionFile{}, false, nil
	}
	return codexSessionFile{
		Path:           path,
		AgentSessionID: sessionID,
		Cwd:            cwd,
		FirstUserText:  firstUserText,
		UpdatedAt:      info.ModTime().UTC(),
	}, true, nil
}

func readCodexImportedExchanges(path string) ([]agenttypes.ImportedExchange, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	items := make([]agenttypes.ImportedExchange, 0)
	err = forEachJSONLLine(file, func(line string) error {
		line = strings.TrimSpace(line)
		if line == "" {
			return nil
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return nil
		}
		timestamp := parseTimeRFC3339(asString(raw["timestamp"]))
		switch raw["type"] {
		case "response_item":
			payload, _ := raw["payload"].(map[string]any)
			if payload == nil || payload["type"] != "message" {
				return nil
			}
			role := strings.ToLower(strings.TrimSpace(asString(payload["role"])))
			text := strings.TrimSpace(extractCodexMessageText(payload["content"]))
			switch role {
			case "user":
				if !isMeaningfulCodexUserText(text) {
					return nil
				}
				items = appendMergedExchange(items, "user", text, timestamp)
			case "assistant":
				if text == "" {
					return nil
				}
				items = appendMergedExchange(items, "agent", text, timestamp)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return items, nil
}

var errStopJSONL = errors.New("stop jsonl")

func forEachJSONLLine(file *os.File, fn func(string) error) error {
	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			if callErr := fn(string(line)); callErr != nil {
				return callErr
			}
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
}

func appendMergedExchange(items []agenttypes.ImportedExchange, role, content string, ts time.Time) []agenttypes.ImportedExchange {
	content = strings.TrimSpace(content)
	if content == "" {
		return items
	}
	if len(items) > 0 && items[len(items)-1].Role == role {
		last := &items[len(items)-1]
		last.Content = strings.TrimSpace(last.Content + "\n\n" + content)
		if !ts.IsZero() {
			last.Timestamp = ts
		}
		return items
	}
	items = append(items, agenttypes.ImportedExchange{
		Role:      role,
		Content:   content,
		Timestamp: ts,
	})
	return items
}

func extractCodexMessageText(raw any) string {
	parts, _ := raw.([]any)
	lines := make([]string, 0, len(parts))
	for _, part := range parts {
		item, _ := part.(map[string]any)
		if item == nil {
			continue
		}
		switch strings.TrimSpace(asString(item["type"])) {
		case "input_text", "output_text", "text":
			if text := strings.TrimSpace(asString(item["text"])); text != "" {
				lines = append(lines, text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n\n"))
}

func isMeaningfulCodexUserText(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	return !strings.HasPrefix(text, "# AGENTS.md instructions") &&
		!strings.HasPrefix(text, "<environment_context>") &&
		!strings.HasPrefix(text, "<permissions instructions>")
}

func appendSortedCodexSession(items []codexSessionFile, item codexSessionFile) []codexSessionFile {
	idx := sort.Search(len(items), func(i int) bool {
		return compareCodexSessionFile(item, items[i]) < 0
	})
	items = append(items, codexSessionFile{})
	copy(items[idx+1:], items[idx:])
	items[idx] = item
	return items
}

func compareCodexSessionFile(left, right codexSessionFile) int {
	if left.UpdatedAt.After(right.UpdatedAt) {
		return -1
	}
	if left.UpdatedAt.Before(right.UpdatedAt) {
		return 1
	}
	switch {
	case left.AgentSessionID > right.AgentSessionID:
		return -1
	case left.AgentSessionID < right.AgentSessionID:
		return 1
	default:
		return 0
	}
}

func normalizeComparablePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	clean := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(clean); err == nil && strings.TrimSpace(resolved) != "" {
		clean = resolved
	}
	if abs, err := filepath.Abs(clean); err == nil {
		clean = abs
	}
	return filepath.Clean(clean)
}

func parseTimeRFC3339(raw string) time.Time {
	if raw == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}
