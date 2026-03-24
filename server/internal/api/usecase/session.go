package usecase

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/session"
)

type ClientContext struct {
	CurrentRoot   string     `json:"current_root"`
	CurrentPath   string     `json:"current_path,omitempty"`
	PluginCatalog string     `json:"plugin_catalog,omitempty"`
	Selection     *Selection `json:"selection,omitempty"`
}

type Selection struct {
	FilePath  string `json:"file_path"`
	StartLine int    `json:"start_line,omitempty"`
	EndLine   int    `json:"end_line,omitempty"`
	Text      string `json:"text,omitempty"`
}

type ListSessionsInput struct {
	RootID     string
	BeforeTime time.Time
	AfterTime  time.Time
	Limit      int
}

type ListSessionsOutput struct {
	Sessions []*session.Session
}

func (s *Service) ListSessions(ctx context.Context, in ListSessionsInput) (ListSessionsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListSessionsOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return ListSessionsOutput{}, err
	}
	items, err := manager.List(ctx, session.ListOptions{
		BeforeTime: in.BeforeTime,
		AfterTime:  in.AfterTime,
		Limit:      in.Limit,
	})
	if err != nil {
		return ListSessionsOutput{}, err
	}
	return ListSessionsOutput{Sessions: items}, nil
}

type CreateSessionInput struct {
	RootID string
	Input  session.CreateInput
}

func (s *Service) CreateSession(ctx context.Context, in CreateSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Create(ctx, in.Input)
}

type GetSessionInput struct {
	RootID string
	Key    string
	Seq    int
}

func (s *Service) GetSession(ctx context.Context, in GetSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Get(ctx, in.Key, in.Seq)
}

type CloseSessionInput struct {
	RootID string
	Key    string
}

func (s *Service) CloseSession(ctx context.Context, in CloseSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	closed, err := manager.Close(ctx, in.Key)
	if err != nil {
		return nil, err
	}
	if pool := s.Registry.GetAgentPool(); pool != nil && closed != nil {
		for agentName := range closed.AgentCtxSeq {
			pool.Close(agentPoolSessionKey(closed.Key, agentName))
		}
	}
	s.Registry.ReleaseFileWatcher(in.RootID, in.Key)
	return closed, nil
}

type DeleteSessionInput struct {
	RootID string
	Key    string
}

func (s *Service) DeleteSession(ctx context.Context, in DeleteSessionInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	if err := manager.Delete(ctx, in.Key); err != nil {
		return err
	}
	if err := root.RemoveSessionFileMeta(in.Key); err != nil {
		return err
	}
	s.Registry.ReleaseFileWatcher(in.RootID, in.Key)
	return nil
}

type BuildPromptInput struct {
	Session       *session.Session
	Manager       *session.Manager
	Agent         string
	Message       string
	ClientContext ClientContext
	IsInitial     bool
}

func (s *Service) BuildPrompt(in BuildPromptInput) string {
	clientCtx := in.ClientContext
	prompt := buildUserPrompt(in.Message, clientCtx)
	if strings.TrimSpace(clientCtx.PluginCatalog) != "" {
		prompt = buildPluginPrompt(clientCtx.PluginCatalog, in.Message, in.IsInitial)
	}
	return prependSwitchHint(in, prompt)
}

func prependSwitchHint(in BuildPromptInput, prompt string) string {
	if in.Session == nil || in.Manager == nil {
		return prompt
	}
	currentAgent := strings.TrimSpace(in.Agent)
	if currentAgent == "" {
		return prompt
	}
	total := contextLineCount(in.Session.Exchanges)
	last := in.Session.AgentCtxSeq[currentAgent]
	linesToRead := calculateSwitchReadLines(total, last)
	if linesToRead <= 0 {
		return prompt
	}
	logPath := in.Manager.ExchangeLogPath(in.Session.Key)
	readHint := buildSwitchReadHint(logPath, linesToRead)
	return readHint + prompt
}

func (s *Service) appendAgentReply(ctx context.Context, manager *session.Manager, sess *session.Session, agent, content string) error {
	if content == "" || manager == nil {
		return nil
	}
	return manager.AddExchangeForAgent(ctx, sess, "agent", content, agent)
}

type SendMessageInput struct {
	RootID    string
	Key       string
	Agent     string
	Model     string
	Content   string
	ClientCtx ClientContext
	OnStart   func()
	OnUpdate  func(agenttypes.Event)
}

type CancelSessionTurnInput struct {
	RootID string
	Key    string
}

const (
	switchContextTailLines   = 20
	sessionNameTimeout       = 30 * time.Second
	sessionNameMaxRunes      = 24
	sessionNameMinMessageLen = 12
)

type SuggestSessionNameInput struct {
	RootID       string
	SessionKey   string
	Agent        string
	FirstMessage string
}

var (
	sessionSendLocksMu sync.Mutex
	sessionSendLocks   = make(map[string]*sync.Mutex)
	activeTurnsMu      sync.Mutex
	activeTurns        = make(map[string]*activeTurnState)
)

type activeTurnState struct {
	cancel  context.CancelFunc
	session agenttypes.Session
}

func getSessionSendLock(sessionKey string) *sync.Mutex {
	sessionSendLocksMu.Lock()
	defer sessionSendLocksMu.Unlock()
	lock := sessionSendLocks[sessionKey]
	if lock == nil {
		lock = &sync.Mutex{}
		sessionSendLocks[sessionKey] = lock
	}
	return lock
}

func activeTurnKey(rootID, sessionKey string) string {
	return rootID + "::" + sessionKey
}

func registerActiveTurn(rootID, sessionKey string, cancel context.CancelFunc) {
	if strings.TrimSpace(rootID) == "" || strings.TrimSpace(sessionKey) == "" || cancel == nil {
		return
	}
	activeTurnsMu.Lock()
	activeTurns[activeTurnKey(rootID, sessionKey)] = &activeTurnState{cancel: cancel}
	activeTurnsMu.Unlock()
}

func setActiveTurnSession(rootID, sessionKey string, sess agenttypes.Session) {
	if strings.TrimSpace(rootID) == "" || strings.TrimSpace(sessionKey) == "" || sess == nil {
		return
	}
	activeTurnsMu.Lock()
	state := activeTurns[activeTurnKey(rootID, sessionKey)]
	if state != nil {
		state.session = sess
	}
	activeTurnsMu.Unlock()
}

func unregisterActiveTurn(rootID, sessionKey string) {
	if strings.TrimSpace(rootID) == "" || strings.TrimSpace(sessionKey) == "" {
		return
	}
	activeTurnsMu.Lock()
	delete(activeTurns, activeTurnKey(rootID, sessionKey))
	activeTurnsMu.Unlock()
}

func getActiveTurn(rootID, sessionKey string) *activeTurnState {
	activeTurnsMu.Lock()
	defer activeTurnsMu.Unlock()
	return activeTurns[activeTurnKey(rootID, sessionKey)]
}

func agentPoolSessionKey(sessionKey, agentName string) string {
	trimmedSessionKey := strings.TrimSpace(sessionKey)
	if trimmedSessionKey == "" {
		return ""
	}
	trimmedAgent := strings.TrimSpace(agentName)
	if trimmedAgent == "" {
		return trimmedSessionKey
	}
	return strings.ToLower(trimmedAgent) + "-" + trimmedSessionKey
}

func calculateSwitchReadLines(total, lastCtxSeq int) int {
	delta := total - lastCtxSeq
	if delta < 0 {
		return 0
	}
	if delta > switchContextTailLines {
		return switchContextTailLines
	}
	return delta
}

func buildSwitchReadHint(exchangeLogPath string, lines int) string {
	return "This session was migrated from elsewhere. Your context may lag behind this session;\n" +
		"Before replying, read the last " + strconv.Itoa(lines) + " lines from " + exchangeLogPath + " to recover context.\n" +
		"If you still need more context, decide and read older history yourself.\n" +
		"When continuing to read, keep each backward batch to about " + strconv.Itoa(switchContextTailLines) + " lines.\n\n" +
		"Execution order: read history first, then compose the final answer.\n" +
		"Note: do not send any natural-language response before finishing the required history reads. Start reading immediately via tools/commands.\n" +
		"Only if reading fails, output a brief error and stop.\n\n"
}

func sessionNameRunner(ctx context.Context, pool *agent.Pool, rootAbs string, in SuggestSessionNameInput) (string, error) {
	agentName := strings.TrimSpace(in.Agent)
	if agentName == "" || pool == nil {
		return "", nil
	}

	sessionKey := agentPoolSessionKey("name-"+in.SessionKey, agentName)
	sess, err := pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{
		SessionKey: sessionKey,
		AgentName:  agentName,
		RootPath:   rootAbs,
	})
	if err != nil {
		return "", err
	}
	defer pool.Close(sessionKey)

	var response strings.Builder
	sess.OnUpdate(func(update agenttypes.Event) {
		if update.Type != agenttypes.EventTypeMessageChunk {
			return
		}
		chunk, ok := update.Data.(agenttypes.MessageChunk)
		if !ok {
			return
		}
		response.WriteString(chunk.Content)
	})

	if err := sess.SendMessage(ctx, buildSessionNamePrompt(normalizeSessionNameCandidate(in.FirstMessage))); err != nil {
		return "", err
	}
	return response.String(), nil
}

func (s *Service) SuggestSessionName(ctx context.Context, in SuggestSessionNameInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.RootID) == "" || strings.TrimSpace(in.SessionKey) == "" {
		return nil, nil
	}
	agentName := strings.TrimSpace(in.Agent)
	if agentName == "" {
		return nil, nil
	}
	message := normalizeSessionNameCandidate(in.FirstMessage)
	messageLen := len([]rune(message))
	if messageLen < sessionNameMinMessageLen {
		return nil, nil
	}

	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	current, err := manager.Get(ctx, in.SessionKey, 0)
	if err != nil {
		return nil, err
	}
	fallback := buildFallbackSessionName(in.FirstMessage)
	if strings.TrimSpace(current.Name) != fallback {
		return nil, nil
	}

	pool := s.Registry.GetAgentPool()
	if pool == nil {
		return nil, nil
	}

	rootAbs, err := manager.Root().RootDir()
	if err != nil {
		return nil, err
	}
	nameCtx, cancel := context.WithTimeout(ctx, sessionNameTimeout)
	defer cancel()

	rawName, err := sessionNameRunner(nameCtx, pool, rootAbs, in)
	if err != nil {
		log.Printf("[session-name] suggest.error root=%s session=%s agent=%s err=%v", in.RootID, in.SessionKey, agentName, err)
		if prober := s.Registry.GetProber(); prober != nil && !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
			prober.ReportFailure(agentName, err)
		}
		return nil, nil
	}
	if prober := s.Registry.GetProber(); prober != nil {
		prober.ReportSuccess(agentName)
	}

	name := normalizeSessionNameCandidate(rawName)
	if name == "" || name == fallback {
		return nil, nil
	}
	renamed, err := manager.Rename(ctx, in.SessionKey, name)
	if err != nil {
		log.Printf("[session-name] rename.error root=%s session=%s err=%v", in.RootID, in.SessionKey, err)
		return nil, err
	}
	log.Printf("[session-name] rename.done root=%s session=%s name=%q", in.RootID, in.SessionKey, renamed.Name)
	return renamed, nil
}

func buildFallbackSessionName(message string) string {
	oneLine := strings.Join(strings.Fields(strings.TrimSpace(message)), " ")
	if oneLine == "" {
		return ""
	}
	const max = 60
	runes := []rune(oneLine)
	if len(runes) <= max {
		return oneLine
	}
	return string(runes[:max]) + "..."
}

func buildSessionNamePrompt(message string) string {
	return strings.TrimSpace(strings.Join([]string{
		"Generate a concise session title for the user's first message.",
		"Rules:",
		"- Reply with the title only.",
		"- Single line only.",
		"- No quotes.",
		"- No trailing punctuation.",
		"- Keep it under 18 Chinese characters or 8 English words.",
		"",
		"User message:",
		message,
	}, "\n"))
}

func normalizeSessionNameCandidate(raw string) string {
	cleaned := strings.Join(strings.Fields(strings.TrimSpace(raw)), " ")
	cleaned = strings.Trim(cleaned, "\"'`“”‘’")
	cleaned = strings.TrimSpace(cleaned)
	cleaned = strings.TrimRight(cleaned, ".,;:!?，。；：！？")
	runes := []rune(cleaned)
	if len(runes) > sessionNameMaxRunes {
		return strings.TrimSpace(string(runes[:sessionNameMaxRunes]))
	}
	return cleaned
}

func isCanceledTurnError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	value := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(value, "context canceled") ||
		strings.Contains(value, "context cancelled") ||
		strings.Contains(value, "turn canceled") ||
		strings.Contains(value, "turn cancelled") ||
		strings.Contains(value, "cancelled")
}

func contextLineCount(exchanges []session.Exchange) int {
	return len(exchanges)
}

func buildUserPrompt(message string, clientCtx ClientContext) string {
	lines := []string{strings.TrimSpace(message)}
	if clientCtx.CurrentPath != "" || clientCtx.Selection != nil {
		lines = append(lines, "[USER_SELECTION]")

		selectedPath := clientCtx.CurrentPath
		if selectedPath == "" && clientCtx.Selection != nil {
			selectedPath = clientCtx.Selection.FilePath
		}
		if selectedPath != "" {
			lines = append(lines, "file: "+selectedPath)
		}

		if clientCtx.Selection != nil && (clientCtx.Selection.StartLine > 0 || clientCtx.Selection.EndLine > 0) {
			lines = append(lines, "line range: "+strconv.Itoa(clientCtx.Selection.StartLine)+"-"+strconv.Itoa(clientCtx.Selection.EndLine))
		}
		if clientCtx.Selection != nil && strings.TrimSpace(clientCtx.Selection.Text) != "" {
			lines = append(lines, "selected text: "+clientCtx.Selection.Text)
		}
	}
	return "[USER_INPUT]\n" + strings.Join(lines, "\n")
}

func buildPluginPrompt(catalogPrompt, userMessage string, isInitial bool) string {
	if isInitial {
		return buildPluginPromptInitial(catalogPrompt, userMessage)
	}
	return buildPluginPromptFollowup(userMessage)
}

func buildPluginPromptFollowup(userMessage string) string {
	systemPrompt := strings.TrimSpace(strings.Join([]string{
		"You are still in view-plugin development mode.",
		"Continue editing/refining the plugin under .mindfs/plugins/.",
		"",
		"Follow these strict constraints:",
		"- If the user explicitly asks to generate/update plugin code, output JS code only (no markdown fences, no explanation text).",
		"- If the user asks analysis/design/review questions, answer normally and do not output plugin code unless requested.",
		"- Use CommonJS: module.exports = { name, match, fileLoadMode, theme, process(file) { return { data?, tree } } }.",
		"- fileLoadMode must be \"incremental\" or \"full\".",
		"- theme is required with all keys: overlayBg, surfaceBg, surfaceBgElevated, text, textMuted, border, primary, primaryText, radius, shadow, focusRing, danger, warning, success.",
		"- Do not modify framework CSS/TS code.",
		"- Do not output global CSS overrides.",
		"- For dynamic interactions, use action \"navigate\" with params { path?, cursor?, query? }.",
	}, "\n"))

	return strings.Join([]string{
		"[SYSTEM_PROMPT]",
		systemPrompt,
		"",
		"[USER_PROMPT]",
		userMessage,
	}, "\n")
}

func buildPluginPromptInitial(catalogPrompt, userMessage string) string {
	systemPrompt := strings.TrimSpace(strings.Join([]string{
		"You are in view-plugin development mode.",
		"The user will describe requirements. Generate a view plugin and write it under .mindfs/plugins/.",
		"",
		"## Plugin Spec",
		"- Use CommonJS: module.exports = { name, match, fileLoadMode, theme, process(file) { return { data?, tree } } }",
		"- fileLoadMode: \"incremental\" | \"full\".",
		"- fileLoadMode controls how file content is loaded before process(file).",
		"- Use \"full\" for views that need global understanding of the file (chapter TOC, CSV table pagination/sort/filter, whole-document search).",
		"- Use \"incremental\" only for very large plain-text streaming/append-like views where byte-window loading is acceptable.",
		"- In \"full\" mode, plugin should treat input as whole-file content and should not rely on cursor.",
		"- If interaction is query-based pagination (page/pageSize), prefer \"full\" and update only query.",
		"- theme is required and must include all keys:",
		"  overlayBg, surfaceBg, surfaceBgElevated, text, textMuted, border,",
		"  primary, primaryText, radius, shadow, focusRing, danger, warning, success.",
		"- Do not modify framework CSS/TS code.",
		"- Do not output global CSS overrides.",
		"- Style customization must be done via theme tokens only.",
		"- file input: { name, path, content, ext, mime, size, truncated, next_cursor, query }",
		"- query comes from URL plugin params. Plugin reads file.query.<key> directly.",
		"- query is for business state only; do NOT store cursor in query.",
		"- Plugin must treat query as plain keys and must NOT depend on URL encoding details.",
		"- process must be a pure function (no external IO/state).",
		"- event bindings must use top-level `on` field, not inside `props`.",
		"- filename should be lowercase kebab-case, e.g. txt-novel.js",
		"",
		"## Match Rule",
		"- ext: \".txt\" or \".csv,.tsv\"",
		"- path: \"novels/**/*.txt\"",
		"- mime: \"text/*\"",
		"- name: \"README*\"",
		"- any/all for OR/AND composition",
		"",
		"## Output Requirement",
		"- Use available file-write tool(s) to write plugin file to .mindfs/plugins/<name>.js",
		"- tree must be valid UITree: root points to an existing element id",
		"- For dynamic interactions (pagination/sort/filter), use action: \"navigate\"",
		"- navigate params: { path?, cursor?, query? }",
		"- path: target file path (relative path under current root).",
		"- cursor: byte cursor used when re-reading the file.",
		"- query: plugin state map; after navigate, plugin reads it from file.query.",
		"- navigate usage examples:",
		"  - Change query only: { action: \"navigate\", params: { query: { page: 2 } } }",
		"  - Change cursor only: { action: \"navigate\", params: { cursor: 131072 } }",
		"  - Change both: { action: \"navigate\", params: { path: \"a.txt\", cursor: 0, query: { chapter: 1 } } }",
		"  - Incremental next chunk: read next cursor from file.next_cursor, then set navigate.params.cursor to that value.",
		"  - Example: { action: \"navigate\", params: { cursor: file.next_cursor } }",
		"- Plugin should always read current plugin state from file.query.",
		"- Return only JS plugin code. No markdown fences. No explanation text.",
		"",
		"## Responsive Breakpoints (required)",
		"- mobile: width < 768",
		"- tablet: 768 <= width < 1024",
		"- desktop: width >= 1024",
		"- Prefer single-column, tighter spacing, and larger touch targets on mobile",
		"- For wide tables/code blocks on mobile, provide horizontal scrolling or condensed fallback",
		"- Avoid fixed-width layouts that overflow small screens",
		"",
		"## Example Plugin (TXT Novel Reader)",
		"module.exports = {",
		"  name: \"TXT Novel Reader\",",
		"  match: { ext: \".txt\" },",
		"  fileLoadMode: \"full\",",
		"  theme: {",
		"    overlayBg: \"rgba(2,6,23,0.62)\",",
		"    surfaceBg: \"#f8fafc\",",
		"    surfaceBgElevated: \"#ffffff\",",
		"    text: \"#0f172a\",",
		"    textMuted: \"#475569\",",
		"    border: \"rgba(15,23,42,0.12)\",",
		"    primary: \"#2563eb\",",
		"    primaryText: \"#ffffff\",",
		"    radius: \"10px\",",
		"    shadow: \"0 16px 40px rgba(2,6,23,.22)\",",
		"    focusRing: \"rgba(37,99,235,.4)\",",
		"    danger: \"#dc2626\",",
		"    warning: \"#d97706\",",
		"    success: \"#16a34a\"",
		"  },",
		"  process(file) {",
		"    const content = typeof file.content === \"string\" ? file.content.replace(/\\r\\n?/g, \"\\n\") : \"\";",
		"    const query = file.query || {};",
		"    const lines = content.split(\"\\n\");",
		"    const chapterTitles = lines.filter((line) => /^\\s*第.+[章节回卷篇部]/.test(line.trim()));",
		"    const chapters = chapterTitles.length ? chapterTitles.map((title) => ({ title: title.trim(), text: content })) : [{ title: file.name ? String(file.name).replace(/\\.txt$/i, \"\") : \"正文\", text: content }];",
		"    const total = Math.max(1, chapters.length);",
		"    const chapterIdx = Math.min(Math.max(1, parseInt(query.chapter || \"1\", 10) || 1), total) - 1;",
		"    const current = chapters[chapterIdx] || { title: \"正文\", text: content };",
		"    const paragraphs = (current.text || \"\").split(\"\\n\").map(s => s.trim()).filter(Boolean).slice(0, 500);",
		"    const tocValue = String(query.toc || \"0\");",
		"    const showToc = tocValue !== \"0\";",
		"    const nextTocValue = String((parseInt(tocValue, 10) || 0) + 1);",
		"    return {",
		"      data: { ui: { tocOpen: showToc } },",
		"      tree: {",
		"        root: \"root\",",
		"        elements: {",
		"          root: { type: \"Stack\", props: { direction: \"vertical\", gap: \"sm\" }, children: [\"header\", \"nav-top\", \"content-card\", \"nav-bottom\", \"toc-dialog\"] },",
		"          header: { type: \"Stack\", props: { direction: \"horizontal\", gap: \"sm\", justify: \"between\", align: \"center\" }, children: [\"title\"] },",
		"          title: { type: \"Heading\", props: { text: current.title, level: \"h4\" }, children: [] },",
		"          \"nav-top\": { type: \"Stack\", props: { direction: \"horizontal\", gap: \"sm\", justify: \"between\" }, children: [\"prev-t\", \"toc-t\", \"next-t\"] },",
		"          \"nav-bottom\": { type: \"Stack\", props: { direction: \"horizontal\", gap: \"sm\", justify: \"between\" }, children: [\"prev-b\", \"toc-b\", \"next-b\"] },",
		"          \"prev-t\": { type: \"Button\", props: { label: \"上一章\", disabled: chapterIdx <= 0 }, on: { press: { action: \"navigate\", params: { query: { chapter: chapterIdx, toc: \"0\" } } } } },",
		"          \"toc-t\": { type: \"Button\", props: { label: \"目录\" }, on: { press: { action: \"navigate\", params: { query: { toc: nextTocValue } } } } },",
		"          \"next-t\": { type: \"Button\", props: { label: \"下一章\", disabled: chapterIdx >= total - 1 }, on: { press: { action: \"navigate\", params: { query: { chapter: chapterIdx + 2, toc: \"0\" } } } } },",
		"          \"prev-b\": { type: \"Button\", props: { label: \"上一章\", disabled: chapterIdx <= 0 }, on: { press: { action: \"navigate\", params: { query: { chapter: chapterIdx, toc: \"0\" } } } } },",
		"          \"toc-b\": { type: \"Button\", props: { label: \"目录\" }, on: { press: { action: \"navigate\", params: { query: { toc: nextTocValue } } } } },",
		"          \"next-b\": { type: \"Button\", props: { label: \"下一章\", disabled: chapterIdx >= total - 1 }, on: { press: { action: \"navigate\", params: { query: { chapter: chapterIdx + 2, toc: \"0\" } } } } },",
		"          \"content-card\": { type: \"Card\", props: { title: null, description: null, maxWidth: \"full\" }, children: [\"para-stack\"] },",
		"          \"para-stack\": { type: \"Stack\", props: { direction: \"vertical\", gap: \"sm\" }, children: paragraphs.map((_, i) => `p-${i}`) },",
		"          ...Object.fromEntries(paragraphs.map((line, i) => [`p-${i}`, { type: \"Text\", props: { text: line, variant: \"body\" }, children: [] }])),",
		"          \"toc-dialog\": { type: \"Dialog\", props: { title: \"章节目录\", openPath: \"/ui/tocOpen\" }, children: [\"toc-list\", \"toc-close\"] },",
		"          \"toc-list\": { type: \"Stack\", props: { direction: \"vertical\", gap: \"sm\" }, children: chapters.slice(0, 16).map((_, i) => `c-${i}`) },",
		"          ...Object.fromEntries(chapters.slice(0, 16).map((ch, i) => [`c-${i}`, { type: \"Button\", props: { label: `${i + 1}. ${ch.title}`, variant: i === chapterIdx ? \"primary\" : \"secondary\" }, on: { press: { action: \"navigate\", params: { query: { chapter: i + 1, toc: \"0\" } } } }, children: [] }])),",
		"          \"toc-close\": { type: \"Button\", props: { label: \"关闭\", variant: \"secondary\" }, on: { press: { action: \"navigate\", params: { query: { toc: \"0\" } } } }, children: [] }",
		"        }",
		"      }",
		"    };",
		"  }",
		"};",
		"",
		"## Available Components Catalog",
		catalogPrompt,
	}, "\n"))

	return strings.Join([]string{
		"[SYSTEM_PROMPT]",
		systemPrompt,
		"",
		"[USER_PROMPT]",
		userMessage,
	}, "\n")
}

func (s *Service) ensureAgentSession(
	ctx context.Context,
	pool *agent.Pool,
	current *session.Session,
	agentName string,
	model string,
	rootAbs string,
) (agenttypes.Session, error) {
	poolSessionKey := agentPoolSessionKey(current.Key, agentName)
	nextModel := strings.TrimSpace(model)
	currentModel := ""
	if current != nil {
		currentModel = strings.TrimSpace(current.Model)
	}
	if current != nil && currentModel != nextModel {
		log.Printf("[session/model] switch.detected session=%s agent=%s from=%q to=%q action=close_runtime_session", current.Key, agentName, currentModel, nextModel)
		pool.Close(poolSessionKey)
	}
	if existing, ok := pool.Get(poolSessionKey); ok {
		return existing, nil
	}

	openCtx := pool.Context()
	if openCtx == nil {
		openCtx = ctx
	}

	openInput := agenttypes.OpenSessionInput{
		SessionKey: poolSessionKey,
		AgentName:  agentName,
		Model:      nextModel,
		RootPath:   rootAbs,
	}
	log.Printf("[session/model] open session=%s agent=%s model=%q pool_session=%s", current.Key, agentName, nextModel, poolSessionKey)
	sess, err := pool.GetOrCreate(openCtx, openInput)
	if err != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportFailure(agentName, err)
		}
		log.Printf("[session/model] open.error session=%s agent=%s model=%q pool_session=%s err=%v", current.Key, agentName, nextModel, poolSessionKey, err)
		return nil, err
	}
	log.Printf("[session/model] open.done session=%s agent=%s model=%q runtime_session=%s pool_session=%s", current.Key, agentName, nextModel, sess.SessionID(), poolSessionKey)
	return sess, nil
}

func (s *Service) SendMessage(ctx context.Context, in SendMessageInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	if err := s.validateAgentModel(in.Agent, in.Model); err != nil {
		log.Printf("[session/model] validate.error root=%s session=%s agent=%s model=%q err=%v", in.RootID, in.Key, strings.TrimSpace(in.Agent), strings.TrimSpace(in.Model), err)
		return err
	}
	turnCtx, turnCancel := context.WithCancel(ctx)
	registerActiveTurn(in.RootID, in.Key, turnCancel)
	defer unregisterActiveTurn(in.RootID, in.Key)
	sendLock := getSessionSendLock(in.Key)
	sendLock.Lock()
	defer sendLock.Unlock()
	if in.OnStart != nil {
		in.OnStart()
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return err
	}
	isInitial := len(current.Exchanges) == 0
	agentPool := s.Registry.GetAgentPool()
	if agentPool == nil {
		return nil
	}
	watcher, _ := s.Registry.GetFileWatcher(in.RootID, manager)
	if watcher != nil {
		watcher.RegisterSession(current.Key)
		watcher.MarkSessionActive(current.Key)
	}
	root := manager.Root()
	rootAbs, _ := root.RootDir()
	sess, err := s.ensureAgentSession(turnCtx, agentPool, current, in.Agent, in.Model, rootAbs)
	if err != nil {
		return err
	}
	setActiveTurnSession(in.RootID, current.Key, sess)

	prompt := s.BuildPrompt(BuildPromptInput{
		Session:       current,
		Manager:       manager,
		Agent:         in.Agent,
		Message:       in.Content,
		ClientContext: in.ClientCtx,
		IsInitial:     isInitial,
	})
	var responseText string
	sess.OnUpdate(func(update agenttypes.Event) {
		if update.Type == agenttypes.EventTypeMessageChunk {
			if chunk, ok := update.Data.(agenttypes.MessageChunk); ok && chunk.IsLowValue() {
				return
			}
		}
		if update.Type == agenttypes.EventTypeToolCall || update.Type == agenttypes.EventTypeToolUpdate {
			if toolCall, ok := update.Data.(agenttypes.ToolCall); ok && toolCall.IsWriteOperation() {
				for _, path := range toolCall.GetAffectedPaths() {
					if watcher == nil {
						continue
					}
					if update.Type == agenttypes.EventTypeToolCall && toolCall.Status == "running" {
						watcher.RecordPendingWrite(current.Key, path)
					}
					if update.Type == agenttypes.EventTypeToolUpdate || toolCall.Status == "complete" {
						watcher.RecordSessionFile(current.Key, path)
					}
				}
			}
		}
		if update.Type == agenttypes.EventTypeMessageChunk {
			if chunk, ok := update.Data.(agenttypes.MessageChunk); ok {
				responseText += chunk.Content
			}
		}
		if watcher != nil {
			watcher.MarkSessionActive(current.Key)
		}
		if in.OnUpdate != nil {
			in.OnUpdate(update)
		}
	})
	sendErr := sess.SendMessage(turnCtx, prompt)
	if err := manager.UpdateModel(ctx, current, in.Model); err != nil {
		return err
	}
	if err := manager.AddExchangeForAgent(ctx, current, "user", in.Content, in.Agent); err != nil {
		return err
	}

	prober := s.Registry.GetProber()
	if sendErr != nil && !isCanceledTurnError(sendErr) {
		if prober != nil {
			prober.ReportFailure(in.Agent, sendErr)
		}
		return sendErr
	} else if prober != nil {
		prober.ReportSuccess(in.Agent)
	}

	err = s.appendAgentReply(ctx, manager, current, in.Agent, responseText)
	if err != nil {
		return err
	}
	manager.UpdateAgentState(ctx, current, in.Agent, contextLineCount(current.Exchanges))
	return nil
}

func (s *Service) validateAgentModel(agentName, model string) error {
	agentName = strings.TrimSpace(agentName)
	model = strings.TrimSpace(model)
	if agentName == "" || model == "" || s.Registry == nil {
		return nil
	}
	prober := s.Registry.GetProber()
	if prober == nil {
		return nil
	}
	status, ok := prober.GetStatus(agentName)
	if !ok || len(status.Models) == 0 {
		return nil
	}
	for _, item := range status.Models {
		if strings.TrimSpace(item.ID) == model {
			return nil
		}
	}
	return fmt.Errorf("model %q is not supported by agent %q", model, agentName)
}

func (s *Service) CancelSessionTurn(ctx context.Context, in CancelSessionTurnInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return err
	}
	active := getActiveTurn(in.RootID, current.Key)
	if active == nil {
		return nil
	}
	active.cancel()
	if active.session != nil {
		return active.session.CancelCurrentTurn()
	}
	return nil
}
