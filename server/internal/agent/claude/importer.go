package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

type sessionFileCandidate struct {
	Path      string
	UpdatedAt time.Time
}

type importedExchangeLocator struct {
	agenttypes.ImportedExchange
	ClaudeLastMessageUUID string
}

type importedTurn struct {
	Users []importedExchangeLocator
	Agent importedExchangeLocator
}

type importedToolLocation struct {
	ExchangeIndex int
	AuxIndex      int
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

func (i *Importer) ListExternalSessions(ctx context.Context, in agenttypes.ListExternalSessionsInput) (agenttypes.ListExternalSessionsResult, error) {
	rootPath := normalizeComparablePath(in.RootPath)
	if rootPath == "" {
		return agenttypes.ListExternalSessionsResult{}, errors.New("root path required")
	}
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
	rootPath := normalizeComparablePath(in.RootPath)
	if rootPath == "" {
		return errors.New("root path required")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	files, err := i.scanSessionFiles(ctx, rootPath, in.BeforeTime, in.AfterTime, limit, visit)
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
		return i.importSessionFile(file, in.AfterTimestamp, in.Cursor)
	}
	files, err := i.scanSessionFiles(context.Background(), rootPath, time.Time{}, time.Time{}, int(^uint(0)>>1), nil)
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	for _, file := range files {
		if file.AgentSessionID != targetID {
			continue
		}
		return i.importSessionFile(file, in.AfterTimestamp, in.Cursor)
	}
	return agenttypes.ImportedExternalSession{}, errors.New("external session not found")
}

func (i *Importer) importSessionFile(file claudeSessionFile, after time.Time, previous agenttypes.ExternalSessionCursor) (agenttypes.ImportedExternalSession, error) {
	cursor, unchanged, err := externalSessionFileCursor(file.Path, previous)
	if err != nil {
		return agenttypes.ImportedExternalSession{}, err
	}
	if unchanged {
		return agenttypes.ImportedExternalSession{Agent: i.agentName, AgentSessionID: file.AgentSessionID, Cwd: file.Cwd, Cursor: cursor}, nil
	}
	exchanges, err := readClaudeImportedExchanges(file.Path, after)
	if err != nil {
		log.Printf("[agent/claude/importer] import session read failed session_id=%s path=%s err=%v", file.AgentSessionID, file.Path, err)
		return agenttypes.ImportedExternalSession{}, err
	}
	subagents, err := readClaudeImportedSubagents(file.Path)
	if err != nil {
		log.Printf("[agent/claude/importer] import subagents failed session_id=%s path=%s err=%v", file.AgentSessionID, file.Path, err)
		return agenttypes.ImportedExternalSession{}, err
	}
	return agenttypes.ImportedExternalSession{
		Agent:          i.agentName,
		AgentSessionID: file.AgentSessionID,
		Cwd:            file.Cwd,
		Exchanges:      exchanges,
		Subagents:      subagents,
		Cursor:         cursor,
	}, nil
}

func externalSessionFileCursor(path string, previous agenttypes.ExternalSessionCursor) (agenttypes.ExternalSessionCursor, bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return agenttypes.ExternalSessionCursor{}, false, err
	}
	cursor := agenttypes.ExternalSessionCursor{SourcePath: filepath.Clean(path), Offset: info.Size(), ModTimeUnixNano: info.ModTime().UnixNano()}
	unchanged := previous.Offset > 0 && filepath.Clean(previous.SourcePath) == cursor.SourcePath && previous.Offset == cursor.Offset && previous.ModTimeUnixNano == cursor.ModTimeUnixNano
	return cursor, unchanged, nil
}

type claudeSubagentRelation struct {
	AgentID          string
	ParentAgentID    string
	ParentToolCallID string
	Title            string
	Model            string
}

func readClaudeImportedSubagents(parentPath string) ([]agenttypes.ImportedSubagentSession, error) {
	dir := filepath.Join(strings.TrimSuffix(parentPath, filepath.Ext(parentPath)), "subagents")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, apperr.Wrap("read_dir", dir, err)
	}
	pathsByAgentID := make(map[string]string)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".jsonl" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		agentID, err := inspectClaudeSubagentID(path)
		if err != nil {
			return nil, err
		}
		if agentID != "" {
			pathsByAgentID[agentID] = path
		}
	}
	if len(pathsByAgentID) == 0 {
		return nil, nil
	}
	relations := make(map[string]claudeSubagentRelation)
	if err := collectClaudeSubagentRelations(parentPath, "", relations); err != nil {
		return nil, err
	}
	for agentID, path := range pathsByAgentID {
		if err := collectClaudeSubagentRelations(path, agentID, relations); err != nil {
			return nil, err
		}
	}
	items := make([]agenttypes.ImportedSubagentSession, 0, len(relations))
	remaining := make(map[string]claudeSubagentRelation, len(relations))
	for agentID, relation := range relations {
		if _, ok := pathsByAgentID[agentID]; ok {
			remaining[agentID] = relation
		}
	}
	added := make(map[string]bool)
	for len(remaining) > 0 {
		progressed := false
		for agentID, relation := range remaining {
			if relation.ParentAgentID != "" && !added[relation.ParentAgentID] {
				continue
			}
			exchanges, err := readClaudeImportedExchanges(pathsByAgentID[agentID], time.Time{})
			if err != nil {
				return nil, err
			}
			parentID := ""
			if relation.ParentAgentID != "" {
				parentID = "claude-subagent:" + relation.ParentAgentID
			}
			items = append(items, agenttypes.ImportedSubagentSession{
				AgentSessionID:       "claude-subagent:" + agentID,
				ParentAgentSessionID: parentID,
				ParentToolCallID:     relation.ParentToolCallID,
				Title:                relation.Title,
				Model:                relation.Model,
				Exchanges:            exchanges,
			})
			added[agentID] = true
			delete(remaining, agentID)
			progressed = true
		}
		if !progressed {
			break
		}
	}
	return items, nil
}

func inspectClaudeSubagentID(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", apperr.Wrap("open", path, err)
	}
	defer file.Close()
	var agentID string
	err = forEachJSONLLine(file, func(line string) error {
		var raw map[string]any
		if json.Unmarshal([]byte(line), &raw) == nil {
			agentID = strings.TrimSpace(asString(raw["agentId"]))
		}
		if agentID != "" {
			return errStopJSONL
		}
		return nil
	})
	if errors.Is(err, errStopJSONL) {
		err = nil
	}
	return agentID, err
}

func collectClaudeSubagentRelations(path, parentAgentID string, relations map[string]claudeSubagentRelation) error {
	file, err := os.Open(path)
	if err != nil {
		return apperr.Wrap("open", path, err)
	}
	defer file.Close()
	callDetails := make(map[string]claudeSubagentRelation)
	return forEachJSONLLine(file, func(line string) error {
		var raw map[string]any
		if json.Unmarshal([]byte(line), &raw) != nil {
			return nil
		}
		message, _ := raw["message"].(map[string]any)
		blocks, _ := message["content"].([]any)
		for _, value := range blocks {
			block, _ := value.(map[string]any)
			if block == nil {
				continue
			}
			toolName := strings.ToLower(strings.TrimSpace(asString(block["name"])))
			if strings.EqualFold(asString(block["type"]), "tool_use") && (toolName == "agent" || toolName == "task") {
				input, _ := block["input"].(map[string]any)
				callID := strings.TrimSpace(asString(block["id"]))
				callDetails[callID] = claudeSubagentRelation{
					ParentAgentID:    parentAgentID,
					ParentToolCallID: callID,
					Title:            firstNonEmpty(asString(input["description"]), asString(input["subagent_type"]), "Subagent"),
					Model:            strings.TrimSpace(asString(input["model"])),
				}
			}
		}
		result, _ := raw["toolUseResult"].(map[string]any)
		agentID := strings.TrimSpace(asString(result["agentId"]))
		if agentID == "" {
			return nil
		}
		callID := ""
		for _, value := range blocks {
			block, _ := value.(map[string]any)
			if block != nil && strings.EqualFold(asString(block["type"]), "tool_result") {
				callID = strings.TrimSpace(asString(block["tool_use_id"]))
				break
			}
		}
		relation := callDetails[callID]
		relation.AgentID = agentID
		relation.ParentAgentID = parentAgentID
		relation.ParentToolCallID = callID
		if relation.Title == "" {
			relation.Title = firstNonEmpty(asString(result["agentType"]), "Subagent")
		}
		if relation.Model == "" {
			relation.Model = strings.TrimSpace(asString(result["resolvedModel"]))
		}
		relations[agentID] = relation
		return nil
	})
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
		files, err := i.scanSessionFiles(ctx, rootPath, time.Time{}, time.Time{}, int(^uint(0)>>1), nil)
		if err != nil {
			return agenttypes.ResolveForkPointOutput{}, err
		}
		for _, candidate := range files {
			if candidate.AgentSessionID == targetID {
				file = candidate
				ok = true
				break
			}
		}
	}
	if !ok {
		return agenttypes.ResolveForkPointOutput{}, errors.New("external session not found")
	}
	items, err := readClaudeImportedExchangeLocators(file.Path, time.Time{})
	if err != nil {
		return agenttypes.ResolveForkPointOutput{}, err
	}
	turns := buildImportedTurns(items)
	if in.AgentTurnIndex > len(turns) {
		return agenttypes.ResolveForkPointOutput{}, errors.New("agent turn index out of range")
	}
	agent := turns[in.AgentTurnIndex-1].Agent
	if strings.TrimSpace(agent.ClaudeLastMessageUUID) == "" {
		return agenttypes.ResolveForkPointOutput{}, errors.New("claude message uuid not found")
	}
	return agenttypes.ResolveForkPointOutput{
		Kind:              agenttypes.ForkPointClaudeMessageUUID,
		AgentSessionID:    targetID,
		ClaudeMessageUUID: agent.ClaudeLastMessageUUID,
	}, nil
}

func (i *Importer) scanSessionFiles(ctx context.Context, rootPath string, before, after time.Time, limit int, visit agenttypes.ExternalSessionVisitFunc) ([]claudeSessionFile, error) {
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
		return nil, apperr.Wrap("stat", dir, err)
	}
	if !info.IsDir() {
		return nil, nil
	}
	if limit <= 0 {
		limit = 20
	}
	items := make([]claudeSessionFile, 0)
	paths, err := sortedSessionJSONLFiles(dir)
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
		item, ok, err := inspectClaudeSessionFile(candidate.Path)
		if err != nil {
			if apperr.IsPermission(err) {
				return nil, err
			}
			log.Printf("[agent/claude/importer] inspect session file failed path=%s err=%v", candidate.Path, err)
			continue
		}
		if !ok {
			continue
		}
		if visit != nil {
			shouldContinue, err := visit(agenttypes.ExternalSessionSummary{
				Agent:          i.agentName,
				AgentSessionID: item.AgentSessionID,
				Cwd:            item.Cwd,
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
		items = appendSortedClaudeSession(items, item)
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
		if isClaudeSubagentSessionFile(baseDir, path) {
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

func isClaudeSubagentSessionFile(baseDir, path string) bool {
	rel, err := filepath.Rel(baseDir, path)
	if err != nil {
		return false
	}
	for _, part := range strings.Split(rel, string(os.PathSeparator)) {
		if part == "subagents" {
			return true
		}
	}
	return false
}

func (i *Importer) projectDir(rootPath string) string {
	dirName := claudeProjectDirName(rootPath)
	if dirName == "" {
		return ""
	}
	return filepath.Join(i.baseDir, dirName)
}

func claudeProjectDirName(rootPath string) string {
	rootPath = normalizeComparablePath(rootPath)
	if rootPath == "" {
		return ""
	}
	return sanitizeClaudeProjectPath(rootPath)
}

func sanitizeClaudeProjectPath(path string) string {
	replacer := strings.NewReplacer(
		"/", "-",
		"\\", "-",
		":", "-",
		".", "-",
		"_", "-",
	)
	return replacer.Replace(path)
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
		return claudeSessionFile{}, false, apperr.Wrap("open", path, err)
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
				if text := extractClaudeUserPreview(message["content"]); text != "" {
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

func readClaudeImportedExchanges(path string, after time.Time) ([]agenttypes.ImportedExchange, error) {
	locators, err := readClaudeImportedExchangeLocators(path, after)
	if err != nil {
		return nil, err
	}
	items := make([]agenttypes.ImportedExchange, 0, len(locators))
	for _, item := range locators {
		items = append(items, item.ImportedExchange)
	}
	return items, nil
}

func readClaudeImportedExchangeLocators(path string, after time.Time) ([]importedExchangeLocator, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, apperr.Wrap("open", path, err)
	}
	defer file.Close()

	items := make([]importedExchangeLocator, 0)
	toolLocations := make(map[string]importedToolLocation)
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
		uuid := strings.TrimSpace(asString(raw["uuid"]))
		message, _ := raw["message"].(map[string]any)
		if message == nil {
			return nil
		}
		ts := parseTimeRFC3339(asString(raw["timestamp"]))
		if role == "user" {
			applyClaudeToolResults(items, toolLocations, message["content"], raw["toolUseResult"], ts)
			text := extractClaudeImportedUserText(message["content"])
			if text != "" && isMeaningfulClaudeUserText(text) {
				items, _, _ = appendMergedClaudeExchangeLocator(items, "user", text, ts, uuid, nil)
			}
			return nil
		}
		text := strings.TrimSpace(extractClaudeMessageText(message["content"]))
		aux := extractClaudeToolUseAux(message["content"])
		if text == "" && len(aux) == 0 {
			return nil
		}
		var exchangeIndex, auxStart int
		items, exchangeIndex, auxStart = appendMergedClaudeExchangeLocator(
			items,
			"agent",
			text,
			ts,
			uuid,
			aux,
		)
		for index := auxStart; index < len(items[exchangeIndex].Aux); index++ {
			toolCall := items[exchangeIndex].Aux[index].ToolCall
			if toolCall == nil || strings.TrimSpace(toolCall.CallID) == "" {
				continue
			}
			toolLocations[strings.TrimSpace(toolCall.CallID)] = importedToolLocation{
				ExchangeIndex: exchangeIndex,
				AuxIndex:      index,
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if after.IsZero() {
		return items, nil
	}
	filtered := make([]importedExchangeLocator, 0, len(items))
	for _, item := range items {
		if item.Timestamp.IsZero() || !item.Timestamp.After(after) {
			continue
		}
		filtered = append(filtered, item)
	}
	return filtered, nil
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

func extractClaudeUserPreview(raw any) string {
	if text := strings.TrimSpace(asString(raw)); text != "" {
		if isMeaningfulClaudeUserText(text) {
			return text
		}
		return ""
	}
	parts, _ := raw.([]any)
	for index := len(parts) - 1; index >= 0; index-- {
		item, _ := parts[index].(map[string]any)
		if item == nil || strings.TrimSpace(asString(item["type"])) != "text" {
			continue
		}
		text := strings.TrimSpace(asString(item["text"]))
		if isMeaningfulClaudeUserText(text) {
			return text
		}
	}
	return ""
}

func extractClaudeImportedUserText(raw any) string {
	if text := strings.TrimSpace(asString(raw)); text != "" {
		if isMeaningfulClaudeUserText(text) {
			return text
		}
		return ""
	}
	parts, _ := raw.([]any)
	texts := make([]string, 0, len(parts))
	for _, value := range parts {
		item, _ := value.(map[string]any)
		if item == nil || strings.TrimSpace(asString(item["type"])) != "text" {
			continue
		}
		text := strings.TrimSpace(asString(item["text"]))
		if isMeaningfulClaudeUserText(text) {
			texts = append(texts, text)
		}
	}
	return strings.TrimSpace(strings.Join(texts, "\n\n"))
}

func extractClaudeToolUseAux(raw any) []agenttypes.ImportedExchangeAux {
	parts, _ := raw.([]any)
	aux := make([]agenttypes.ImportedExchangeAux, 0)
	textParts := make([]string, 0)
	for _, part := range parts {
		item, _ := part.(map[string]any)
		if item == nil {
			continue
		}
		switch strings.TrimSpace(asString(item["type"])) {
		case "text":
			if text := strings.TrimSpace(asString(item["text"])); text != "" {
				textParts = append(textParts, text)
			}
		case "tool_use":
			callID := strings.TrimSpace(asString(item["id"]))
			name := strings.TrimSpace(asString(item["name"]))
			if callID == "" {
				continue
			}
			kind := mapToolKind(name)
			if kind != agenttypes.ToolKindExecute &&
				kind != agenttypes.ToolKindEdit &&
				kind != agenttypes.ToolKindThink &&
				kind != agenttypes.ToolKindAskUser {
				continue
			}
			input, _ := json.Marshal(item["input"])
			toolCall := newRunningToolCall(callID, name, "tool_use", input)
			aux = append(aux, agenttypes.ImportedExchangeAux{
				Line:     importedAssistantLine(strings.Join(textParts, "\n\n")),
				ToolCall: &toolCall,
			})
		}
	}
	return aux
}

func applyClaudeToolResults(
	items []importedExchangeLocator,
	locations map[string]importedToolLocation,
	raw any,
	toolUseResult any,
	timestamp time.Time,
) {
	parts, _ := raw.([]any)
	for _, part := range parts {
		item, _ := part.(map[string]any)
		if item == nil || strings.TrimSpace(asString(item["type"])) != "tool_result" {
			continue
		}
		callID := strings.TrimSpace(asString(item["tool_use_id"]))
		location, ok := locations[callID]
		if !ok || location.ExchangeIndex < 0 || location.ExchangeIndex >= len(items) {
			continue
		}
		exchange := &items[location.ExchangeIndex]
		if location.AuxIndex < 0 || location.AuxIndex >= len(exchange.Aux) {
			continue
		}
		aux := &exchange.Aux[location.AuxIndex]
		if aux.ToolCall == nil {
			continue
		}
		if !timestamp.IsZero() {
			exchange.Timestamp = timestamp
		}
		toolCall := *aux.ToolCall
		output := summarizeToolResult(toolCall.Kind, item["content"])
		if output == "" {
			output = summarizeGenericToolResult(item["content"])
		}
		isError, _ := item["is_error"].(bool)
		if isError {
			toolCall.Status = "failed"
		} else {
			toolCall.Status = "complete"
		}
		if strings.TrimSpace(output) != "" {
			toolCall.Meta = mergeToolCallMeta(toolCall.Meta, map[string]any{"output": output})
			if toolCall.Kind != agenttypes.ToolKindEdit || len(toolCall.Content) == 0 {
				toolCall.Content = []agenttypes.ToolCallContentItem{{Type: "text", Text: output}}
			}
		}
		if toolCall.Kind == agenttypes.ToolKindAskUser {
			if answers := importedClaudeAskUserAnswers(toolCall, toolUseResult); len(answers) > 0 {
				toolCall.Meta = mergeToolCallMeta(toolCall.Meta, map[string]any{"answers": answers})
			}
		}
		aux.ToolCall = &toolCall
	}
}

func importedClaudeAskUserAnswers(toolCall agenttypes.ToolCall, raw any) map[string]string {
	result, _ := raw.(map[string]any)
	rawAnswers, _ := result["answers"].(map[string]any)
	if len(rawAnswers) == 0 {
		return nil
	}
	input := importedClaudeToolInput(toolCall)
	questions, _ := input["questions"].([]any)
	answers := make(map[string]string)
	for index, value := range questions {
		question, _ := value.(map[string]any)
		if question == nil {
			continue
		}
		questionText := strings.TrimSpace(asString(question["question"]))
		if questionText == "" {
			continue
		}
		answer := strings.TrimSpace(asString(rawAnswers[questionText]))
		if answer != "" {
			answers[fmt.Sprintf("q_%d", index)] = answer
		}
	}
	return answers
}

func importedClaudeToolInput(toolCall agenttypes.ToolCall) map[string]any {
	if toolCall.Meta == nil {
		return nil
	}
	raw := strings.TrimSpace(asString(toolCall.Meta["input"]))
	if raw == "" {
		return nil
	}
	var input map[string]any
	if json.Unmarshal([]byte(raw), &input) != nil {
		return nil
	}
	return input
}

func importedAssistantLine(content string) int {
	if content == "" {
		return 0
	}
	return strings.Count(content, "\n") + 1
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

func appendMergedClaudeExchangeLocator(
	items []importedExchangeLocator,
	role, content string,
	ts time.Time,
	uuid string,
	aux []agenttypes.ImportedExchangeAux,
) ([]importedExchangeLocator, int, int) {
	content = strings.TrimSpace(content)
	if content == "" && len(aux) == 0 {
		return items, -1, 0
	}
	if len(items) > 0 && items[len(items)-1].Role == role {
		last := &items[len(items)-1]
		lineOffset := importedAssistantLine(last.Content)
		if content != "" {
			if last.Content == "" {
				last.Content = content
			} else {
				last.Content = strings.TrimSpace(last.Content + "\n\n" + content)
			}
		}
		if !ts.IsZero() {
			last.Timestamp = ts
		}
		if strings.TrimSpace(uuid) != "" {
			last.ClaudeLastMessageUUID = strings.TrimSpace(uuid)
		}
		auxStart := len(last.Aux)
		for _, item := range aux {
			item.Line += lineOffset
			last.Aux = append(last.Aux, item)
		}
		return items, len(items) - 1, auxStart
	}
	items = append(items, importedExchangeLocator{
		ImportedExchange: agenttypes.ImportedExchange{
			Role:      role,
			Content:   content,
			Timestamp: ts,
			Aux:       aux,
		},
		ClaudeLastMessageUUID: strings.TrimSpace(uuid),
	})
	return items, len(items) - 1, 0
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
