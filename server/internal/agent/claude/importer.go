package claude

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
	index     map[string]claudeSessionFile
}

type claudeSessionFile struct {
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
		baseDir:   filepath.Join(strings.TrimSpace(home), ".claude", "projects"),
		index:     make(map[string]claudeSessionFile),
	}
}

func (i *Importer) AgentName() string {
	return i.agentName
}

func (i *Importer) ListExternalSessions(_ context.Context, in agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	rootPath := normalizeComparablePath(in.RootPath)
	if rootPath == "" {
		return agenttypes.ListExternalSessionsResult{}, errors.New("root path required")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	files, err := i.scanSessionFiles(rootPath, in.BeforeTime, in.AfterTime, limit)
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
		exchanges, err := readClaudeImportedExchanges(file.Path)
		if err != nil {
			log.Printf("[agent/claude/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
			return agenttypes.ImportedExternalSession{}, err
		}
		return agenttypes.ImportedExternalSession{
			Agent:          i.agentName,
			AgentSessionID: targetID,
			Cwd:            file.Cwd,
			Exchanges:      exchanges,
		}, nil
	}
	files, err := i.scanSessionFiles(rootPath, time.Time{}, time.Time{}, int(^uint(0)>>1))
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	for _, file := range files {
		if file.AgentSessionID != targetID {
			continue
		}
		exchanges, err := readClaudeImportedExchanges(file.Path)
		if err != nil {
			log.Printf("[agent/claude/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
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

func (i *Importer) scanSessionFiles(rootPath string, before, after time.Time, limit int) ([]claudeSessionFile, error) {
	if strings.TrimSpace(i.baseDir) == "" {
		return nil, nil
	}
	dir := i.projectDir(rootPath)
	if strings.TrimSpace(dir) == "" {
		return nil, nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	items := make([]claudeSessionFile, 0)
	err = filepath.WalkDir(dir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d == nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		item, ok, err := inspectClaudeSessionFile(path)
		if err != nil {
			log.Printf("[agent/claude/importer] inspect session file failed path=%s err=%v", path, err)
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
		items = appendSortedClaudeSession(items, item)
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

func (i *Importer) projectDir(rootPath string) string {
	rootPath = normalizeComparablePath(rootPath)
	if rootPath == "" {
		return ""
	}
	replacer := strings.NewReplacer(
		string(os.PathSeparator), "-",
		".", "-",
	)
	return filepath.Join(i.baseDir, replacer.Replace(rootPath))
}

func (i *Importer) storeSessionFiles(items []claudeSessionFile) {
	i.mu.Lock()
	defer i.mu.Unlock()
	for _, item := range items {
		if strings.TrimSpace(item.AgentSessionID) == "" {
			continue
		}
		i.index[item.AgentSessionID] = item
	}
}

func (i *Importer) lookupSessionFile(sessionID, rootPath string) (claudeSessionFile, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	item, ok := i.index[strings.TrimSpace(sessionID)]
	if !ok {
		return claudeSessionFile{}, false
	}
	if normalizeComparablePath(item.Cwd) != normalizeComparablePath(rootPath) {
		return claudeSessionFile{}, false
	}
	return item, true
}

func inspectClaudeSessionFile(path string) (claudeSessionFile, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return claudeSessionFile{}, false, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return claudeSessionFile{}, false, err
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
		if sessionID == "" {
			sessionID = strings.TrimSpace(asString(raw["sessionId"]))
		}
		if cwd == "" {
			candidate := normalizeComparablePath(asString(raw["cwd"]))
			if candidate != "" {
				cwd = candidate
			}
		}
		if firstUserText == "" && strings.EqualFold(asString(raw["type"]), "user") {
			if message, _ := raw["message"].(map[string]any); message != nil {
				if text := strings.TrimSpace(extractClaudeMessageText(message["content"])); isMeaningfulClaudeUserText(text) {
					firstUserText = text
				}
			}
		}
		if sessionID != "" && cwd != "" && firstUserText != "" {
			return errStopJSONL
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopJSONL) {
		return claudeSessionFile{}, false, err
	}
	if sessionID == "" || cwd == "" {
		return claudeSessionFile{}, false, nil
	}
	return claudeSessionFile{
		Path:           path,
		AgentSessionID: sessionID,
		Cwd:            cwd,
		FirstUserText:  firstUserText,
		UpdatedAt:      info.ModTime().UTC(),
	}, true, nil
}

func readClaudeImportedExchanges(path string) ([]agenttypes.ImportedExchange, error) {
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
		role := strings.ToLower(strings.TrimSpace(asString(raw["type"])))
		if role != "user" && role != "assistant" {
			return nil
		}
		message, _ := raw["message"].(map[string]any)
		if message == nil {
			return nil
		}
		text := strings.TrimSpace(extractClaudeMessageText(message["content"]))
		if text == "" {
			return nil
		}
		ts := parseTimeRFC3339(asString(raw["timestamp"]))
		if role == "user" {
			if !isMeaningfulClaudeUserText(text) {
				return nil
			}
			items = appendMergedClaudeExchange(items, "user", text, ts)
			return nil
		}
		items = appendMergedClaudeExchange(items, "agent", text, ts)
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

func extractClaudeMessageText(raw any) string {
	if text := strings.TrimSpace(asString(raw)); text != "" {
		return text
	}
	parts, _ := raw.([]any)
	lines := make([]string, 0, len(parts))
	for _, part := range parts {
		item, _ := part.(map[string]any)
		if item == nil {
			continue
		}
		if strings.TrimSpace(asString(item["type"])) != "text" {
			continue
		}
		if text := strings.TrimSpace(asString(item["text"])); text != "" {
			lines = append(lines, text)
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n\n"))
}

func isMeaningfulClaudeUserText(text string) bool {
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if text == "" {
		return false
	}
	lower := strings.ToLower(text)
	if strings.HasPrefix(lower, "<local-command-caveat>") ||
		strings.HasPrefix(lower, "<command-name>") ||
		strings.HasPrefix(lower, "<local-command-stdout>") ||
		strings.HasPrefix(lower, "<local-command-stderr>") ||
		strings.HasPrefix(lower, "this session was migrated from elsewhere.") ||
		strings.HasPrefix(lower, "this session is being continued from a previous conversation") {
		return false
	}
	if strings.Contains(lower, "<command-message>") || strings.Contains(lower, "<command-args>") {
		return false
	}
	if strings.Contains(lower, "<local-command-stdout>") || strings.Contains(lower, "<local-command-stderr>") {
		return false
	}
	if strings.Contains(lower, "<local-command-caveat>") {
		return false
	}
	if strings.Contains(lower, "\"type\": \"tool_result\"") || strings.Contains(lower, "'type': 'tool_result'") {
		return false
	}
	return true
}

func appendMergedClaudeExchange(items []agenttypes.ImportedExchange, role, content string, ts time.Time) []agenttypes.ImportedExchange {
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

func appendSortedClaudeSession(items []claudeSessionFile, item claudeSessionFile) []claudeSessionFile {
	idx := sort.Search(len(items), func(i int) bool {
		return compareClaudeSessionFile(item, items[i]) < 0
	})
	items = append(items, claudeSessionFile{})
	copy(items[idx+1:], items[idx:])
	items[idx] = item
	return items
}

func compareClaudeSessionFile(left, right claudeSessionFile) int {
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
