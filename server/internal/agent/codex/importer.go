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

	"mindfs/server/internal/apperr"

	agenttypes "mindfs/server/internal/agent/types"
)

type ImporterOptions struct {
	AgentName string
}

type Importer struct {
	agentName string
	baseDir   string
	titlePath string
	mu        sync.RWMutex
	index     map[string]codexSessionFile
}

type codexSessionFile struct {
	Path           string
	AgentSessionID string
	Cwd            string
	Title          string
	FirstUserText  string
	UpdatedAt      time.Time
}

type sessionFileCandidate struct {
	Path      string
	UpdatedAt time.Time
}

type importedExchangeLocator struct {
	agenttypes.ImportedExchange
	CodexUserCountAfter int
}

type importedTurn struct {
	Users []importedExchangeLocator
	Agent importedExchangeLocator
}

func NewImporter(opts ImporterOptions) *Importer {
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if codexHome == "" {
		home, _ := os.UserHomeDir()
		codexHome = filepath.Join(strings.TrimSpace(home), ".codex")
	}
	return &Importer{
		agentName: strings.TrimSpace(opts.AgentName),
		baseDir:   filepath.Join(codexHome, "sessions"),
		titlePath: filepath.Join(codexHome, "session_index.jsonl"),
		index:     make(map[string]codexSessionFile),
	}
}

func (i *Importer) AgentName() string {
	return i.agentName
}

func (i *Importer) ListExternalSessions(ctx context.Context, in agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	items := make([]agenttypes.ExternalSessionSummary, 0, limit)
	err := i.ScanExternalSessions(ctx, in, func(item agenttypes.ExternalSessionSummary) (bool, error) {
		items = append(items, item)
		return len(items) < limit, nil
	})
	if err != nil {
		return agenttypes.ListExternalSessionsResult{}, err
	}
	return agenttypes.ListExternalSessionsResult{Items: items}, nil
}

func (i *Importer) ScanExternalSessions(ctx context.Context, in agenttypes.ListExternalSessionsInput, visit agenttypes.ExternalSessionVisitFunc) error {
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	files, err := i.scanSessionFiles(ctx, in.BeforeTime, in.AfterTime, limit, visit)
	if err != nil {
		return err
	}
	i.storeSessionFiles(files)
	return nil
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
		exchanges, err := readCodexImportedExchanges(file.Path, in.AfterTimestamp)
		if err != nil {
			log.Printf("[agent/codex/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
			return agenttypes.ImportedExternalSession{}, err
		}
		return agenttypes.ImportedExternalSession{
			Agent:          i.agentName,
			AgentSessionID: targetID,
			Cwd:            file.Cwd,
			Title:          file.Title,
			Exchanges:      exchanges,
		}, nil
	}
	files, err := i.scanSessionFiles(context.Background(), time.Time{}, time.Time{}, int(^uint(0)>>1), nil)
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	for _, file := range files {
		if file.AgentSessionID != targetID {
			continue
		}
		exchanges, err := readCodexImportedExchanges(file.Path, in.AfterTimestamp)
		if err != nil {
			log.Printf("[agent/codex/importer] import session read failed session_id=%s path=%s err=%v", targetID, file.Path, err)
			return agenttypes.ImportedExternalSession{}, err
		}
		return agenttypes.ImportedExternalSession{
			Agent:          i.agentName,
			AgentSessionID: targetID,
			Cwd:            file.Cwd,
			Title:          file.Title,
			Exchanges:      exchanges,
		}, nil
	}
	return agenttypes.ImportedExternalSession{}, errors.New("external session not found")
}

func (i *Importer) ResolveForkPointByAgentTurnIndex(ctx context.Context, in agenttypes.ResolveForkPointInput) (agenttypes.ResolveForkPointOutput, error) {
	rootPath := normalizeComparablePath(in.RootPath)
	if rootPath == "" {
		return agenttypes.ResolveForkPointOutput{}, errors.New("root path required")
	}
	targetID := strings.TrimSpace(in.AgentSessionID)
	if targetID == "" {
		return agenttypes.ResolveForkPointOutput{}, errors.New("agent session id required")
	}
	if in.AgentTurnIndex <= 0 {
		return agenttypes.ResolveForkPointOutput{}, errors.New("agent turn index required")
	}
	file, ok := i.lookupSessionFile(targetID, rootPath)
	if !ok {
		files, err := i.scanSessionFiles(ctx, time.Time{}, time.Time{}, int(^uint(0)>>1), nil)
		if err != nil {
			return agenttypes.ResolveForkPointOutput{}, err
		}
		for _, candidate := range files {
			if candidate.AgentSessionID == targetID && normalizeComparablePath(candidate.Cwd) == rootPath {
				file = candidate
				ok = true
				break
			}
		}
	}
	if !ok {
		return agenttypes.ResolveForkPointOutput{}, errors.New("external session not found")
	}
	items, err := readCodexImportedExchangeLocators(file.Path, time.Time{})
	if err != nil {
		return agenttypes.ResolveForkPointOutput{}, err
	}
	turns := buildImportedTurns(items)
	if in.AgentTurnIndex > len(turns) {
		return agenttypes.ResolveForkPointOutput{}, errors.New("agent turn index out of range")
	}
	agent := turns[in.AgentTurnIndex-1].Agent
	return agenttypes.ResolveForkPointOutput{
		Kind:             agenttypes.ForkPointCodexUserOrdinal,
		AgentSessionID:   targetID,
		CodexUserOrdinal: agent.CodexUserCountAfter,
	}, nil
}

func (i *Importer) scanSessionFiles(ctx context.Context, before, after time.Time, limit int, visit agenttypes.ExternalSessionVisitFunc) ([]codexSessionFile, error) {
	if strings.TrimSpace(i.baseDir) == "" {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	titles := readCodexSessionTitles(i.titlePath)
	items := make([]codexSessionFile, 0)
	paths, err := sortedSessionJSONLFiles(i.baseDir)
	if err != nil {
		return nil, err
	}
	for _, candidate := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if !before.IsZero() && !candidate.UpdatedAt.Before(before) {
			continue
		}
		if !after.IsZero() && !candidate.UpdatedAt.After(after) {
			break
		}
		item, ok, err := inspectCodexSessionFile(candidate.Path)
		if err != nil {
			if apperr.IsPermission(err) {
				return nil, err
			}
			log.Printf("[agent/codex/importer] inspect session file failed path=%s err=%v", candidate.Path, err)
			continue
		}
		if !ok {
			continue
		}
		item.Title = titles[item.AgentSessionID]
		if visit != nil {
			shouldContinue, err := visit(agenttypes.ExternalSessionSummary{
				Agent:          i.agentName,
				AgentSessionID: item.AgentSessionID,
				Cwd:            item.Cwd,
				Title:          item.Title,
				FirstUserText:  item.FirstUserText,
				UpdatedAt:      item.UpdatedAt,
			})
			if err != nil {
				return nil, err
			}
			items = append(items, item)
			if !shouldContinue {
				return items, nil
			}
			continue
		}
		items = appendSortedCodexSession(items, item)
		if len(items) > limit {
			items = items[:limit]
		}
	}
	i.storeSessionFiles(items)
	return items, nil
}

func sortedSessionJSONLFiles(baseDir string) ([]sessionFileCandidate, error) {
	items := make([]sessionFileCandidate, 0)
	err := filepath.WalkDir(baseDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if apperr.IsPermission(walkErr) {
				return apperr.Wrap("walk", path, walkErr)
			}
			return nil
		}
		if d == nil || d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if apperr.IsPermission(err) {
				return apperr.Wrap("stat", path, err)
			}
			return nil
		}
		items = append(items, sessionFileCandidate{
			Path:      path,
			UpdatedAt: info.ModTime().UTC(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].Path > items[j].Path
	})
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

func readCodexSessionTitles(path string) map[string]string {
	titles := make(map[string]string)
	file, err := os.Open(path)
	if err != nil {
		if apperr.IsPermission(err) {
			log.Printf("[agent/codex/importer] read title index failed path=%s err=%v", path, err)
		}
		return titles
	}
	defer file.Close()

	_ = forEachJSONLLine(file, func(line string) error {
		line = strings.TrimSpace(line)
		if line == "" {
			return nil
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			return nil
		}
		id := strings.TrimSpace(asString(raw["id"]))
		title := strings.TrimSpace(asString(raw["thread_name"]))
		if id != "" && title != "" {
			titles[id] = title
		}
		return nil
	})
	return titles
}

func inspectCodexSessionFile(path string) (codexSessionFile, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return codexSessionFile{}, false, apperr.Wrap("open", path, err)
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

func readCodexImportedExchanges(path string, after time.Time) ([]agenttypes.ImportedExchange, error) {
	locators, err := readCodexImportedExchangeLocators(path, after)
	if err != nil {
		return nil, err
	}
	items := make([]agenttypes.ImportedExchange, 0, len(locators))
	for _, item := range locators {
		items = append(items, item.ImportedExchange)
	}
	return items, nil
}

func readCodexImportedExchangeLocators(path string, after time.Time) ([]importedExchangeLocator, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, apperr.Wrap("open", path, err)
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
		case "event_msg":
			if numTurns := codexRollbackTurns(raw); numTurns > 0 {
				items = dropLastCodexUserTurns(items, numTurns)
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return codexExchangeLocatorsAfter(items, after), nil
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

func appendMergedExchangeLocator(items []importedExchangeLocator, role, content string, ts time.Time, userCount int) []importedExchangeLocator {
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
		last.CodexUserCountAfter = userCount
		return items
	}
	items = append(items, importedExchangeLocator{
		ImportedExchange: agenttypes.ImportedExchange{
			Role:      role,
			Content:   content,
			Timestamp: ts,
		},
		CodexUserCountAfter: userCount,
	})
	return items
}

func codexRollbackTurns(raw map[string]any) int {
	payload, _ := raw["payload"].(map[string]any)
	if payload == nil || strings.TrimSpace(asString(payload["type"])) != "thread_rolled_back" {
		return 0
	}
	switch value := payload["num_turns"].(type) {
	case float64:
		if value > 0 {
			return int(value)
		}
	case int:
		if value > 0 {
			return value
		}
	}
	return 0
}

func dropLastCodexUserTurns(items []agenttypes.ImportedExchange, numTurns int) []agenttypes.ImportedExchange {
	if numTurns <= 0 || len(items) == 0 {
		return items
	}
	out := items
	for ; numTurns > 0 && len(out) > 0; numTurns-- {
		userIndex := -1
		for i := len(out) - 1; i >= 0; i-- {
			if out[i].Role == "user" {
				userIndex = i
				break
			}
		}
		if userIndex < 0 {
			return nil
		}
		out = out[:userIndex]
	}
	return out
}

func codexExchangeLocatorsAfter(items []agenttypes.ImportedExchange, after time.Time) []importedExchangeLocator {
	out := make([]importedExchangeLocator, 0, len(items))
	userCount := 0
	for _, item := range items {
		if item.Role == "user" {
			userCount++
		}
		if !after.IsZero() && (item.Timestamp.IsZero() || !item.Timestamp.After(after)) {
			continue
		}
		out = appendMergedExchangeLocator(out, item.Role, item.Content, item.Timestamp, userCount)
	}
	return out
}

func buildImportedTurns(items []importedExchangeLocator) []importedTurn {
	turns := make([]importedTurn, 0)
	users := make([]importedExchangeLocator, 0)
	for _, item := range items {
		switch item.Role {
		case "user":
			users = append(users, item)
		case "agent":
			turns = append(turns, importedTurn{
				Users: append([]importedExchangeLocator(nil), users...),
				Agent: item,
			})
			users = nil
		}
	}
	return turns
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
