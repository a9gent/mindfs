package usecase

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/commandexec"
	"mindfs/server/internal/session"
)

type ClientContext struct {
	CurrentRoot   string     `json:"current_root"`
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

type SearchSessionsInput struct {
	RootID string
	Query  string
	Limit  int
}

type SearchSessionsOutput struct {
	Items []session.SearchHit
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
	for _, item := range items {
		if item == nil || item.Type != session.TypeCommand {
			continue
		}
		aux, err := manager.GetExchangeAux(ctx, item.Key, 0)
		if err != nil {
			return ListSessionsOutput{}, err
		}
		item.Shell = session.InferCommandShellFromAux(aux)
	}
	return ListSessionsOutput{Sessions: items}, nil
}

func (s *Service) SearchSessions(ctx context.Context, in SearchSessionsInput) (SearchSessionsOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SearchSessionsOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return SearchSessionsOutput{}, err
	}
	items, err := manager.Search(ctx, session.SearchOptions{
		Query: in.Query,
		Limit: in.Limit,
	})
	if err != nil {
		return SearchSessionsOutput{}, err
	}
	return SearchSessionsOutput{Items: items}, nil
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

type ForkSessionInput struct {
	RootID string
	Key    string
	Seq    int
}

type ForkSessionOutput struct {
	Session *session.Session
}

func (s *Service) ForkSession(ctx context.Context, in ForkSessionInput) (ForkSessionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ForkSessionOutput{}, err
	}
	if strings.TrimSpace(in.Key) == "" {
		return ForkSessionOutput{}, errors.New("session key required")
	}
	if in.Seq <= 0 {
		return ForkSessionOutput{}, errors.New("seq required")
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	target, agentTurnIndex, err := resolveForkTarget(current, in.Seq)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	agentName := strings.TrimSpace(target.Agent)
	if agentName == "" {
		agentName = strings.TrimSpace(session.InferAgentFromSession(current))
	}
	if agentName == "" {
		return ForkSessionOutput{}, errors.New("agent not found for fork target")
	}
	binding, err := manager.FindAgentBinding(ctx, current.Key, agentName)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	if binding == nil || strings.TrimSpace(binding.AgentSessionID) == "" {
		return ForkSessionOutput{}, errors.New("agent session binding not found")
	}
	pool := s.Registry.GetAgentPool()
	if pool == nil {
		return ForkSessionOutput{}, errors.New("agent pool not configured")
	}
	isACP := isACPAgent(pool, agentName)
	var forkPoint agenttypes.ResolveForkPointOutput
	if !isACP {
		importer, err := s.resolveExternalSessionImporter(agentName)
		if err != nil {
			return ForkSessionOutput{}, err
		}
		resolver, ok := importer.(agenttypes.ForkPointResolver)
		if !ok {
			return ForkSessionOutput{}, errors.New("agent does not support fork point resolution")
		}
		forkPoint, err = resolver.ResolveForkPointByAgentTurnIndex(ctx, agenttypes.ResolveForkPointInput{
			RootPath:       root.RootPath,
			AgentSessionID: binding.AgentSessionID,
			AgentTurnIndex: agentTurnIndex,
		})
		if err != nil {
			return ForkSessionOutput{}, err
		}
	}
	sourceJSON, err := json.Marshal(map[string]any{
		"type":             "fork",
		"session_key":      current.Key,
		"seq":              target.Seq,
		"agent":            agentName,
		"agent_session_id": binding.AgentSessionID,
	})
	if err != nil {
		return ForkSessionOutput{}, err
	}
	created, err := manager.Create(ctx, session.CreateInput{
		Type:             session.TypeChat,
		ParentSessionKey: current.Key,
		Source:           string(sourceJSON),
		Agent:            agentName,
		Model:            resolveForkModel(current, target),
		Name:             buildForkSessionName(current, target.Seq),
		PlanMode:         current.PlanMode,
	})
	if err != nil {
		return ForkSessionOutput{}, err
	}
	copiedCount, err := copyForkHistory(ctx, manager, current, created, target.Seq, agentName)
	if err != nil {
		_ = manager.Delete(ctx, created.Key)
		return ForkSessionOutput{}, err
	}
	openCtx := pool.Context()
	if openCtx == nil {
		openCtx = ctx
	}
	agentCtxSeq := copiedCount
	if isACP {
		agentCtxSeq = 0
	}
	sess, err := pool.GetOrCreate(openCtx, agenttypes.OpenSessionInput{
		SessionKey:     agentPoolSessionKey(created.Key, agentName),
		AgentName:      agentName,
		Model:          resolveForkModel(current, target),
		Mode:           strings.TrimSpace(target.Mode),
		Effort:         strings.TrimSpace(target.Effort),
		FastService:    strings.TrimSpace(target.FastService),
		PlanMode:       current.PlanMode,
		RootPath:       root.RootPath,
		AgentSessionID: "",
		AgentCtxSeq:    agentCtxSeq,
		ForkPoint:      forkPoint,
	})
	if err != nil {
		_ = manager.Delete(ctx, created.Key)
		return ForkSessionOutput{}, err
	}
	agentSessionID := strings.TrimSpace(sess.SessionID())
	if agentSessionID == "" {
		_ = manager.Delete(ctx, created.Key)
		return ForkSessionOutput{}, errors.New("forked agent session id not found")
	}
	latest, err := manager.Get(ctx, created.Key, 0)
	if err != nil {
		_ = manager.Delete(ctx, created.Key)
		return ForkSessionOutput{}, err
	}
	if err := manager.UpdateAgentState(ctx, latest, agentName, agentCtxSeq, agentSessionID); err != nil {
		_ = manager.Delete(ctx, created.Key)
		return ForkSessionOutput{}, err
	}
	out, err := manager.Get(ctx, created.Key, 0)
	if err != nil {
		return ForkSessionOutput{}, err
	}
	log.Printf("[session/fork] done root=%s parent=%s child=%s agent=%s seq=%d turn=%d source_agent_session=%s fork_agent_session=%s", strings.TrimSpace(in.RootID), current.Key, out.Key, agentName, target.Seq, agentTurnIndex, binding.AgentSessionID, agentSessionID)
	return ForkSessionOutput{Session: out}, nil
}

func isACPAgent(pool *agent.Pool, agentName string) bool {
	if pool == nil {
		return false
	}
	def, ok := pool.Config().GetAgent(agentName)
	if !ok {
		return false
	}
	protocol := def.Protocol
	if protocol == "" {
		protocol = agent.DefaultProtocol(agentName)
	}
	return protocol == agent.ProtocolACP
}

func resolveForkTarget(current *session.Session, seq int) (session.Exchange, int, error) {
	if current == nil {
		return session.Exchange{}, 0, errors.New("session required")
	}
	var target session.Exchange
	found := false
	for _, exchange := range current.Exchanges {
		if exchange.Seq == seq {
			target = exchange
			found = true
			break
		}
	}
	if !found {
		return session.Exchange{}, 0, errors.New("message not found")
	}
	if !isAgentExchangeRole(target.Role) {
		return session.Exchange{}, 0, errors.New("fork target must be an agent message")
	}
	agentName := strings.TrimSpace(target.Agent)
	if agentName == "" {
		agentName = strings.TrimSpace(session.InferAgentFromSession(current))
	}
	turnIndex := 0
	for _, exchange := range current.Exchanges {
		if exchange.Seq > target.Seq {
			break
		}
		if !isAgentExchangeRole(exchange.Role) {
			continue
		}
		exchangeAgent := strings.TrimSpace(exchange.Agent)
		if agentName != "" && exchangeAgent != "" && exchangeAgent != agentName {
			continue
		}
		turnIndex++
	}
	if turnIndex <= 0 {
		return session.Exchange{}, 0, errors.New("agent turn not found")
	}
	return target, turnIndex, nil
}

func isAgentExchangeRole(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "agent", "assistant":
		return true
	default:
		return false
	}
}

func resolveForkModel(current *session.Session, target session.Exchange) string {
	if model := strings.TrimSpace(target.Model); model != "" {
		return model
	}
	if current == nil {
		return ""
	}
	return strings.TrimSpace(current.Model)
}

func buildForkSessionName(current *session.Session, seq int) string {
	base := "Fork"
	if current != nil && strings.TrimSpace(current.Name) != "" {
		base = strings.TrimSpace(current.Name)
	}
	if seq > 0 {
		name := fmt.Sprintf("%s#%d", base, seq)
		runes := []rune(name)
		if len(runes) > 80 {
			name = string(runes[:80])
		}
		return name
	}
	name := base
	runes := []rune(name)
	if len(runes) > 80 {
		name = string(runes[:80])
	}
	return name
}

func copyForkHistory(ctx context.Context, manager *session.Manager, from, to *session.Session, maxSeq int, fallbackAgent string) (int, error) {
	if manager == nil || from == nil || to == nil {
		return 0, errors.New("session required")
	}
	seqMap := make(map[int]int)
	copied := 0
	for _, exchange := range from.Exchanges {
		if exchange.Seq <= 0 || exchange.Seq > maxSeq {
			continue
		}
		agentName := strings.TrimSpace(exchange.Agent)
		if agentName == "" {
			agentName = strings.TrimSpace(fallbackAgent)
		}
		if err := manager.AddExchangeForAgentAt(ctx, to, exchange.Role, exchange.Content, agentName, exchange.Mode, exchange.Effort, exchange.FastService, exchange.Timestamp); err != nil {
			return copied, err
		}
		copied++
		seqMap[exchange.Seq] = copied
	}
	auxBySeq, err := manager.GetExchangeAux(ctx, from.Key, 0)
	if err != nil {
		return copied, err
	}
	for oldSeq, items := range auxBySeq {
		newSeq := seqMap[oldSeq]
		if newSeq <= 0 {
			continue
		}
		for _, aux := range items {
			next := aux
			next.Seq = newSeq
			if err := manager.AddExchangeAux(ctx, to.Key, next); err != nil {
				return copied, err
			}
		}
	}
	return copied, nil
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

type GetSessionExchangeAuxInput struct {
	RootID string
	Key    string
	Seq    int
}

func (s *Service) GetSessionExchangeAux(ctx context.Context, in GetSessionExchangeAuxInput) (map[int][]session.ExchangeAux, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.GetExchangeAux(ctx, in.Key, in.Seq)
}

type GetSessionToolCallInput struct {
	RootID string
	Key    string
	CallID string
}

func (s *Service) GetSessionToolCall(ctx context.Context, in GetSessionToolCallInput) (*agenttypes.ToolCall, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.GetFullToolCall(ctx, in.Key, in.CallID)
}

type GetSessionContextWindowInput struct {
	RootID string
	Key    string
}

func (s *Service) GetSessionContextWindow(ctx context.Context, in GetSessionContextWindowInput) (agenttypes.ContextWindow, error) {
	if err := s.ensureRegistry(); err != nil {
		return agenttypes.ContextWindow{}, err
	}
	if strings.TrimSpace(in.Key) == "" {
		return agenttypes.ContextWindow{}, errors.New("session key required")
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return agenttypes.ContextWindow{}, err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return agenttypes.ContextWindow{}, err
	}
	pool := s.Registry.GetAgentPool()
	if pool == nil {
		return agenttypes.ContextWindow{}, nil
	}
	agentName := strings.TrimSpace(session.InferAgentFromSession(current))
	if agentName == "" {
		return agenttypes.ContextWindow{}, nil
	}
	sess, ok := pool.Get(agentPoolSessionKey(in.Key, agentName))
	if !ok || sess == nil {
		return agenttypes.ContextWindow{}, nil
	}
	return sess.ContextWindow(ctx)
}

type GetSessionRelatedFilesInput struct {
	RootID string
	Key    string
}

func (s *Service) GetSessionRelatedFiles(ctx context.Context, in GetSessionRelatedFilesInput) ([]session.RelatedFile, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	current, err := manager.Get(ctx, in.Key, 0)
	if err != nil {
		return nil, err
	}
	return append([]session.RelatedFile(nil), current.RelatedFiles...), nil
}

type RemoveSessionRelatedFileInput struct {
	RootID string
	Key    string
	Path   string
}

func (s *Service) RemoveSessionRelatedFile(ctx context.Context, in RemoveSessionRelatedFileInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	return manager.RemoveRelatedFile(ctx, in.Key, in.Path)
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
	keys, err := deleteSessionCascadeKeys(ctx, manager, in.Key)
	if err != nil {
		return err
	}
	for _, key := range keys {
		cancelActiveSessionTurn(in.RootID, key)
	}
	for _, key := range keys {
		if err := manager.Delete(ctx, key); err != nil {
			return err
		}
		if err := root.RemoveSessionFileMeta(key); err != nil {
			return err
		}
		commandexec.CloseSession(in.RootID, key)
		s.Registry.ReleaseFileWatcher(in.RootID, key)
	}
	return nil
}

func deleteSessionCascadeKeys(ctx context.Context, manager *session.Manager, key string) ([]string, error) {
	rootKey := strings.TrimSpace(key)
	if rootKey == "" {
		return nil, errors.New("session key required")
	}
	items, err := manager.ListMetas(ctx)
	if err != nil {
		return nil, err
	}
	childrenByParent := make(map[string][]string)
	exists := false
	for _, item := range items {
		if item == nil {
			continue
		}
		itemKey := strings.TrimSpace(item.Key)
		if itemKey == "" {
			continue
		}
		if itemKey == rootKey {
			exists = true
		}
		parentKey := strings.TrimSpace(item.ParentSessionKey)
		if parentKey != "" {
			childrenByParent[parentKey] = append(childrenByParent[parentKey], itemKey)
		}
	}
	if !exists {
		return nil, errors.New("session not found")
	}
	keys := make([]string, 0, 1)
	seen := make(map[string]bool)
	var visit func(string)
	visit = func(current string) {
		if seen[current] {
			return
		}
		seen[current] = true
		for _, childKey := range childrenByParent[current] {
			visit(childKey)
		}
		keys = append(keys, current)
	}
	visit(rootKey)
	return keys, nil
}

func cancelActiveSessionTurn(rootID, sessionKey string) {
	active := getActiveTurn(rootID, sessionKey)
	if active == nil {
		return
	}
	active.cancel()
	if active.session != nil {
		if err := active.session.CancelCurrentTurn(); err != nil {
			log.Printf("[session] turn.cancel.error root=%s session=%s err=%v", rootID, sessionKey, err)
		}
	}
}

type RenameSessionInput struct {
	RootID string
	Key    string
	Name   string
}

func (s *Service) RenameSession(ctx context.Context, in RenameSessionInput) (*session.Session, error) {
	if err := s.ensureRegistry(); err != nil {
		return nil, err
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return nil, err
	}
	return manager.Rename(ctx, in.Key, in.Name)
}

type BuildPromptInput struct {
	Session       *session.Session
	Manager       *session.Manager
	Agent         string
	Message       string
	ClientContext ClientContext
	AgentCtxSeq   *int
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
	last := 0
	if in.AgentCtxSeq != nil {
		last = *in.AgentCtxSeq
	} else {
		last = in.Session.AgentCtxSeq[currentAgent]
	}
	linesToRead := calculateSwitchReadLines(total, last)
	if linesToRead <= 0 {
		return prompt
	}
	logPath := in.Manager.ExchangeLogPath(in.Session.Key)
	readHint := buildSwitchReadHint(logPath, linesToRead)
	return readHint + prompt
}

type SendMessageInput struct {
	RootID              string
	Key                 string
	Agent               string
	Model               string
	Mode                string
	Effort              string
	FastService         string
	Shell               string
	TerminalCols        int
	Content             string
	ClientCtx           ClientContext
	OnStart             func()
	OnUpdate            func(agenttypes.Event)
	OnSubSessionCreated func(*session.Session)
	OnSubSessionUpdate  func(sessionKey string, update agenttypes.Event)
}

var activeSubagentSubscriptions sync.Map

type AnswerQuestionInput struct {
	RootID     string
	SessionKey string
	Agent      string
	ToolUseID  string
	Answers    map[string]string
}

type CancelSessionTurnInput struct {
	RootID string
	Key    string
}

const (
	switchContextTailLines   = 20
	sessionNameTimeout       = 30 * time.Second
	sessionNameMinMessageLen = 12
	sessionRecoveryAttempts  = 3
	sessionRecoveryDelay     = 30 * time.Second
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

	tmpRoot, err := agent.EnsureStableWorkDir("title-rename", agentName)
	if err != nil {
		return "", err
	}

	sessionKey := agentPoolSessionKey("name-"+in.SessionKey, agentName)
	sess, err := pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{
		SessionKey: sessionKey,
		AgentName:  agentName,
		RootPath:   tmpRoot,
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
	if sessionNameScore(message) < sessionNameMinMessageLen {
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
	fallback := BuildFallbackSessionName(in.FirstMessage)
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
			prober.ReportRuntimeFailure(agentName, err)
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

func BuildFallbackSessionName(message string) string {
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
	return cleaned
}

func sessionNameScore(message string) int {
	score := 0
	tokenRun := 0

	flushTokenRun := func() {
		if tokenRun == 0 {
			return
		}
		score++
		tokenRun = 0
	}

	for _, r := range message {
		switch {
		case isSessionNameTokenRune(r):
			tokenRun++
		default:
			flushTokenRun()
			if unicode.IsSpace(r) || unicode.IsPunct(r) {
				continue
			}
			score++
		}
	}
	flushTokenRun()
	return score
}

func isSessionNameTokenRune(r rune) bool {
	if r > unicode.MaxASCII {
		return false
	}
	return unicode.IsLetter(r) || unicode.IsDigit(r)
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

func isNonRecoverableAgentError(err error) bool {
	if err == nil {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(err.Error()))
	if value == "" {
		return false
	}
	needles := []string{
		"429",
		"too many requests",
		"exceeded retry limit",
		"rate limit",
		"ratelimit",
		"usage limit",
		"usagelimitexceeded",
		"remote compaction failed",
		"compact_remote",
		"responsetoomanyfailedattempts",
	}
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}

func cancelRuntimeAfterNonRecoverableError(sess agenttypes.Session, pool *agent.Pool, agentName string, cause error) {
	agentName = strings.TrimSpace(agentName)
	if sess != nil {
		if err := sess.CancelCurrentTurn(); err != nil {
			log.Printf("[session] turn.cancel_after_non_recoverable.error agent=%s cause=%v err=%v", agentName, cause, err)
		}
	}
	if pool != nil && agentName != "" {
		if _, ok := pool.KillAgentProcess(agentName, 0); ok {
			log.Printf("[session] runtime.kill_after_non_recoverable.done agent=%s cause=%v", agentName, cause)
			return
		}
	}
	if sess != nil {
		if err := sess.Close(); err != nil {
			log.Printf("[session] runtime.close_after_non_recoverable.error agent=%s cause=%v err=%v", agentName, cause, err)
		}
	}
}

func contextLineCount(exchanges []session.Exchange) int {
	return len(exchanges)
}

func buildUserPrompt(message string, clientCtx ClientContext) string {
	lines := []string{strings.TrimSpace(message)}
	if clientCtx.Selection != nil {
		lines = append(lines, "[USER_SELECTION]")
		if clientCtx.Selection.FilePath != "" {
			lines = append(lines, "file: "+clientCtx.Selection.FilePath)
		}
		if clientCtx.Selection.StartLine > 0 || clientCtx.Selection.EndLine > 0 {
			lines = append(lines, "line range: "+strconv.Itoa(clientCtx.Selection.StartLine)+"-"+strconv.Itoa(clientCtx.Selection.EndLine))
		}
		if strings.TrimSpace(clientCtx.Selection.Text) != "" {
			lines = append(lines, "selected text: "+clientCtx.Selection.Text)
		}
	}
	return strings.Join(lines, "\n")
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
		"- Use CommonJS: module.exports = { name, match, fileLoadMode, theme, process(file) { return { data?, tree } }, viewContext?(file) { return string | object } }.",
		"- fileLoadMode must be \"incremental\" or \"full\".",
		"- theme is required with all keys: overlayBg, surfaceBg, surfaceBgElevated, text, textMuted, border, primary, primaryText, radius, shadow, focusRing, danger, warning, success.",
		"- Optional viewContext(file) returns concise current-view context for agent conversations when this plugin view is active.",
		"- viewContext should describe current view state, not duplicate large visible content; selected text is attached separately by the app.",
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
		"- Use CommonJS: module.exports = { name, match, fileLoadMode, theme, process(file) { return { data?, tree } }, viewContext?(file) { return string | object } }",
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
		"- Optional viewContext(file) should also be pure. It may return a string or object with concise current-view context for agent conversations.",
		"- Use viewContext for state such as current page/chapter/filter/sort. Do not include large visible content; selected text is attached separately by the app.",
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
		"  },",
		"  viewContext(file) {",
		"    const query = file.query || {};",
		"    return `文件：${file.path || file.name}\\n当前章节：${query.chapter || \"1\"}`;",
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
	manager *session.Manager,
	current *session.Session,
	agentName string,
	model string,
	mode string,
	effort string,
	fastService string,
	rootAbs string,
) (agenttypes.Session, *int, error) {
	poolSessionKey := agentPoolSessionKey(current.Key, agentName)
	nextModel := resolveRuntimeModel(current, nil, model)
	nextMode := resolveRuntimeMode(current, mode)
	nextEffort := resolveRuntimeEffort(agentName, current, effort)
	nextFastService := resolveRuntimeFastService(agentName, current, fastService)
	nextPlanMode := current != nil && current.PlanMode
	currentModel := ""
	currentMode := ""
	currentEffort := ""
	currentFastService := ""
	currentPlanMode := false
	if current != nil {
		currentModel = resolveSessionExchangeModel(current)
		if currentModel == "" {
			currentModel = strings.TrimSpace(current.Model)
		}
		currentMode = resolveSessionExchangeMode(current)
		currentEffort = session.InferEffortFromSession(current)
		currentFastService = inferFastServiceFromSession(current)
		currentPlanMode = current.PlanMode
	}
	if existing, ok := pool.Get(poolSessionKey); ok {
		if !shouldReopenSessionForSetting(pool, agentName, currentEffort, nextEffort) &&
			currentFastService == nextFastService {
			if current != nil && currentModel != nextModel {
				log.Printf("[session/model] switch.detected session=%s agent=%s from=%q to=%q action=set_runtime_model", current.Key, agentName, currentModel, nextModel)
				if err := existing.SetModel(ctx, nextModel); err != nil {
					if prober := s.Registry.GetProber(); prober != nil {
						prober.ReportRuntimeFailure(agentName, err)
					}
					log.Printf("[session/model] switch.error session=%s agent=%s model=%q pool_session=%s err=%v", current.Key, agentName, nextModel, poolSessionKey, err)
					return nil, nil, err
				}
				log.Printf("[session/model] switch.done session=%s agent=%s model=%q pool_session=%s", current.Key, agentName, nextModel, poolSessionKey)
			}
			if current != nil && currentMode != nextMode {
				log.Printf("[session/mode] switch.detected session=%s agent=%s from=%q to=%q action=set_runtime_mode", current.Key, agentName, currentMode, nextMode)
				if err := existing.SetMode(ctx, nextMode); err != nil {
					if prober := s.Registry.GetProber(); prober != nil {
						prober.ReportRuntimeFailure(agentName, err)
					}
					log.Printf("[session/mode] switch.error session=%s agent=%s mode=%q pool_session=%s err=%v", current.Key, agentName, nextMode, poolSessionKey, err)
					return nil, nil, err
				}
				log.Printf("[session/mode] switch.done session=%s agent=%s mode=%q pool_session=%s", current.Key, agentName, nextMode, poolSessionKey)
			}
			if current != nil && currentPlanMode != nextPlanMode {
				log.Printf("[session/plan] switch.detected session=%s agent=%s from=%t to=%t action=set_plan_mode", current.Key, agentName, currentPlanMode, nextPlanMode)
				if err := existing.SetPlanMode(ctx, nextPlanMode); err != nil {
					if prober := s.Registry.GetProber(); prober != nil {
						prober.ReportRuntimeFailure(agentName, err)
					}
					log.Printf("[session/plan] switch.error session=%s agent=%s plan_mode=%t pool_session=%s err=%v", current.Key, agentName, nextPlanMode, poolSessionKey, err)
					return nil, nil, err
				}
				log.Printf("[session/plan] switch.done session=%s agent=%s plan_mode=%t pool_session=%s", current.Key, agentName, nextPlanMode, poolSessionKey)
			}
			var currentSeq *int
			if current != nil {
				last := current.AgentCtxSeq[agentName]
				currentSeq = &last
			}
			return existing, currentSeq, nil
		}
		log.Printf("[session/settings] reopen.detected session=%s agent=%s effort_from=%q effort_to=%q fast_service_from=%q fast_service_to=%q action=resume_runtime_session", current.Key, agentName, currentEffort, nextEffort, currentFastService, nextFastService)
		pool.Close(poolSessionKey)
	}

	openCtx := pool.Context()
	if openCtx == nil {
		openCtx = ctx
	}

	var binding *session.AgentBinding
	if manager != nil {
		var err error
		binding, err = manager.FindAgentBinding(ctx, current.Key, agentName)
		if err != nil {
			return nil, nil, err
		}
	}

	openInput := agenttypes.OpenSessionInput{
		SessionKey:  poolSessionKey,
		AgentName:   agentName,
		Model:       nextModel,
		Mode:        nextMode,
		Effort:      nextEffort,
		FastService: nextFastService,
		PlanMode:    nextPlanMode,
		RootPath:    rootAbs,
		AgentSessionID: strings.TrimSpace(func() string {
			if binding == nil {
				return ""
			}
			return binding.AgentSessionID
		}()),
		AgentCtxSeq: func() int {
			if binding == nil {
				return 0
			}
			return binding.AgentCtxSeq
		}(),
	}
	if openInput.AgentSessionID != "" {
		log.Printf("[session/model] open session=%s agent=%s model=%q mode=%q effort=%q fast_service=%q pool_session=%s action=resume_runtime_session agent_session_id=%s agent_ctx_seq=%d", current.Key, agentName, nextModel, nextMode, nextEffort, nextFastService, poolSessionKey, openInput.AgentSessionID, openInput.AgentCtxSeq)
	} else {
		log.Printf("[session/model] open session=%s agent=%s model=%q mode=%q effort=%q fast_service=%q pool_session=%s action=open_new_runtime_session", current.Key, agentName, nextModel, nextMode, nextEffort, nextFastService, poolSessionKey)
	}
	sess, err := pool.GetOrCreate(openCtx, openInput)
	var ctxSeqOverride *int
	if err != nil {
		if openInput.AgentSessionID != "" {
			log.Printf("[session/model] resume.error session=%s agent=%s model=%q mode=%q effort=%q fast_service=%q pool_session=%s agent_session_id=%s err=%v fallback=open_new_runtime_session", current.Key, agentName, nextModel, nextMode, nextEffort, nextFastService, poolSessionKey, openInput.AgentSessionID, err)
			openInput.AgentSessionID = ""
			openInput.AgentCtxSeq = 0
			sess, err = pool.GetOrCreate(openCtx, openInput)
			if err == nil {
				zero := 0
				ctxSeqOverride = &zero
			}
		}
	}
	if err != nil {
		if prober := s.Registry.GetProber(); prober != nil {
			prober.ReportRuntimeFailure(agentName, err)
		}
		log.Printf("[session/model] open.error session=%s agent=%s model=%q mode=%q effort=%q fast_service=%q pool_session=%s err=%v", current.Key, agentName, nextModel, nextMode, nextEffort, nextFastService, poolSessionKey, err)
		return nil, nil, err
	}
	if ctxSeqOverride == nil && binding != nil && openInput.AgentSessionID != "" {
		last := binding.AgentCtxSeq
		ctxSeqOverride = &last
	}
	log.Printf("[session/model] open.done session=%s agent=%s model=%q mode=%q effort=%q fast_service=%q pool_session=%s", current.Key, agentName, nextModel, nextMode, nextEffort, nextFastService, poolSessionKey)
	return sess, ctxSeqOverride, nil
}

func shouldReopenSessionForSetting(pool *agent.Pool, agentName, currentValue, nextValue string) bool {
	currentValue = strings.TrimSpace(currentValue)
	nextValue = strings.TrimSpace(nextValue)
	if currentValue == nextValue {
		return false
	}
	if pool == nil {
		return false
	}
	def, ok := pool.Config().GetAgent(agentName)
	if !ok {
		return false
	}
	protocol := def.Protocol
	if protocol == "" {
		protocol = agent.DefaultProtocol(agentName)
	}
	return protocol == agent.ProtocolCodexSDK || protocol == agent.ProtocolClaudeSDK
}

func resolveRuntimeModel(current *session.Session, runtime agenttypes.Session, requested string) string {
	if model := strings.TrimSpace(requested); model != "" {
		return model
	}
	if runtime != nil {
		if model := strings.TrimSpace(runtime.CurrentModel()); model != "" {
			return model
		}
	}
	if model := resolveSessionExchangeModel(current); model != "" {
		return model
	}
	if current == nil {
		return ""
	}
	return strings.TrimSpace(current.Model)
}

func (s *Service) resolveExchangeModelDisplayName(agentName, model string) string {
	agentName = strings.TrimSpace(agentName)
	model = strings.TrimSpace(model)
	if agentName != "claude" || model == "" || s == nil || s.Registry == nil {
		return ""
	}
	prober := s.Registry.GetProber()
	if prober == nil {
		return ""
	}
	status, ok := prober.GetStatus(agentName)
	if !ok {
		return ""
	}
	for _, item := range status.Models {
		if strings.TrimSpace(item.ID) == model {
			return strings.TrimSpace(item.Name)
		}
	}
	return ""
}

func resolveRuntimeEffort(_ string, current *session.Session, requested string) string {
	if effort := strings.TrimSpace(requested); effort != "" {
		return effort
	}
	if effort := session.InferEffortFromSession(current); effort != "" {
		return effort
	}
	return ""
}

func resolveRuntimeFastService(agentName string, current *session.Session, requested string) string {
	if strings.TrimSpace(agentName) != "codex" {
		return ""
	}
	if value := strings.TrimSpace(requested); value != "" {
		return value
	}
	return inferFastServiceFromSession(current)
}

func inferFastServiceFromSession(current *session.Session) string {
	return session.InferFastServiceFromSession(current)
}

func resolveRuntimeMode(current *session.Session, requested string) string {
	if mode := strings.TrimSpace(requested); mode != "" {
		return mode
	}
	if mode := resolveSessionExchangeMode(current); mode != "" {
		return mode
	}
	return ""
}

func resolveSessionExchangeModel(current *session.Session) string {
	if current == nil || len(current.Exchanges) == 0 {
		return ""
	}
	for i := len(current.Exchanges) - 1; i >= 0; i-- {
		model := strings.TrimSpace(current.Exchanges[i].Model)
		if model != "" {
			return model
		}
	}
	return ""
}

func resolveSessionExchangeMode(current *session.Session) string {
	if current == nil || len(current.Exchanges) == 0 {
		return ""
	}
	for i := len(current.Exchanges) - 1; i >= 0; i-- {
		mode := strings.TrimSpace(current.Exchanges[i].Mode)
		if mode != "" {
			return mode
		}
	}
	return ""
}

func (s *Service) SendMessage(ctx context.Context, in SendMessageInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	sendLock := getSessionSendLock(in.Key)
	sendLock.Lock()
	defer sendLock.Unlock()
	turnCtx, turnCancel := context.WithCancel(ctx)
	registerActiveTurn(in.RootID, in.Key, turnCancel)
	defer unregisterActiveTurn(in.RootID, in.Key)
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
	if current.Type == session.TypeCommand {
		return s.sendCommandMessage(turnCtx, in, manager, current)
	}
	if err := s.validateAgentModel(in.Agent, in.Model); err != nil {
		log.Printf("[session/model] validate.error root=%s session=%s agent=%s model=%q err=%v", in.RootID, in.Key, strings.TrimSpace(in.Agent), strings.TrimSpace(in.Model), err)
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
	planMode := current != nil && current.PlanMode
	sess, agentCtxSeq, err := s.ensureAgentSession(turnCtx, agentPool, manager, current, in.Agent, in.Model, in.Mode, in.Effort, in.FastService, rootAbs)
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
		AgentCtxSeq:   agentCtxSeq,
		IsInitial:     isInitial,
	})
	var responseText string
	sawAssistantChunk := false
	plannedAssistantSeq := len(current.Exchanges) + 2
	auxBuffer := make([]session.ExchangeAux, 0, 8)
	defer manager.ClearPendingExchangeAux(context.Background(), current.Key)
	var thoughtBuffer strings.Builder
	currentThoughtID := ""
	flushThought := func() {
		thought := thoughtBuffer.String()
		if strings.TrimSpace(thought) == "" {
			thoughtBuffer.Reset()
			currentThoughtID = ""
			return
		}
		thoughtID := currentThoughtID
		thoughtBuffer.Reset()
		currentThoughtID = ""
		auxBuffer = append(auxBuffer, session.ExchangeAux{
			Seq:       plannedAssistantSeq,
			Line:      currentAssistantLine(responseText),
			Thought:   thought,
			ThoughtID: thoughtID,
		})
	}
	lastResponseUpdateType := ""
	claudeSubagents := newClaudeSubagentRouter(subagentSessionInput{
		RootID:      in.RootID,
		Parent:      current,
		Agent:       in.Agent,
		Model:       in.Model,
		Mode:        in.Mode,
		Effort:      in.Effort,
		FastService: in.FastService,
		RootAbs:     rootAbs,
		Manager:     manager,
		OnCreated:   in.OnSubSessionCreated,
		OnUpdate:    in.OnSubSessionUpdate,
	})
	attachSessionUpdates := func(runtime agenttypes.Session) {
		runtime.OnUpdate(func(update agenttypes.Event) {
			update = normalizeAgentUpdatePaths(root, update)
			if claudeSubagents.Handle(context.Background(), update) {
				return
			}
			switch update.Type {
			case agenttypes.EventTypeThoughtChunk:
				if chunk, ok := update.Data.(agenttypes.ThoughtChunk); ok && chunk.Content != "" {
					if currentThoughtID == "" {
						currentThoughtID = "thought-" + randomHex(8)
					}
					chunk.ID = currentThoughtID
					update.Data = chunk
					thoughtBuffer.WriteString(chunk.Content)
				}
			case agenttypes.EventTypeToolCall, agenttypes.EventTypeToolUpdate, agenttypes.EventTypeTodoUpdate, agenttypes.EventTypePlanUpdate, agenttypes.EventTypeCompact, agenttypes.EventTypeMessageChunk, agenttypes.EventTypeMessageDone:
				flushThought()
			}
			clientUpdate := compactAgentUpdate(update)
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
				if toolCall, ok := update.Data.(agenttypes.ToolCall); ok {
					s.ensureSubagentSessions(context.Background(), subagentSessionInput{
						RootID:      in.RootID,
						Parent:      current,
						Agent:       in.Agent,
						Model:       in.Model,
						Mode:        in.Mode,
						Effort:      in.Effort,
						FastService: in.FastService,
						RootAbs:     rootAbs,
						Pool:        agentPool,
						Manager:     manager,
						ToolCall:    toolCall,
						OnCreated:   in.OnSubSessionCreated,
						OnUpdate:    in.OnSubSessionUpdate,
					})
					if shouldPersistToolCallAux(toolCall) {
						toolCallCopy := toolCall
						auxBuffer = append(auxBuffer, session.ExchangeAux{
							Seq:      plannedAssistantSeq,
							Line:     currentAssistantLine(responseText),
							ToolCall: &toolCallCopy,
						})
						_ = manager.UpsertPendingExchangeAux(context.Background(), current.Key, session.ExchangeAux{ToolCall: &toolCallCopy})
					}
				}
			}
			if update.Type == agenttypes.EventTypePlanUpdate {
				if plan, ok := update.Data.(agenttypes.PlanUpdate); ok && strings.TrimSpace(plan.Content) != "" {
					planCopy := plan
					auxBuffer = append(auxBuffer, session.ExchangeAux{
						Seq:  plannedAssistantSeq,
						Line: currentAssistantLine(responseText),
						Plan: &planCopy,
					})
				}
			}
			if update.Type == agenttypes.EventTypeCompact {
				if compact, ok := update.Data.(agenttypes.CompactNotice); ok {
					compactCopy := compact
					auxBuffer = append(auxBuffer, session.ExchangeAux{
						Seq:     plannedAssistantSeq,
						Line:    currentAssistantLine(responseText),
						Compact: &compactCopy,
					})
				}
			}
			if update.Type == agenttypes.EventTypeMessageChunk {
				if chunk, ok := update.Data.(agenttypes.MessageChunk); ok {
					sawAssistantChunk = true
					responseText = appendResponseChunk(responseText, lastResponseUpdateType, chunk.Content)
					lastResponseUpdateType = string(update.Type)
				}
			} else if update.Type == agenttypes.EventTypeThoughtChunk ||
				update.Type == agenttypes.EventTypeToolCall ||
				update.Type == agenttypes.EventTypeToolUpdate ||
				update.Type == agenttypes.EventTypeTodoUpdate ||
				update.Type == agenttypes.EventTypePlanUpdate ||
				update.Type == agenttypes.EventTypeCompact {
				lastResponseUpdateType = string(update.Type)
			}
			if watcher != nil {
				watcher.MarkSessionActive(current.Key)
			}
			if in.OnUpdate != nil {
				in.OnUpdate(clientUpdate)
			}
		})
	}
	sendWithAttachedUpdates := func(runtime agenttypes.Session, content string) error {
		attachSessionUpdates(runtime)
		return runtime.SendMessage(turnCtx, content)
	}
	sendErr := sendWithAttachedUpdates(sess, prompt)
	if sendErr != nil && !isCanceledTurnError(sendErr) {
		if isNonRecoverableAgentError(sendErr) {
			log.Printf("[session] turn.send.non_recoverable root=%s session=%s agent=%s action=fail_without_recovery err=%v", in.RootID, current.Key, in.Agent, sendErr)
			cancelRuntimeAfterNonRecoverableError(sess, agentPool, in.Agent, sendErr)
		} else if !sawAssistantChunk {
			log.Printf("[session] turn.send.no_response root=%s session=%s agent=%s action=fail_without_recovery", in.RootID, current.Key, in.Agent)
		} else {
			if in.OnUpdate != nil {
				in.OnUpdate(agenttypes.Event{
					Type: agenttypes.EventTypeRecovery,
					Data: agenttypes.RecoveryStatus{Message: "遇到错误，重试中..."},
				})
			}
			recoveredSess, recoveredErr := s.recoverAgentTurn(turnCtx, SendRecoveryInput{
				RootID:             in.RootID,
				SessionKey:         current.Key,
				Manager:            manager,
				Current:            current,
				AgentName:          in.Agent,
				Model:              in.Model,
				Mode:               in.Mode,
				Effort:             in.Effort,
				FastService:        in.FastService,
				PlanMode:           planMode,
				RootAbs:            rootAbs,
				CurrentSession:     sess,
				Prompt:             prompt,
				SawAssistantChunk:  sawAssistantChunk,
				SendWithAttachment: sendWithAttachedUpdates,
			})
			if recoveredErr != nil {
				sendErr = recoveredErr
			} else {
				sess = recoveredSess
				sendErr = nil
			}
		}
	}
	flushThought()
	claudeSubagents.FinishAll()
	if sendErr != nil && !isCanceledTurnError(sendErr) {
		log.Printf("[session] turn.send.error root=%s session=%s agent=%s err=%v", in.RootID, current.Key, in.Agent, sendErr)
	}
	resolvedModel := resolveRuntimeModel(current, sess, in.Model)
	resolvedEffort := resolveRuntimeEffort(in.Agent, current, in.Effort)
	resolvedFastService := resolveRuntimeFastService(in.Agent, current, in.FastService)
	if prefs := s.Registry.GetPreferences(); prefs != nil {
		if changed, err := prefs.UpdateAgentDefaultsIfChanged(in.Agent, resolvedModel, resolvedEffort, resolvedFastService); err != nil {
			log.Printf("[preferences] agent_defaults.update.error agent=%s err=%v", strings.TrimSpace(in.Agent), err)
		} else if changed {
			log.Printf("[preferences] agent_defaults.update.done agent=%s model=%q effort=%q fast_service=%q", strings.TrimSpace(in.Agent), resolvedModel, resolvedEffort, resolvedFastService)
		}
	}
	if err := manager.UpdateModel(ctx, current, resolvedModel); err != nil {
		return err
	}
	resolvedMode := resolveRuntimeMode(current, in.Mode)
	modelDisplayName := s.resolveExchangeModelDisplayName(in.Agent, resolvedModel)
	exchangeCtx := session.WithExchangeModelDisplayName(ctx, modelDisplayName)
	if err := manager.AddExchangeForAgent(exchangeCtx, current, "user", in.Content, in.Agent, resolvedMode, resolvedEffort, resolvedFastService); err != nil {
		log.Printf("[session] persist.user.error root=%s session=%s agent=%s err=%v", in.RootID, current.Key, in.Agent, err)
		return err
	}
	if err := manager.AddExchangeForAgent(exchangeCtx, current, "agent", responseText, in.Agent, resolvedMode, resolvedEffort, resolvedFastService); err != nil {
		log.Printf("[session] persist.agent.error root=%s session=%s agent=%s err=%v", in.RootID, current.Key, in.Agent, err)
		return err
	}
	for _, aux := range dedupeExchangeAuxBuffer(auxBuffer) {
		aux = hydratePendingToolCallAux(ctx, manager, current.Key, aux)
		if err := manager.AddExchangeAux(ctx, current.Key, aux); err != nil {
			return err
		}
	}
	if err := manager.UpdateAgentState(ctx, current, in.Agent, contextLineCount(current.Exchanges), sess.SessionID()); err != nil {
		return err
	}

	prober := s.Registry.GetProber()
	if sendErr != nil && !isCanceledTurnError(sendErr) {
		if prober != nil {
			prober.ReportRuntimeFailure(in.Agent, sendErr)
		}
		return sendErr
	} else if prober != nil {
		prober.ReportSuccess(in.Agent)
	}
	return nil
}

type subagentSessionInput struct {
	RootID      string
	Parent      *session.Session
	Agent       string
	Model       string
	Mode        string
	Effort      string
	FastService string
	RootAbs     string
	Pool        *agent.Pool
	Manager     *session.Manager
	ToolCall    agenttypes.ToolCall
	OnCreated   func(*session.Session)
	OnUpdate    func(sessionKey string, update agenttypes.Event)
}

type claudeSubagentRouter struct {
	in       subagentSessionInput
	byRef    map[string]*claudeSyntheticSubagent
	children []*claudeSyntheticSubagent
}

type claudeSyntheticSubagent struct {
	key     string
	child   *session.Session
	runtime *syntheticAgentSession
	done    func()
	closed  bool
}

func newClaudeSubagentRouter(in subagentSessionInput) *claudeSubagentRouter {
	return &claudeSubagentRouter{
		in:    in,
		byRef: make(map[string]*claudeSyntheticSubagent),
	}
}

func (r *claudeSubagentRouter) Handle(ctx context.Context, update agenttypes.Event) bool {
	if r == nil || r.in.Parent == nil || r.in.Manager == nil {
		return false
	}
	if r.handleSubagentResult(ctx, update) {
		return false
	}
	ref := claudeSubagentRefFromUpdate(update)
	if !ref.hasRef() {
		return false
	}
	if isClaudeParentTaskLifecycle(update) {
		return false
	}
	if strings.TrimSpace(ref.ParentToolUseID) == "" && r.find(ref) == nil {
		return false
	}
	child, err := r.ensure(ctx, ref, toolCallFromUpdate(update))
	if err != nil {
		log.Printf("[subagent/claude] session.ensure.error root=%s parent=%s ref=%s err=%v", r.in.RootID, r.in.Parent.Key, ref.key(), err)
		return false
	}
	if child == nil || child.closed {
		return false
	}
	child.runtime.emit(update)
	if update.Type == agenttypes.EventTypeMessageDone {
		child.closed = true
	}
	return true
}

func (r *claudeSubagentRouter) FinishAll() {
	if r == nil {
		return
	}
	for _, child := range r.children {
		if child == nil || child.closed {
			continue
		}
		child.done()
		child.closed = true
	}
}

func (r *claudeSubagentRouter) handleSubagentResult(ctx context.Context, update agenttypes.Event) bool {
	if update.Type != agenttypes.EventTypeToolUpdate {
		return false
	}
	toolCall, ok := update.Data.(agenttypes.ToolCall)
	if !ok || toolCall.RawType != "subagent_result" {
		return false
	}
	child := r.onlyOpenChild()
	if child == nil {
		return false
	}
	for _, item := range toolCall.Content {
		if strings.TrimSpace(item.Text) != "" {
			child.runtime.emit(agenttypes.Event{
				Type:      agenttypes.EventTypeMessageChunk,
				SessionID: update.SessionID,
				Data:      agenttypes.MessageChunk{Content: item.Text},
			})
			break
		}
	}
	child.runtime.emit(agenttypes.Event{Type: agenttypes.EventTypeMessageDone, SessionID: update.SessionID, Data: agenttypes.MessageDone{}})
	child.closed = true
	_ = ctx
	return true
}

func (r *claudeSubagentRouter) onlyOpenChild() *claudeSyntheticSubagent {
	var found *claudeSyntheticSubagent
	for _, child := range r.children {
		if child == nil || child.closed {
			continue
		}
		if found != nil {
			return nil
		}
		found = child
	}
	return found
}

func (r *claudeSubagentRouter) ensure(ctx context.Context, ref claudeSubagentRef, source *agenttypes.ToolCall) (*claudeSyntheticSubagent, error) {
	keys := ref.keys()
	if child := r.find(ref); child != nil {
		r.bindKeys(child, keys)
		return child, nil
	}
	primary := ref.key()
	if primary == "" {
		return nil, nil
	}
	if existing, err := r.in.Manager.FindAgentBindingByAgentSession(ctx, r.in.Agent, "claude-subagent:"+primary); err != nil {
		return nil, err
	} else if existing != nil {
		loaded, err := r.in.Manager.Get(ctx, existing.SessionKey, 0)
		if err != nil {
			return nil, err
		}
		child := r.attach(loaded, ref)
		r.bindKeys(child, keys)
		return child, nil
	}
	parentToolCallID := firstNonEmptyString(ref.ParentToolUseID, sourceCallID(source), ref.TaskID)
	child, err := r.in.Manager.Create(ctx, session.CreateInput{
		Type:             session.TypeChat,
		ParentSessionKey: r.in.Parent.Key,
		ParentToolCallID: parentToolCallID,
		Agent:            r.in.Agent,
		Model:            firstNonEmptyString(sourceModel(source), r.in.Model),
		PlanMode:         false,
		Name:             claudeSubagentSessionName(ref, source),
	})
	if err != nil {
		return nil, err
	}
	if err := r.in.Manager.UpsertAgentBinding(ctx, session.AgentBinding{
		SessionKey:     child.Key,
		Agent:          r.in.Agent,
		AgentSessionID: "claude-subagent:" + primary,
	}); err != nil {
		return nil, err
	}
	attached := r.attach(child, ref)
	r.bindKeys(attached, keys)
	if r.in.OnCreated != nil {
		r.in.OnCreated(child)
	}
	return attached, nil
}

func (r *claudeSubagentRouter) find(ref claudeSubagentRef) *claudeSyntheticSubagent {
	for _, key := range ref.keys() {
		if child := r.byRef[key]; child != nil {
			return child
		}
	}
	return nil
}

func (r *claudeSubagentRouter) attach(child *session.Session, ref claudeSubagentRef) *claudeSyntheticSubagent {
	runtime := &syntheticAgentSession{id: firstNonEmptyString(ref.ParentToolUseID, ref.TaskID, child.Key)}
	in := r.in
	done := attachBackgroundSessionUpdates(context.Background(), in, child, runtime)
	attached := &claudeSyntheticSubagent{
		key:     child.Key,
		child:   child,
		runtime: runtime,
		done:    done,
	}
	r.children = append(r.children, attached)
	return attached
}

func (r *claudeSubagentRouter) bindKeys(child *claudeSyntheticSubagent, keys []string) {
	for _, key := range keys {
		if key != "" {
			r.byRef[key] = child
		}
	}
}

type claudeSubagentRef struct {
	ParentToolUseID string
	TaskID          string
	SubagentType    string
	TaskDescription string
}

func (r claudeSubagentRef) hasRef() bool {
	return strings.TrimSpace(r.ParentToolUseID) != "" || strings.TrimSpace(r.TaskID) != ""
}

func (r claudeSubagentRef) key() string {
	return firstNonEmptyString(r.ParentToolUseID, r.TaskID)
}

func (r claudeSubagentRef) keys() []string {
	keys := make([]string, 0, 2)
	if value := strings.TrimSpace(r.ParentToolUseID); value != "" {
		keys = append(keys, "tool:"+value)
	}
	if value := strings.TrimSpace(r.TaskID); value != "" {
		keys = append(keys, "task:"+value)
	}
	return keys
}

func claudeSubagentRefFromUpdate(update agenttypes.Event) claudeSubagentRef {
	switch data := update.Data.(type) {
	case agenttypes.MessageChunk:
		return claudeSubagentRef{
			ParentToolUseID: data.ParentToolUseID,
			TaskID:          data.TaskID,
			SubagentType:    data.SubagentType,
			TaskDescription: data.TaskDescription,
		}
	case agenttypes.ThoughtChunk:
		return claudeSubagentRef{
			ParentToolUseID: data.ParentToolUseID,
			TaskID:          data.TaskID,
			SubagentType:    data.SubagentType,
			TaskDescription: data.TaskDescription,
		}
	case agenttypes.MessageDone:
		return claudeSubagentRef{
			ParentToolUseID: data.ParentToolUseID,
			TaskID:          data.TaskID,
			SubagentType:    data.SubagentType,
			TaskDescription: data.TaskDescription,
		}
	case agenttypes.ToolCall:
		return claudeSubagentRef{
			ParentToolUseID: stringMeta(data.Meta, "parentToolUseId"),
			TaskID:          stringMeta(data.Meta, "taskId"),
			SubagentType:    stringMeta(data.Meta, "subagentType"),
			TaskDescription: stringMeta(data.Meta, "taskDescription"),
		}
	default:
		return claudeSubagentRef{}
	}
}

func isClaudeParentTaskLifecycle(update agenttypes.Event) bool {
	if update.Type != agenttypes.EventTypeToolCall && update.Type != agenttypes.EventTypeToolUpdate {
		return false
	}
	toolCall, ok := update.Data.(agenttypes.ToolCall)
	return ok && toolCall.Kind == agenttypes.ToolKindTask && toolCall.RawType == "claude_task"
}

func toolCallFromUpdate(update agenttypes.Event) *agenttypes.ToolCall {
	toolCall, ok := update.Data.(agenttypes.ToolCall)
	if !ok {
		return nil
	}
	return &toolCall
}

func sourceCallID(toolCall *agenttypes.ToolCall) string {
	if toolCall == nil {
		return ""
	}
	return strings.TrimSpace(toolCall.CallID)
}

func sourceModel(toolCall *agenttypes.ToolCall) string {
	if toolCall == nil {
		return ""
	}
	return stringMeta(toolCall.Meta, "model")
}

func claudeSubagentSessionName(ref claudeSubagentRef, source *agenttypes.ToolCall) string {
	if value := strings.TrimSpace(ref.TaskDescription); value != "" {
		return truncateRunes(value, 48)
	}
	if source != nil {
		if value := strings.TrimSpace(source.Title); value != "" {
			return truncateRunes(value, 48)
		}
		if value := stringMeta(source.Meta, "prompt"); value != "" {
			return truncateRunes(value, 48)
		}
	}
	if value := strings.TrimSpace(ref.SubagentType); value != "" {
		return truncateRunes(value, 48)
	}
	return truncateRunes(ref.key(), 16)
}

type syntheticAgentSession struct {
	id       string
	onUpdate func(agenttypes.Event)
}

func (s *syntheticAgentSession) SendMessage(context.Context, string) error { return nil }
func (s *syntheticAgentSession) AnswerQuestion(context.Context, agenttypes.AskUserAnswer) error {
	return nil
}
func (s *syntheticAgentSession) CurrentModel() string                   { return "" }
func (s *syntheticAgentSession) SetModel(context.Context, string) error { return nil }
func (s *syntheticAgentSession) ListModels(context.Context) (agenttypes.ModelList, error) {
	return agenttypes.ModelList{}, nil
}
func (s *syntheticAgentSession) SetMode(context.Context, string) error   { return nil }
func (s *syntheticAgentSession) SetPlanMode(context.Context, bool) error { return nil }
func (s *syntheticAgentSession) ListModes(context.Context) (agenttypes.ModeList, error) {
	return agenttypes.ModeList{}, nil
}
func (s *syntheticAgentSession) ListCommands(context.Context) (agenttypes.CommandList, error) {
	return agenttypes.CommandList{}, nil
}
func (s *syntheticAgentSession) CancelCurrentTurn() error { return nil }
func (s *syntheticAgentSession) OnUpdate(onUpdate func(agenttypes.Event)) {
	s.onUpdate = onUpdate
}
func (s *syntheticAgentSession) SessionID() string { return s.id }
func (s *syntheticAgentSession) ContextWindow(context.Context) (agenttypes.ContextWindow, error) {
	return agenttypes.ContextWindow{}, nil
}
func (s *syntheticAgentSession) Close() error { return nil }
func (s *syntheticAgentSession) emit(event agenttypes.Event) {
	if s.onUpdate != nil {
		s.onUpdate(event)
	}
}

func (s *Service) ensureSubagentSessions(ctx context.Context, in subagentSessionInput) {
	if in.Parent == nil || in.Pool == nil || in.Manager == nil || in.ToolCall.RawType != "collabToolCall" {
		return
	}
	for _, receiverThreadID := range stringSliceMeta(in.ToolCall.Meta, "receiverThreadIds") {
		receiverThreadID = strings.TrimSpace(receiverThreadID)
		if receiverThreadID == "" {
			continue
		}
		child, err := s.ensureSubagentSession(ctx, in, receiverThreadID)
		if err != nil {
			log.Printf("[subagent] session.ensure.error root=%s parent=%s receiver=%s err=%v", in.RootID, in.Parent.Key, receiverThreadID, err)
			continue
		}
		if child != nil {
			s.startSubagentSubscription(in, child, receiverThreadID)
		}
	}
}

func (s *Service) ensureSubagentSession(ctx context.Context, in subagentSessionInput, receiverThreadID string) (*session.Session, error) {
	if existing, err := in.Manager.FindAgentBindingByAgentSession(ctx, in.Agent, receiverThreadID); err != nil {
		return nil, err
	} else if existing != nil {
		return in.Manager.Get(ctx, existing.SessionKey, 0)
	}
	child, err := in.Manager.Create(ctx, session.CreateInput{
		Type:             session.TypeChat,
		ParentSessionKey: in.Parent.Key,
		ParentToolCallID: in.ToolCall.CallID,
		Agent:            in.Agent,
		Model:            firstNonEmptyString(stringMeta(in.ToolCall.Meta, "model"), in.Model),
		PlanMode:         false,
		Name:             subagentSessionName(in.ToolCall, receiverThreadID),
	})
	if err != nil {
		return nil, err
	}
	if err := in.Manager.UpsertAgentBinding(ctx, session.AgentBinding{
		SessionKey:     child.Key,
		Agent:          in.Agent,
		AgentSessionID: receiverThreadID,
	}); err != nil {
		return nil, err
	}
	if in.OnCreated != nil {
		in.OnCreated(child)
	}
	return child, nil
}

func (s *Service) startSubagentSubscription(in subagentSessionInput, child *session.Session, receiverThreadID string) {
	key := in.RootID + ":" + child.Key + ":" + receiverThreadID
	if _, loaded := activeSubagentSubscriptions.LoadOrStore(key, struct{}{}); loaded {
		return
	}
	go func() {
		defer activeSubagentSubscriptions.Delete(key)
		ctx, cancel := context.WithCancel(in.Pool.Context())
		registerActiveTurn(in.RootID, child.Key, cancel)
		defer unregisterActiveTurn(in.RootID, child.Key)
		runtime, err := in.Pool.GetOrCreate(ctx, agenttypes.OpenSessionInput{
			SessionKey:     agentPoolSessionKey(child.Key, in.Agent),
			AgentName:      in.Agent,
			Model:          firstNonEmptyString(stringMeta(in.ToolCall.Meta, "model"), in.Model),
			Mode:           in.Mode,
			Effort:         firstNonEmptyString(stringMeta(in.ToolCall.Meta, "reasoningEffort"), in.Effort),
			FastService:    in.FastService,
			PlanMode:       false,
			RootPath:       in.RootAbs,
			AgentSessionID: receiverThreadID,
			AgentCtxSeq:    child.AgentCtxSeq[in.Agent],
		})
		if err != nil {
			log.Printf("[subagent] subscription.open.error root=%s session=%s receiver=%s err=%v", in.RootID, child.Key, receiverThreadID, err)
			return
		}
		setActiveTurnSession(in.RootID, child.Key, runtime)
		subscriber, ok := runtime.(agenttypes.ThreadEventSubscriber)
		if !ok {
			log.Printf("[subagent] subscription.unsupported root=%s session=%s receiver=%s", in.RootID, child.Key, receiverThreadID)
			return
		}
		markDone := attachBackgroundSessionUpdates(ctx, in, child, runtime)
		if err := subscriber.SubscribeThreadEvents(ctx); err != nil && ctx.Err() == nil {
			log.Printf("[subagent] subscription.error root=%s session=%s receiver=%s err=%v", in.RootID, child.Key, receiverThreadID, err)
		}
		markDone()
	}()
}

func attachBackgroundSessionUpdates(ctx context.Context, in subagentSessionInput, child *session.Session, runtime agenttypes.Session) func() {
	var responseText string
	plannedAssistantSeq := len(child.Exchanges) + 1
	auxBuffer := make([]session.ExchangeAux, 0, 8)
	var thoughtBuffer strings.Builder
	lastResponseUpdateType := ""
	var doneMu sync.Mutex
	doneSent := false
	currentThoughtID := ""
	flushThought := func() {
		thought := thoughtBuffer.String()
		if strings.TrimSpace(thought) == "" {
			thoughtBuffer.Reset()
			currentThoughtID = ""
			return
		}
		thoughtID := currentThoughtID
		thoughtBuffer.Reset()
		currentThoughtID = ""
		auxBuffer = append(auxBuffer, session.ExchangeAux{
			Seq:       plannedAssistantSeq,
			Line:      currentAssistantLine(responseText),
			Thought:   thought,
			ThoughtID: thoughtID,
		})
	}
	finish := func(emit bool) {
		doneMu.Lock()
		if doneSent {
			doneMu.Unlock()
			return
		}
		doneSent = true
		doneMu.Unlock()
		defer in.Manager.ClearPendingExchangeAux(context.Background(), child.Key)
		flushThought()
		if err := in.Manager.AddExchangeForAgent(ctx, child, "agent", responseText, in.Agent, in.Mode, in.Effort, in.FastService); err != nil {
			log.Printf("[subagent] persist.agent.error root=%s session=%s err=%v", in.RootID, child.Key, err)
			return
		}
		for _, aux := range dedupeExchangeAuxBuffer(auxBuffer) {
			aux = hydratePendingToolCallAux(ctx, in.Manager, child.Key, aux)
			if err := in.Manager.AddExchangeAux(ctx, child.Key, aux); err != nil {
				log.Printf("[subagent] persist.aux.error root=%s session=%s err=%v", in.RootID, child.Key, err)
				return
			}
		}
		if err := in.Manager.UpdateAgentState(ctx, child, in.Agent, contextLineCount(child.Exchanges), runtime.SessionID()); err != nil {
			log.Printf("[subagent] persist.agent_state.error root=%s session=%s err=%v", in.RootID, child.Key, err)
		}
		if emit && in.OnUpdate != nil {
			in.OnUpdate(child.Key, agenttypes.Event{Type: agenttypes.EventTypeMessageDone, Data: agenttypes.MessageDone{}})
		}
	}
	runtime.OnUpdate(func(update agenttypes.Event) {
		switch update.Type {
		case agenttypes.EventTypeThoughtChunk:
			if chunk, ok := update.Data.(agenttypes.ThoughtChunk); ok && chunk.Content != "" {
				if currentThoughtID == "" {
					currentThoughtID = "thought-" + randomHex(8)
				}
				chunk.ID = currentThoughtID
				update.Data = chunk
				thoughtBuffer.WriteString(chunk.Content)
			}
		case agenttypes.EventTypeToolCall, agenttypes.EventTypeToolUpdate, agenttypes.EventTypeTodoUpdate, agenttypes.EventTypePlanUpdate, agenttypes.EventTypeCompact, agenttypes.EventTypeMessageChunk, agenttypes.EventTypeMessageDone:
			flushThought()
		}
		clientUpdate := compactAgentUpdate(update)
		if update.Type == agenttypes.EventTypeToolCall || update.Type == agenttypes.EventTypeToolUpdate {
			if toolCall, ok := update.Data.(agenttypes.ToolCall); ok {
				if shouldPersistToolCallAux(toolCall) {
					toolCallCopy := toolCall
					auxBuffer = append(auxBuffer, session.ExchangeAux{
						Seq:      plannedAssistantSeq,
						Line:     currentAssistantLine(responseText),
						ToolCall: &toolCallCopy,
					})
					_ = in.Manager.UpsertPendingExchangeAux(context.Background(), child.Key, session.ExchangeAux{ToolCall: &toolCallCopy})
				}
			}
		}
		if update.Type == agenttypes.EventTypePlanUpdate {
			if plan, ok := update.Data.(agenttypes.PlanUpdate); ok && strings.TrimSpace(plan.Content) != "" {
				planCopy := plan
				auxBuffer = append(auxBuffer, session.ExchangeAux{
					Seq:  plannedAssistantSeq,
					Line: currentAssistantLine(responseText),
					Plan: &planCopy,
				})
			}
		}
		if update.Type == agenttypes.EventTypeCompact {
			if compact, ok := update.Data.(agenttypes.CompactNotice); ok {
				compactCopy := compact
				auxBuffer = append(auxBuffer, session.ExchangeAux{
					Seq:     plannedAssistantSeq,
					Line:    currentAssistantLine(responseText),
					Compact: &compactCopy,
				})
			}
		}
		if update.Type == agenttypes.EventTypeMessageChunk {
			if chunk, ok := update.Data.(agenttypes.MessageChunk); ok {
				responseText = appendResponseChunk(responseText, lastResponseUpdateType, chunk.Content)
				lastResponseUpdateType = string(update.Type)
			}
		} else if update.Type == agenttypes.EventTypeThoughtChunk ||
			update.Type == agenttypes.EventTypeToolCall ||
			update.Type == agenttypes.EventTypeToolUpdate ||
			update.Type == agenttypes.EventTypeTodoUpdate ||
			update.Type == agenttypes.EventTypePlanUpdate ||
			update.Type == agenttypes.EventTypeCompact {
			lastResponseUpdateType = string(update.Type)
		}
		if update.Type != agenttypes.EventTypeMessageDone {
			if in.OnUpdate != nil {
				in.OnUpdate(child.Key, clientUpdate)
			}
			return
		}
		finish(false)
		if in.OnUpdate != nil {
			in.OnUpdate(child.Key, clientUpdate)
		}
	})
	return func() { finish(true) }
}

func (s *Service) sendCommandMessage(ctx context.Context, in SendMessageInput, manager *session.Manager, current *session.Session) error {
	if strings.TrimSpace(in.Content) == "" {
		return errors.New("command required")
	}
	root := manager.Root()
	rootAbs, err := root.RootDir()
	if err != nil {
		return err
	}
	callID := "cmd-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	plannedAssistantSeq := len(current.Exchanges) + 2
	startTool := agenttypes.ToolCall{
		CallID:  callID,
		Title:   in.Content,
		Status:  "running",
		Kind:    agenttypes.ToolKindExecute,
		RawType: "commandExecution",
		Meta: map[string]any{
			"source":       "userShell",
			"phase":        "start",
			"command":      in.Content,
			"cwd":          ".",
			"terminalCols": in.TerminalCols,
		},
	}
	if in.OnUpdate != nil {
		in.OnUpdate(agenttypes.Event{Type: agenttypes.EventTypeToolCall, Data: startTool})
	}

	proc, err := commandexec.StartInSession(ctx, commandexec.Options{
		Command:      in.Content,
		Cwd:          rootAbs,
		Shells:       configuredShells(s.Registry),
		Shell:        in.Shell,
		RootID:       in.RootID,
		Session:      current.Key,
		TerminalCols: in.TerminalCols,
	})
	if err != nil {
		log.Printf("[command] start.error root=%s session=%s command=%q err=%v", in.RootID, current.Key, in.Content, err)
		final := startTool
		final.Status = "failed"
		final.Meta = cloneMeta(final.Meta)
		final.Meta["phase"] = "final"
		final.Meta["exitCode"] = -1
		final.Meta["error"] = err.Error()
		final.Content = []agenttypes.ToolCallContentItem{{Type: "text", Text: err.Error()}}
		if in.OnUpdate != nil {
			in.OnUpdate(agenttypes.Event{Type: agenttypes.EventTypeToolUpdate, Data: final})
			in.OnUpdate(agenttypes.Event{Type: agenttypes.EventTypeMessageDone, Data: agenttypes.MessageDone{}})
		}
		if persistErr := persistCommandTurn(ctx, manager, current, in.Content, final, plannedAssistantSeq); persistErr != nil {
			return persistErr
		}
		return err
	}

	limiter := commandexec.NewOutputLimiter()
	ticker := time.NewTicker(limiter.FlushEvery())
	defer ticker.Stop()
	done := make(chan commandexec.Result, 1)
	go func() {
		done <- proc.Wait()
	}()

	var result commandexec.Result
	var haveResult bool
	cancelStarted := false
	outputCh := proc.Output()
	for !haveResult {
		select {
		case chunk, ok := <-outputCh:
			if !ok {
				outputCh = nil
				continue
			}
			limiter.Write(chunk)
		case <-ticker.C:
			flushCommandOutput(in.OnUpdate, startTool, limiter)
			ticker.Reset(limiter.FlushEvery())
		case result = <-done:
			haveResult = true
		case <-ctx.Done():
			if !cancelStarted {
				cancelStarted = true
				go stopCommandProcess(proc)
			}
		}
	}
	drainCommandOutput(proc.Output(), limiter, 250*time.Millisecond)
	flushCommandOutput(in.OnUpdate, startTool, limiter)

	final := startTool
	final.Status = "success"
	if cancelStarted || ctx.Err() != nil {
		final.Status = "cancelled"
	} else if result.ExitCode != 0 {
		final.Status = "failed"
	}
	tail := limiter.Tail()
	persistedBytes := limiter.TailBytes()
	outputBytes := limiter.TotalBytes()
	text := string(tail)
	if strings.TrimSpace(result.Shell) != "" {
		if err := manager.UpdateShell(context.Background(), current, result.Shell); err != nil {
			log.Printf("[command] shell.update.error root=%s session=%s shell=%q err=%v", in.RootID, current.Key, result.Shell, err)
		}
	}
	if outputBytes > persistedBytes {
		text = fmt.Sprintf("[output truncated: showing last %d bytes of %d bytes]\n%s", persistedBytes, outputBytes, text)
	}
	final.Meta = map[string]any{
		"source":         "userShell",
		"phase":          "final",
		"command":        in.Content,
		"cwd":            ".",
		"shell":          result.Shell,
		"exitCode":       result.ExitCode,
		"durationMs":     result.Duration.Milliseconds(),
		"outputBytes":    outputBytes,
		"persistedBytes": persistedBytes,
		"truncated":      outputBytes > persistedBytes,
		"truncation":     "tail",
		"terminalCols":   in.TerminalCols,
	}
	if cancelStarted || ctx.Err() != nil {
		final.Meta["cancelled"] = true
	}
	final.Content = []agenttypes.ToolCallContentItem{{Type: "text", Text: text}}
	if in.OnUpdate != nil {
		in.OnUpdate(agenttypes.Event{Type: agenttypes.EventTypeToolUpdate, Data: final})
		in.OnUpdate(agenttypes.Event{Type: agenttypes.EventTypeMessageDone, Data: agenttypes.MessageDone{}})
	}
	if err := persistCommandTurn(context.Background(), manager, current, in.Content, final, plannedAssistantSeq); err != nil {
		log.Printf("[command] persist.error root=%s session=%s call=%s err=%v", in.RootID, current.Key, callID, err)
		return err
	}
	if final.Status == "success" || final.Status == "cancelled" {
		if err := UpsertCommandSuggestion(manager, CommandSuggestion{
			Command:        in.Content,
			Cwd:            ".",
			Shell:          result.Shell,
			RootID:         in.RootID,
			LastExitCode:   result.ExitCode,
			LastDurationMs: result.Duration.Milliseconds(),
			LastUsedAt:     result.FinishedAt,
		}); err != nil {
			log.Printf("[command/history] upsert.error root=%s session=%s err=%v", in.RootID, current.Key, err)
		}
	}
	return nil
}

func flushCommandOutput(onUpdate func(agenttypes.Event), base agenttypes.ToolCall, limiter *commandexec.OutputLimiter) {
	if onUpdate == nil || limiter == nil {
		return
	}
	chunk, ok := limiter.Flush()
	if !ok {
		return
	}
	update := base
	update.Status = "running"
	update.Meta = map[string]any{
		"source":       "userShell",
		"phase":        "stream",
		"outputMode":   "ring",
		"skippedBytes": chunk.SkippedBytes,
	}
	update.Content = []agenttypes.ToolCallContentItem{{Type: "text", Text: chunk.Text}}
	onUpdate(agenttypes.Event{Type: agenttypes.EventTypeToolUpdate, Data: update})
}

func drainCommandOutput(output <-chan []byte, limiter *commandexec.OutputLimiter, maxWait time.Duration) {
	if output == nil || limiter == nil {
		return
	}
	timer := time.NewTimer(maxWait)
	defer timer.Stop()
	for {
		select {
		case chunk, ok := <-output:
			if !ok {
				return
			}
			if len(chunk) > 0 {
				limiter.Write(chunk)
			}
		case <-timer.C:
			return
		}
	}
}

func stopCommandProcess(proc commandexec.Process) {
	if proc == nil {
		return
	}
	_ = proc.Interrupt()
	time.Sleep(2 * time.Second)
	_ = proc.Terminate()
	time.Sleep(3 * time.Second)
	_ = proc.KillTree()
}

func configuredShells(registry Registry) []commandexec.ShellSpec {
	if registry == nil {
		return nil
	}
	pool := registry.GetAgentPool()
	if pool == nil {
		return nil
	}
	cfg := pool.Config()
	shells := make([]commandexec.ShellSpec, 0, len(cfg.Shells))
	for _, shell := range cfg.Shells {
		shells = append(shells, commandexec.ShellSpec{
			Command:       shell.Command,
			Args:          append([]string(nil), shell.Args...),
			LongShellArgs: append([]string(nil), shell.LongShellArgs...),
			CommandPrefix: shell.CommandPrefix,
		})
	}
	return shells
}

func persistCommandTurn(ctx context.Context, manager *session.Manager, current *session.Session, command string, final agenttypes.ToolCall, plannedAssistantSeq int) error {
	if err := manager.AddExchangeForAgent(ctx, current, "user", command, "", "", "", ""); err != nil {
		return err
	}
	if err := manager.AddExchangeForAgent(ctx, current, "agent", "", "", "", "", ""); err != nil {
		return err
	}
	return manager.AddExchangeAux(ctx, current.Key, session.ExchangeAux{
		Seq:      plannedAssistantSeq,
		Line:     0,
		ToolCall: &final,
	})
}

func cloneMeta(meta map[string]any) map[string]any {
	out := make(map[string]any, len(meta))
	for k, v := range meta {
		out[k] = v
	}
	return out
}

type SendRecoveryInput struct {
	RootID             string
	SessionKey         string
	Manager            *session.Manager
	Current            *session.Session
	AgentName          string
	Model              string
	Mode               string
	Effort             string
	FastService        string
	PlanMode           bool
	RootAbs            string
	CurrentSession     agenttypes.Session
	Prompt             string
	SawAssistantChunk  bool
	SendWithAttachment func(agenttypes.Session, string) error
}

func (s *Service) recoverAgentTurn(ctx context.Context, in SendRecoveryInput) (agenttypes.Session, error) {
	if s == nil {
		return nil, errors.New("services not configured")
	}
	if in.Current == nil {
		return nil, errors.New("session required")
	}
	if in.Manager == nil {
		return nil, errors.New("session manager required")
	}
	if in.SendWithAttachment == nil {
		return nil, errors.New("send function required")
	}
	if in.CurrentSession == nil {
		return nil, errors.New("current session required")
	}

	var lastErr error
	for attempt := 1; attempt <= sessionRecoveryAttempts; attempt++ {
		if attempt > 1 {
			log.Printf("[session/recovery] wait root=%s session=%s agent=%s attempt=%d/%d delay=%s", in.RootID, in.SessionKey, in.AgentName, attempt, sessionRecoveryAttempts, sessionRecoveryDelay)
			if err := waitForRecoveryDelay(ctx, sessionRecoveryDelay); err != nil {
				return nil, err
			}
		}

		sess := in.CurrentSession
		recoveryMessage := in.Prompt
		recoveryAction := "resend_prompt"
		if in.SawAssistantChunk {
			recoveryMessage = "continue"
			recoveryAction = "continue"
		}
		log.Printf("[session/recovery] send.start root=%s session=%s agent=%s attempt=%d/%d action=%s", in.RootID, in.SessionKey, in.AgentName, attempt, sessionRecoveryAttempts, recoveryAction)
		if err := in.SendWithAttachment(sess, recoveryMessage); err != nil {
			if isCanceledTurnError(err) || ctx.Err() != nil {
				return nil, err
			}
			if isNonRecoverableAgentError(err) {
				log.Printf("[session/recovery] send.non_recoverable root=%s session=%s agent=%s attempt=%d/%d action=%s err=%v", in.RootID, in.SessionKey, in.AgentName, attempt, sessionRecoveryAttempts, recoveryAction, err)
				return nil, err
			}
			lastErr = err
			log.Printf("[session/recovery] send.failed root=%s session=%s agent=%s attempt=%d/%d action=%s err=%v", in.RootID, in.SessionKey, in.AgentName, attempt, sessionRecoveryAttempts, recoveryAction, err)
			continue
		}
		log.Printf("[session/recovery] send.done root=%s session=%s agent=%s attempt=%d/%d action=%s", in.RootID, in.SessionKey, in.AgentName, attempt, sessionRecoveryAttempts, recoveryAction)
		return sess, nil
	}
	if lastErr == nil {
		lastErr = errors.New("agent recovery failed")
	}
	return nil, lastErr
}

func waitForRecoveryDelay(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Service) AnswerQuestion(ctx context.Context, in AnswerQuestionInput) error {
	if err := s.ensureRegistry(); err != nil {
		return err
	}
	sessionKey := strings.TrimSpace(in.SessionKey)
	if sessionKey == "" {
		return errors.New("session key required")
	}
	manager, err := s.Registry.GetSessionManager(in.RootID)
	if err != nil {
		return err
	}
	agentName := strings.TrimSpace(in.Agent)
	if agentName == "" {
		current, err := manager.Get(ctx, sessionKey, 0)
		if err != nil {
			return err
		}
		agentName = strings.TrimSpace(session.InferAgentFromSession(current))
	}
	if agentName == "" {
		return errors.New("agent required")
	}
	pool := s.Registry.GetAgentPool()
	if pool == nil {
		return errors.New("agent pool unavailable")
	}
	sess, ok := pool.Get(agentPoolSessionKey(sessionKey, agentName))
	if !ok {
		return errors.New("agent session not found")
	}
	answer := agenttypes.AskUserAnswer{
		ToolUseID: strings.TrimSpace(in.ToolUseID),
		Answers:   in.Answers,
	}
	if err := manager.MarkPendingAskUserAnswered(ctx, sessionKey, answer.ToolUseID, answer.Answers, time.Now()); err != nil {
		return err
	}
	if err := sess.AnswerQuestion(ctx, answer); err != nil {
		return err
	}
	return nil
}

func currentAssistantLine(responseText string) int {
	if responseText == "" {
		return 0
	}
	return strings.Count(responseText, "\n") + 1
}

func hydratePendingToolCallAux(ctx context.Context, manager *session.Manager, sessionKey string, aux session.ExchangeAux) session.ExchangeAux {
	if manager == nil || aux.ToolCall == nil || strings.TrimSpace(aux.ToolCall.CallID) == "" {
		return aux
	}
	if aux.ToolCall.Kind != agenttypes.ToolKindAskUser {
		return aux
	}
	latest, err := manager.GetFullToolCall(ctx, sessionKey, aux.ToolCall.CallID)
	if err != nil || latest == nil {
		return aux
	}
	if latest.Kind != agenttypes.ToolKindAskUser {
		return aux
	}
	toolCall := *latest
	aux.ToolCall = &toolCall
	return aux
}

func dedupeExchangeAuxBuffer(items []session.ExchangeAux) []session.ExchangeAux {
	if len(items) == 0 {
		return nil
	}
	seenToolCallIDs := make(map[string]int, len(items))
	seenPlanIDs := make(map[string]struct{}, len(items))
	seenCompactIDs := make(map[string]struct{}, len(items))
	out := make([]session.ExchangeAux, 0, len(items))
	for i := len(items) - 1; i >= 0; i-- {
		item := items[i]
		callID := ""
		if item.ToolCall != nil {
			callID = strings.TrimSpace(item.ToolCall.CallID)
		}
		if callID != "" {
			if existingIndex, exists := seenToolCallIDs[callID]; exists {
				if out[existingIndex].ToolCall != nil {
					merged := mergeBufferedToolCall(*item.ToolCall, *out[existingIndex].ToolCall)
					out[existingIndex].ToolCall = &merged
				}
				continue
			}
			seenToolCallIDs[callID] = len(out)
		}
		if item.Plan != nil {
			planID := strings.TrimSpace(item.Plan.ID)
			if planID != "" {
				if _, exists := seenPlanIDs[planID]; exists {
					continue
				}
				seenPlanIDs[planID] = struct{}{}
			}
		}
		if item.Compact != nil {
			compactID := strings.TrimSpace(item.Compact.ID)
			if compactID != "" {
				if _, exists := seenCompactIDs[compactID]; exists {
					continue
				}
				seenCompactIDs[compactID] = struct{}{}
			}
		}
		out = append(out, item)
	}
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}

func shouldPersistToolCallAux(toolCall agenttypes.ToolCall) bool {
	if toolCall.RawType != "claude_task" {
		return true
	}
	return strings.TrimSpace(stringMeta(toolCall.Meta, "subtype")) != "task_progress"
}

func mergeBufferedToolCall(base, next agenttypes.ToolCall) agenttypes.ToolCall {
	merged := base
	if strings.TrimSpace(next.CallID) != "" {
		merged.CallID = next.CallID
	}
	if strings.TrimSpace(next.Title) != "" {
		merged.Title = next.Title
	}
	if strings.TrimSpace(next.Status) != "" {
		merged.Status = next.Status
	}
	if next.Kind != "" {
		merged.Kind = next.Kind
	}
	if len(next.Content) > 0 {
		merged.Content = append([]agenttypes.ToolCallContentItem(nil), next.Content...)
	}
	if len(next.Locations) > 0 {
		merged.Locations = append([]agenttypes.ToolCallLocation(nil), next.Locations...)
	}
	if strings.TrimSpace(next.RawType) != "" {
		merged.RawType = next.RawType
	}
	if len(base.Meta) > 0 || len(next.Meta) > 0 {
		merged.Meta = make(map[string]any, len(base.Meta)+len(next.Meta))
		for key, value := range base.Meta {
			merged.Meta[key] = value
		}
		for key, value := range next.Meta {
			merged.Meta[key] = value
		}
	}
	return merged
}

func appendResponseChunk(responseText, lastResponseUpdateType, chunk string) string {
	if responseText != "" &&
		(lastResponseUpdateType == string(agenttypes.EventTypeThoughtChunk) ||
			lastResponseUpdateType == string(agenttypes.EventTypeToolCall) ||
			lastResponseUpdateType == string(agenttypes.EventTypeToolUpdate) ||
			lastResponseUpdateType == string(agenttypes.EventTypeTodoUpdate) ||
			lastResponseUpdateType == string(agenttypes.EventTypePlanUpdate) ||
			lastResponseUpdateType == string(agenttypes.EventTypeCompact)) &&
		!strings.HasSuffix(responseText, "\n\n") &&
		!strings.HasSuffix(responseText, "\n") {
		responseText += "\n\n"
	}
	return responseText + chunk
}

func randomHex(bytes int) string {
	if bytes <= 0 {
		return ""
	}
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func subagentSessionName(toolCall agenttypes.ToolCall, receiverThreadID string) string {
	if prompt := stringMeta(toolCall.Meta, "prompt"); prompt != "" {
		return truncateRunes(prompt, 48)
	}
	return truncateRunes(receiverThreadID, 16)
}

func stringMeta(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, _ := meta[key].(string)
	return strings.TrimSpace(value)
}

func stringSliceMeta(meta map[string]any, key string) []string {
	if meta == nil {
		return nil
	}
	switch value := meta[key].(type) {
	case []string:
		return append([]string(nil), value...)
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				out = append(out, strings.TrimSpace(text))
			}
		}
		return out
	default:
		return nil
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func truncateRunes(value string, limit int) string {
	runes := []rune(strings.TrimSpace(value))
	if limit <= 0 || len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "..."
}

type pathNormalizer interface {
	NormalizePath(string) (string, error)
}

func normalizeAgentUpdatePaths(root pathNormalizer, update agenttypes.Event) agenttypes.Event {
	if root == nil {
		return update
	}
	toolCall, ok := update.Data.(agenttypes.ToolCall)
	if !ok {
		return update
	}

	for i := range toolCall.Locations {
		toolCall.Locations[i].Path = normalizeToolPath(root, toolCall.Locations[i].Path)
	}
	for i := range toolCall.Content {
		toolCall.Content[i].Path = normalizeToolPath(root, toolCall.Content[i].Path)
		if toolCall.Content[i].Type == "text" {
			toolCall.Content[i].Text = normalizeDiffTextPaths(root, toolCall.Content[i].Text)
		}
	}
	if toolCall.Meta != nil {
		if filePath, ok := toolCall.Meta["filePath"].(string); ok {
			toolCall.Meta["filePath"] = normalizeToolPath(root, filePath)
		}
		if path, ok := toolCall.Meta["path"].(string); ok {
			toolCall.Meta["path"] = normalizeToolPath(root, path)
		}
	}
	update.Data = toolCall
	return update
}

func compactAgentUpdate(update agenttypes.Event) agenttypes.Event {
	switch update.Type {
	case agenttypes.EventTypeToolCall, agenttypes.EventTypeToolUpdate:
		if toolCall, ok := update.Data.(agenttypes.ToolCall); ok {
			update.Data = session.CompactToolCall(toolCall)
		}
	}
	return update
}

func normalizeToolPath(root pathNormalizer, path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	normalized, err := root.NormalizePath(path)
	if err != nil {
		return path
	}
	return normalized
}

func normalizeDiffTextPaths(root pathNormalizer, text string) string {
	if strings.TrimSpace(text) == "" {
		return text
	}
	lines := strings.Split(text, "\n")
	changed := false
	for i, line := range lines {
		next, ok := normalizeDiffLine(root, line)
		if !ok || next == line {
			continue
		}
		lines[i] = next
		changed = true
	}
	if !changed {
		return text
	}
	return strings.Join(lines, "\n")
}

func normalizeDiffLine(root pathNormalizer, line string) (string, bool) {
	switch {
	case strings.HasPrefix(line, "diff --git "):
		rest := strings.TrimPrefix(line, "diff --git ")
		parts := strings.SplitN(rest, " ", 2)
		if len(parts) != 2 {
			return line, false
		}
		left, leftOK := normalizeDiffRef(root, parts[0])
		right, rightOK := normalizeDiffRef(root, parts[1])
		if !leftOK && !rightOK {
			return line, false
		}
		return "diff --git " + left + " " + right, true
	case strings.HasPrefix(line, "--- "):
		next, ok := normalizeDiffRef(root, strings.TrimPrefix(line, "--- "))
		if !ok {
			return line, false
		}
		return "--- " + next, true
	case strings.HasPrefix(line, "+++ "):
		next, ok := normalizeDiffRef(root, strings.TrimPrefix(line, "+++ "))
		if !ok {
			return line, false
		}
		return "+++ " + next, true
	default:
		return line, false
	}
}

func normalizeDiffRef(root pathNormalizer, ref string) (string, bool) {
	trimmed := strings.TrimSpace(ref)
	if trimmed == "" || trimmed == "/dev/null" {
		return ref, false
	}

	prefix := ""
	path := trimmed
	switch {
	case strings.HasPrefix(trimmed, "a/"), strings.HasPrefix(trimmed, "b/"):
		prefix = trimmed[:2]
		path = trimmed[2:]
	}

	normalized := normalizeToolPath(root, path)
	if normalized == path || normalized == "" {
		return ref, false
	}
	return prefix + normalized, true
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
	if active.session != nil {
		// Let the runtime emit its own turn boundary after interrupt. Canceling
		// turnCtx first can dequeue the current waiter, so a late ResultMessage
		// may be delivered to the next queued turn.
		if err := active.session.CancelCurrentTurn(); err != nil {
			log.Printf("[session] turn.cancel.error root=%s session=%s err=%v", in.RootID, current.Key, err)
			active.cancel()
			return err
		}
		return nil
	}
	active.cancel()
	return nil
}
