package api

import (
	"context"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/commandexec"
	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/githubimport"
	"mindfs/server/internal/preferences"
	"mindfs/server/internal/relay"
	"mindfs/server/internal/scheduled"
	"mindfs/server/internal/session"
	"mindfs/server/internal/update"
	"mindfs/server/internal/webpush"
)

type RootContext struct {
	Root    fs.RootInfo
	Session *session.Manager
	Watcher *fs.SharedFileWatcher
}

type AppContext struct {
	Dirs      *fs.Registry
	Agents    *agent.Pool
	Prober    *agent.Prober
	Relay     *relay.Manager
	RelayTips *relay.TipsService
	Update    *update.Service
	GitHub    *githubimport.Service
	E2EE      *e2ee.Manager
	WebPush   *webpush.Service
	Prefs     *preferences.Store
	Scheduled *scheduled.Service

	mu                       sync.RWMutex
	roots                    map[string]*RootContext // root id -> root context
	fileChangeListeners      []func(fs.FileChangeEvent)
	fileChangeBatchListeners []func(fs.FileChangeBatchEvent)
	relatedFileListeners     []func(fs.RelatedFileEvent)
	streamHub                *StreamHub
	candidateRegistry        *usecase.CandidateRegistry
	externalImporters        map[string]agenttypes.ExternalSessionImporter
}

func (s *AppContext) GetRootContext(rootID string) (*RootContext, error) {
	if rootID == "" {
		return nil, errors.New("root id required")
	}
	if s.Dirs == nil {
		return nil, errors.New("registry not configured")
	}
	root, ok := s.Dirs.Get(rootID)
	if !ok {
		return nil, errors.New("root not found")
	}
	if root.ID == "" {
		return nil, errors.New("invalid root")
	}

	s.mu.RLock()
	if ctx, ok := s.roots[root.ID]; ok {
		s.mu.RUnlock()
		return ctx, nil
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.roots == nil {
		s.roots = make(map[string]*RootContext)
	}
	if ctx, ok := s.roots[root.ID]; ok {
		return ctx, nil
	}
	ctx := &RootContext{Root: root}
	s.roots[root.ID] = ctx
	return ctx, nil
}

func (s *AppContext) GetRoot(rootID string) (fs.RootInfo, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return fs.RootInfo{}, err
	}
	return rootCtx.Root, nil
}

func (s *AppContext) GetSessionManager(rootID string) (*session.Manager, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if rootCtx.Session != nil {
		return rootCtx.Session, nil
	}
	mgr := session.NewManager(rootCtx.Root)
	mgr.StartIdleLoop(context.Background())
	rootCtx.Session = mgr

	return mgr, nil
}

func (s *AppContext) GetFileWatcher(rootID string, manager *session.Manager) (*fs.SharedFileWatcher, error) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if rootCtx.Watcher != nil {
		return rootCtx.Watcher, nil
	}
	watcher, err := fs.NewSharedFileWatcher(rootCtx.Root, manager)
	if err != nil {
		return nil, err
	}
	watcher.SetOnFileChange(s.emitFileChange)
	watcher.SetOnFileChangeBatch(s.emitFileChangeBatch)
	watcher.SetOnRelatedFile(s.emitRelatedFile)
	rootCtx.Watcher = watcher
	return watcher, nil
}

func (s *AppContext) ReleaseFileWatcher(rootID, sessionKey string) {
	rootCtx, err := s.GetRootContext(rootID)
	if err != nil {
		return
	}

	s.mu.Lock()
	watcher := rootCtx.Watcher
	s.mu.Unlock()
	if watcher == nil {
		return
	}

	watcher.UnregisterSession(sessionKey)
	if watcher.SessionCount() > 0 {
		return
	}

	s.mu.Lock()
	if rootCtx.Watcher == watcher {
		rootCtx.Watcher = nil
	}
	s.mu.Unlock()
	watcher.Close()
}

func (s *AppContext) GetAgentPool() *agent.Pool {
	return s.Agents
}

func (s *AppContext) GetPreferences() *preferences.Store {
	return s.Prefs
}

func (s *AppContext) GetExternalSessionImporter(agentName string) (agenttypes.ExternalSessionImporter, error) {
	if s.Agents == nil {
		return nil, errors.New("agent pool not configured")
	}
	trimmed := strings.TrimSpace(agentName)
	if trimmed == "" {
		return nil, errors.New("agent required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.externalImporters == nil {
		s.externalImporters = make(map[string]agenttypes.ExternalSessionImporter)
	}
	if importer, ok := s.externalImporters[trimmed]; ok && importer != nil {
		return importer, nil
	}
	def, ok := s.Agents.Config().GetAgent(trimmed)
	if !ok {
		return nil, errors.New("agent not configured: " + trimmed)
	}
	importer, err := agent.NewExternalSessionImporter(def)
	if err != nil {
		return nil, err
	}
	s.externalImporters[trimmed] = importer
	return importer, nil
}

func (s *AppContext) GetProber() *agent.Prober {
	return s.Prober
}

func (s *AppContext) GetDirRegistry() *fs.Registry {
	return s.Dirs
}

func (s *AppContext) GetRelayManager() *relay.Manager {
	return s.Relay
}

func (s *AppContext) GetRelayTipsService() *relay.TipsService {
	return s.RelayTips
}

func (s *AppContext) GetUpdateService() *update.Service {
	return s.Update
}

func (s *AppContext) GetWebPushService() *webpush.Service {
	return s.WebPush
}

func (s *AppContext) GetGitHubImportService() *githubimport.Service {
	return s.GitHub
}

func (s *AppContext) GetE2EEManager() *e2ee.Manager {
	return s.E2EE
}

func (s *AppContext) UpsertRoot(path string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	dir, err := s.Dirs.Upsert(path)
	if err == nil && s.Scheduled != nil {
		if reloadErr := s.Scheduled.ReloadRoot(dir.ID); reloadErr != nil {
			log.Printf("[scheduled-agent] reload.error root=%s err=%v", dir.ID, reloadErr)
		}
	}
	return dir, err
}

func (s *AppContext) RemoveRoot(path string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	dir, err := s.Dirs.Remove(path)
	if err != nil {
		return fs.RootInfo{}, err
	}
	s.mu.Lock()
	rootCtx := s.roots[dir.ID]
	delete(s.roots, dir.ID)
	s.mu.Unlock()
	if rootCtx != nil && rootCtx.Watcher != nil {
		rootCtx.Watcher.Close()
	}
	if rootCtx != nil && rootCtx.Session != nil {
		_ = rootCtx.Session.Shutdown()
	}
	if s.Scheduled != nil {
		s.Scheduled.RemoveRoot(dir.ID)
	}
	return dir, nil
}

func (s *AppContext) ReleaseRootResources(rootID string) {
	rootID = strings.TrimSpace(rootID)
	if rootID == "" {
		return
	}
	s.mu.Lock()
	rootCtx := s.roots[rootID]
	delete(s.roots, rootID)
	s.mu.Unlock()
	if rootCtx == nil {
		return
	}
	if rootCtx.Watcher != nil {
		rootCtx.Watcher.Close()
	}
	if rootCtx.Session != nil {
		_ = rootCtx.Session.Shutdown()
	}
}

func (s *AppContext) RenameRoot(rootID, name, rootPath string) (fs.RootInfo, error) {
	if s.Dirs == nil {
		return fs.RootInfo{}, errors.New("registry not configured")
	}
	dir, err := s.Dirs.Rename(rootID, name, rootPath)
	if err != nil {
		return fs.RootInfo{}, err
	}
	s.ReleaseRootResources(rootID)
	if s.Scheduled != nil {
		if reloadErr := s.Scheduled.ReloadRoot(dir.ID); reloadErr != nil {
			log.Printf("[scheduled-agent] reload.error root=%s err=%v", dir.ID, reloadErr)
		}
	}
	return dir, nil
}

func (s *AppContext) ListRoots() []fs.RootInfo {
	if s.Dirs == nil {
		return []fs.RootInfo{}
	}
	return s.Dirs.List()
}

func (s *AppContext) AddFileChangeListener(listener func(fs.FileChangeEvent)) {
	if listener == nil {
		return
	}
	s.mu.Lock()
	s.fileChangeListeners = append(s.fileChangeListeners, listener)
	s.mu.Unlock()
}

func (s *AppContext) AddFileChangeBatchListener(listener func(fs.FileChangeBatchEvent)) {
	if listener == nil {
		return
	}
	s.mu.Lock()
	s.fileChangeBatchListeners = append(s.fileChangeBatchListeners, listener)
	s.mu.Unlock()
}

func (s *AppContext) AddRelatedFileListener(listener func(fs.RelatedFileEvent)) {
	if listener == nil {
		return
	}
	s.mu.Lock()
	s.relatedFileListeners = append(s.relatedFileListeners, listener)
	s.mu.Unlock()
}

func (s *AppContext) emitFileChange(change fs.FileChangeEvent) {
	s.mu.RLock()
	listeners := append([]func(fs.FileChangeEvent){}, s.fileChangeListeners...)
	s.mu.RUnlock()
	for _, listener := range listeners {
		listener(change)
	}
}

func (s *AppContext) emitFileChangeBatch(change fs.FileChangeBatchEvent) {
	s.mu.RLock()
	listeners := append([]func(fs.FileChangeBatchEvent){}, s.fileChangeBatchListeners...)
	s.mu.RUnlock()
	for _, listener := range listeners {
		listener(change)
	}
}

func (s *AppContext) emitRelatedFile(change fs.RelatedFileEvent) {
	s.mu.RLock()
	listeners := append([]func(fs.RelatedFileEvent){}, s.relatedFileListeners...)
	s.mu.RUnlock()
	for _, listener := range listeners {
		listener(change)
	}
}

func (s *AppContext) GetSessionStreamHub() *StreamHub {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.streamHub == nil {
		s.streamHub = NewStreamHub(s.E2EE)
	}
	return s.streamHub
}

func (s *AppContext) BroadcastSessionMetaUpdated(rootID string, sess *session.Session) {
	if sess == nil {
		s.GetSessionStreamHub().BroadcastAll(WSResponse{Type: "session.meta.updated"})
		return
	}
	s.GetSessionStreamHub().BroadcastAll(WSResponse{
		Type: "session.meta.updated",
		Payload: map[string]any{
			"root_id": rootID,
			"session": map[string]any{
				"key":                 sess.Key,
				"type":                sess.Type,
				"parent_session_key":  sess.ParentSessionKey,
				"parent_tool_call_id": sess.ParentToolCallID,
				"name":                sess.Name,
				"model":               sess.Model,
				"mode":                session.InferModeFromSession(sess),
				"effort":              session.InferEffortFromSession(sess),
				"fast_service":        session.InferFastServiceFromSession(sess),
				"plan_mode":           sess.PlanMode,
				"updated_at":          sess.UpdatedAt,
			},
		},
	})
}

func (s *AppContext) SetSessionPendingReply(rootID, sessionKey, sessionTitle string) {
	s.GetSessionStreamHub().SetPendingReply(rootID, sessionKey, sessionTitle)
}

func (s *AppContext) BroadcastSessionUserMessage(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, fastService, content string) {
	s.GetSessionStreamHub().BroadcastSessionUserMessage(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, fastService, content, "", false)
}

func (s *AppContext) BroadcastSessionUpdate(rootID, sessionKey string, update agenttypes.Event) {
	event := updateToEvent(update)
	if event == nil {
		return
	}
	s.notifyAskUserIfNeeded(rootID, sessionKey, event)
	s.GetSessionStreamHub().BroadcastSessionStream(rootID, sessionKey, event)
}

func (s *AppContext) BroadcastSessionError(rootID, sessionKey, message string) {
	s.GetSessionStreamHub().BroadcastSessionStream(rootID, sessionKey, &StreamEvent{
		Type: "error",
		Data: map[string]string{"message": normalizeAgentErrorMessage(errors.New(message))},
	})
}

func (s *AppContext) BroadcastSessionDone(rootID, sessionKey, requestID string) {
	hub := s.GetSessionStreamHub()
	pending := hub.PendingSessionSnapshot(sessionKey)
	s.notifySessionDone(rootID, sessionKey, requestID, pending)
	hub.ClearSessionPending(sessionKey)
	hub.BroadcastSessionDone(rootID, sessionKey, requestID)
}

func (s *AppContext) BroadcastScheduledTaskDone(rootID, taskID, taskName, sessionKey, summary string) {
	s.notifyScheduled(rootID, taskID, taskName, sessionKey, summary, "", true)
}

func (s *AppContext) BroadcastScheduledTaskFailed(rootID, taskID, taskName, sessionKey, message string) {
	s.notifyScheduled(rootID, taskID, taskName, sessionKey, "", message, false)
}

func (s *AppContext) notifySessionDone(rootID, sessionKey, requestID string, pending PendingSessionSnapshot) {
	if s == nil || s.WebPush == nil || !s.WebPush.Enabled() {
		return
	}
	if strings.HasPrefix(strings.TrimSpace(requestID), "scheduled:") {
		return
	}
	rootTitle := s.rootTitle(rootID)
	sessionTitle := strings.TrimSpace(pending.SessionTitle)
	if sessionTitle == "" {
		sessionTitle = s.sessionTitle(rootID, sessionKey)
	}
	summary := strings.TrimSpace(pending.Summary)
	eventID := strings.TrimSpace(requestID)
	if eventID == "" {
		eventID = "session.done:" + rootID + ":" + sessionKey + ":" + pending.UpdatedAt.Format(time.RFC3339Nano)
	}
	s.WebPush.NotifySession(context.Background(), webpush.SessionNotification{
		Type:         "session.done",
		RootID:       rootID,
		RootTitle:    rootTitle,
		SessionKey:   sessionKey,
		SessionTitle: sessionTitle,
		Summary:      summary,
		EventID:      eventID,
	})
}

func (s *AppContext) notifyAskUserIfNeeded(rootID, sessionKey string, event *StreamEvent) {
	if s == nil || s.WebPush == nil || !s.WebPush.Enabled() || event == nil || event.Type != string(agenttypes.EventTypeToolCall) {
		return
	}
	toolCall, ok := event.Data.(agenttypes.ToolCall)
	if !ok || toolCall.Kind != agenttypes.ToolKindAskUser {
		return
	}
	s.WebPush.NotifySession(context.Background(), webpush.SessionNotification{
		Type:         "session.ask_user",
		RootID:       rootID,
		RootTitle:    s.rootTitle(rootID),
		SessionKey:   sessionKey,
		SessionTitle: s.sessionTitle(rootID, sessionKey),
		Summary:      askUserSummary(toolCall),
		EventID:      "session.ask_user:" + rootID + ":" + sessionKey + ":" + toolCall.CallID,
	})
}

func (s *AppContext) notifyScheduled(rootID, taskID, taskName, sessionKey, summary, message string, success bool) {
	if s == nil || s.WebPush == nil || !s.WebPush.Enabled() {
		return
	}
	if strings.TrimSpace(summary) == "" && success {
		summary = s.sessionSummary(rootID, sessionKey)
	}
	s.WebPush.NotifyScheduled(context.Background(), webpush.ScheduledNotification{
		RootID:     rootID,
		RootTitle:  s.rootTitle(rootID),
		TaskID:     taskID,
		TaskName:   taskName,
		SessionKey: sessionKey,
		Summary:    summary,
		Error:      message,
		Success:    success,
		EventID:    "scheduled:" + rootID + ":" + taskID + ":" + time.Now().UTC().Format(time.RFC3339Nano),
	})
}

func (s *AppContext) rootTitle(rootID string) string {
	if s == nil || s.Dirs == nil {
		return strings.TrimSpace(rootID)
	}
	root, ok := s.Dirs.Get(rootID)
	if !ok {
		return strings.TrimSpace(rootID)
	}
	return firstNonBlank(root.Name, root.ID)
}

func (s *AppContext) sessionTitle(rootID, sessionKey string) string {
	if strings.TrimSpace(rootID) == "" || strings.TrimSpace(sessionKey) == "" {
		return ""
	}
	manager, err := s.GetSessionManager(rootID)
	if err != nil {
		return ""
	}
	sess, err := manager.Get(context.Background(), sessionKey, 0)
	if err != nil || sess == nil {
		return ""
	}
	return strings.TrimSpace(sess.Name)
}

func (s *AppContext) sessionSummary(rootID, sessionKey string) string {
	if strings.TrimSpace(rootID) == "" || strings.TrimSpace(sessionKey) == "" {
		return ""
	}
	manager, err := s.GetSessionManager(rootID)
	if err != nil {
		return ""
	}
	sess, err := manager.Get(context.Background(), sessionKey, 0)
	if err != nil || sess == nil || len(sess.Exchanges) == 0 {
		return ""
	}
	for i := len(sess.Exchanges) - 1; i >= 0; i-- {
		if strings.TrimSpace(sess.Exchanges[i].Role) == "assistant" {
			return lastRunes(strings.TrimSpace(sess.Exchanges[i].Content), 80)
		}
	}
	return ""
}

func askUserSummary(toolCall agenttypes.ToolCall) string {
	if len(toolCall.Content) > 0 {
		for _, item := range toolCall.Content {
			if strings.TrimSpace(item.Text) != "" {
				return strings.TrimSpace(item.Text)
			}
		}
	}
	if toolCall.Meta != nil {
		if questions, ok := toolCall.Meta["questions"].([]agenttypes.AskUserQuestionItem); ok && len(questions) > 0 {
			return strings.TrimSpace(questions[0].Question)
		}
		if input := strings.TrimSpace(stringMetaValue(toolCall.Meta, "input")); input != "" {
			return "需要确认：" + lastRunes(input, 80)
		}
	}
	return "需要你继续输入"
}

func stringMetaValue(meta map[string]any, key string) string {
	if meta == nil {
		return ""
	}
	value, _ := meta[key].(string)
	return strings.TrimSpace(value)
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *AppContext) GetCandidateRegistry() *usecase.CandidateRegistry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.candidateRegistry == nil {
		registry := usecase.NewCandidateRegistry()
		registry.Register(usecase.NewFileCandidateProvider())
		if store, err := usecase.NewPromptStore(); err == nil {
			registry.Register(usecase.NewPromptCandidateProvider(store))
		}
		registry.Register(usecase.NewSkillCandidateProvider())
		registry.Register(usecase.NewCommandCandidateProvider(func() usecase.ShellHistorySpec {
			if s.Agents == nil {
				return usecase.ShellHistorySpec{}
			}
			cfg := s.Agents.Config()
			shells := make([]commandexec.ShellSpec, 0, len(cfg.Shells))
			for _, shell := range cfg.Shells {
				shells = append(shells, commandexec.ShellSpec{
					Command:       shell.Command,
					Args:          append([]string(nil), shell.Args...),
					LongShellArgs: append([]string(nil), shell.LongShellArgs...),
					CommandPrefix: shell.CommandPrefix,
				})
			}
			if shell, ok := commandexec.ResolveConfiguredShell(shells); ok {
				return usecase.ShellHistorySpec{Command: shell.Command}
			}
			return usecase.ShellHistorySpec{}
		}))
		registry.Register(usecase.NewSlashCommandCandidateProvider(func(agentName string) (agent.Status, bool) {
			if s.Prober == nil {
				return agent.Status{}, false
			}
			return s.Prober.GetStatus(agentName)
		}))
		s.candidateRegistry = registry
	}
	return s.candidateRegistry
}
