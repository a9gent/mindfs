package api

import (
	"context"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
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
	"mindfs/server/internal/gitview"
	"mindfs/server/internal/kanban"
	"mindfs/server/internal/notify"
	"mindfs/server/internal/notifyscript"
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
	Notify    *notifyscript.Service
	Prefs     *preferences.Store
	Scheduled *scheduled.Service
	Kanban    *kanban.Service

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

func (s *AppContext) GetKanbanService() (*kanban.Service, error) {
	if s == nil {
		return nil, errors.New("app context required")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Kanban != nil {
		return s.Kanban, nil
	}
	store, err := kanban.NewTemplateStore()
	if err != nil {
		return nil, err
	}
	s.Kanban = kanban.NewService(store, s)
	s.Kanban.SetRunner(s)
	return s.Kanban, nil
}

func (s *AppContext) CreateTaskWorktree(ctx context.Context, rootID, name, branchMode, branch string) (kanban.WorktreeInfo, error) {
	root, err := s.GetRoot(rootID)
	if err != nil {
		return kanban.WorktreeInfo{}, err
	}
	branchMode = strings.TrimSpace(branchMode)
	if branchMode == "" {
		branchMode = "new"
	}
	parentPath := filepath.Join(root.RootPath, ".worktree")
	if err := os.MkdirAll(parentPath, 0o755); err != nil {
		return kanban.WorktreeInfo{}, err
	}
	if err := ensureTaskWorktreeExcluded(root.RootPath); err != nil {
		log.Printf("[kanban] worktree.exclude.error root=%s err=%v", root.RootPath, err)
	}
	uc := &usecase.Service{Registry: s}
	out, err := uc.CreateGitWorktree(ctx, usecase.CreateGitWorktreeInput{
		RootID:     rootID,
		ParentPath: parentPath,
		Name:       name,
		BranchMode: branchMode,
		Branch:     branch,
		Register:   false,
	})
	if err != nil {
		return kanban.WorktreeInfo{}, err
	}
	return kanban.WorktreeInfo{RootID: rootID, Path: out.Dir.RootPath}, nil
}

func ensureTaskWorktreeExcluded(rootPath string) error {
	gitDir := filepath.Join(rootPath, ".git")
	if info, err := os.Stat(gitDir); err != nil || !info.IsDir() {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	gitInfoDir := filepath.Join(gitDir, "info")
	if err := os.MkdirAll(gitInfoDir, 0o755); err != nil {
		return err
	}
	excludePath := filepath.Join(gitInfoDir, "exclude")
	const entry = "/.worktree/"
	if data, err := os.ReadFile(excludePath); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == entry {
				return nil
			}
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	file, err := os.OpenFile(excludePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	if stat, err := file.Stat(); err == nil && stat.Size() > 0 {
		if _, err := file.WriteString("\n"); err != nil {
			return err
		}
	}
	_, err = file.WriteString(entry + "\n")
	return err
}

func (s *AppContext) EnsureAgentSession(ctx context.Context, exec kanban.AgentStageExecution) (string, error) {
	if strings.TrimSpace(exec.RootID) == "" {
		return "", errors.New("root_id required")
	}
	if strings.TrimSpace(exec.Run.SessionKey) != "" && exec.Stage.SessionReusePolicy != kanban.SessionReuseAlwaysNew {
		return strings.TrimSpace(exec.Run.SessionKey), nil
	}
	uc := &usecase.Service{Registry: s}
	switch strings.TrimSpace(exec.Stage.SessionReusePolicy) {
	case kanban.SessionReuseTaskMain, "":
		if strings.TrimSpace(exec.Task.MainSessionKey) != "" {
			return strings.TrimSpace(exec.Task.MainSessionKey), nil
		}
	case kanban.SessionReuseSameStage:
		if strings.TrimSpace(exec.Run.SessionKey) != "" {
			return strings.TrimSpace(exec.Run.SessionKey), nil
		}
	}
	name := strings.TrimSpace(exec.Task.TaskTemplateName)
	if exec.Task.TaskNumber > 0 {
		number := "#" + strconv.Itoa(exec.Task.TaskNumber)
		if name == "" {
			name = number
		} else {
			name = name + " / " + number
		}
	}
	if strings.TrimSpace(name) == "" {
		name = usecase.BuildFallbackSessionName(exec.Prompt)
	}
	created, err := uc.CreateSession(ctx, usecase.CreateSessionInput{
		RootID: exec.RootID,
		Input: session.CreateInput{
			Type:     session.TypeChat,
			Agent:    exec.Stage.Agent,
			Model:    exec.Stage.Model,
			PlanMode: exec.Stage.PlanMode,
			Name:     name,
			TaskID:   exec.Task.ID,
		},
	})
	if err != nil {
		return "", err
	}
	s.BroadcastSessionMetaUpdated(exec.RootID, created)
	return created.Key, nil
}

func (s *AppContext) RunAgentStage(ctx context.Context, exec kanban.AgentStageExecution) error {
	if strings.TrimSpace(exec.RootID) == "" {
		return errors.New("root_id required")
	}
	if strings.TrimSpace(exec.Run.SessionKey) == "" {
		return errors.New("session_key required")
	}
	if strings.TrimSpace(exec.Prompt) == "" {
		return errors.New("agent prompt required")
	}
	uc := &usecase.Service{Registry: s}
	sessionKey := strings.TrimSpace(exec.Run.SessionKey)
	sessionName := s.sessionTitle(exec.RootID, sessionKey)
	updateTracker := newTurnUpdateTracker()
	planMode := exec.Stage.PlanMode
	err := uc.SendMessage(ctx, usecase.SendMessageInput{
		RootID:          exec.RootID,
		RuntimeRootPath: exec.RuntimeRootPath,
		Key:             sessionKey,
		Agent:           exec.Stage.Agent,
		Model:           exec.Stage.Model,
		Mode:            exec.Stage.Mode,
		Effort:          exec.Stage.Effort,
		FastService:     normalizeFastServiceValue(exec.Stage.FastService),
		PlanMode:        &planMode,
		Content:         exec.Prompt,
		OnStart: func() {
			s.BroadcastSessionUserMessage(exec.RootID, sessionKey, session.TypeChat, sessionName, exec.Stage.Agent, exec.Stage.Model, exec.Stage.Mode, exec.Stage.Effort, exec.Stage.FastService, planMode, exec.Prompt)
		},
		OnUpdate: func(update agenttypes.Event) {
			updateTracker.Begin()
			defer updateTracker.End()
			s.BroadcastSessionUpdate(exec.RootID, sessionKey, update)
		},
		OnSubSessionCreated: func(created *session.Session) {
			s.BroadcastSessionMetaUpdated(exec.RootID, created)
			if created != nil {
				s.SetSessionPendingReply(exec.RootID, created.Key, created.Name)
			}
		},
		OnSubSessionUpdate: func(sessionKey string, update agenttypes.Event) {
			updateTracker.Begin()
			defer updateTracker.End()
			s.BroadcastSessionUpdate(exec.RootID, sessionKey, update)
			if update.Type == agenttypes.EventTypeMessageDone {
				s.BroadcastSessionDone(exec.RootID, sessionKey, "")
			}
		},
	})
	if err != nil {
		s.BroadcastSessionError(exec.RootID, sessionKey, err.Error())
	}
	if ok := updateTracker.WaitIdle(ctx, sessionDoneSettleWindow, sessionDoneMaxWait); !ok {
		log.Printf("[kanban] session.done.wait_timeout root=%s session=%s task=%s", exec.RootID, sessionKey, exec.Task.ID)
	}
	s.BroadcastSessionDone(exec.RootID, sessionKey, "")
	return err
}

func (s *AppContext) TaskUpdated(rootID string, detail kanban.TaskDetail) {
	s.GetSessionStreamHub().BroadcastAll(WSResponse{
		Type: "task.updated",
		Payload: map[string]any{
			"root_id": rootID,
			"task":    detail.Task,
			"detail":  detail,
		},
	})
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
	watcher, err := fs.NewSharedFileWatcher(rootCtx.Root, manager, resolveRelatedWorktree)
	if err != nil {
		return nil, err
	}
	watcher.SetOnFileChange(s.emitFileChange)
	watcher.SetOnFileChangeBatch(s.emitFileChangeBatch)
	watcher.SetOnRelatedFile(s.emitRelatedFile)
	rootCtx.Watcher = watcher
	return watcher, nil
}

func resolveRelatedWorktree(ctx context.Context, root fs.RootInfo, filePath string) (fs.RelatedWorktreeMatch, bool) {
	cleanPath := cleanToolFilePath(filePath)
	if cleanPath == "" {
		return fs.RelatedWorktreeMatch{}, false
	}
	if !filepath.IsAbs(cleanPath) {
		cleanPath = filepath.Join(root.RootPath, cleanPath)
	}
	cleanPath = filepath.Clean(cleanPath)
	worktrees, err := gitview.ListWorktrees(ctx, root.RootPath)
	if err != nil {
		return fs.RelatedWorktreeMatch{}, false
	}
	var best fs.RelatedWorktreeMatch
	bestPathLen := -1
	for _, item := range worktrees.Items {
		if !pathInsideDir(cleanPath, item.Path) {
			continue
		}
		candidate := fs.RelatedWorktreeMatch{
			Path:    item.Path,
			Branch:  item.Branch,
			Head:    item.Head,
			Current: item.Current,
		}
		pathLen := len(filepath.Clean(item.Path))
		if pathLen > bestPathLen {
			best = candidate
			bestPathLen = pathLen
		}
	}
	if bestPathLen >= 0 {
		return best, true
	}
	if repo, err := gitview.ResolveRepositoryForPath(ctx, cleanPath); err == nil && strings.TrimSpace(repo.Path) != "" {
		return fs.RelatedWorktreeMatch{
			Path:    filepath.Clean(repo.Path),
			Head:    strings.TrimSpace(repo.Head),
			Current: pathInsideDir(cleanPath, root.RootPath),
		}, true
	}
	return fs.RelatedWorktreeMatch{}, false
}

func cleanToolFilePath(path string) string {
	path = strings.TrimSpace(strings.SplitN(path, "#", 2)[0])
	if path == "" {
		return ""
	}
	return filepath.Clean(path)
}

func pathInsideDir(path, dir string) bool {
	path = filepath.Clean(path)
	dir = filepath.Clean(strings.TrimSpace(dir))
	if resolvedPath, err := filepath.EvalSymlinks(path); err == nil {
		path = filepath.Clean(resolvedPath)
	}
	if resolvedDir, err := filepath.EvalSymlinks(dir); err == nil {
		dir = filepath.Clean(resolvedDir)
	}
	if path == "" || dir == "" {
		return false
	}
	if path == dir {
		return true
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
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
				"task_id":             sess.TaskID,
				"name":                sess.Name,
				"agent":               session.InferAgentFromSession(sess),
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

func (s *AppContext) BroadcastSessionUserMessage(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, fastService string, planMode bool, content string) {
	s.ClearTaskAuxFlagsForSession(rootID, sessionKey)
	s.GetSessionStreamHub().BroadcastSessionUserMessage(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, fastService, planMode, content, "", false)
}

func (s *AppContext) BroadcastSessionUpdate(rootID, sessionKey string, update agenttypes.Event) {
	event := updateToEvent(update)
	if event == nil {
		return
	}
	s.updateTaskAuxFlagsFromEvent(rootID, sessionKey, event)
	s.notifyAskUserIfNeeded(rootID, sessionKey, event)
	s.GetSessionStreamHub().BroadcastSessionStream(rootID, sessionKey, event)
}

func (s *AppContext) BroadcastSessionError(rootID, sessionKey, message string) {
	s.UpdateTaskSessionErrorForSession(rootID, sessionKey, message)
	s.GetSessionStreamHub().BroadcastSessionStream(rootID, sessionKey, &StreamEvent{
		Type: "error",
		Data: map[string]string{"message": normalizeAgentErrorMessage(errors.New(message))},
	})
}

func (s *AppContext) ClearTaskAuxFlagsForSession(rootID, sessionKey string) {
	empty := ""
	no := false
	s.updateTaskAuxFlagsForSession(rootID, sessionKey, kanban.TaskAuxFlagsPatch{
		AskUserWaiting: &no,
		HasPlan:        &no,
		HasTodos:       &no,
		HasTask:        &no,
		SessionError:   &empty,
	}, "aux_flags_cleared")
}

func (s *AppContext) UpdateTaskSessionErrorForSession(rootID, sessionKey, message string) {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		return
	}
	s.updateTaskAuxFlagsForSession(rootID, sessionKey, kanban.TaskAuxFlagsPatch{
		SessionError: &trimmed,
	}, "agent_session_error")
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
	if s == nil {
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
	payload := notify.BuildSessionPayload(notify.SessionNotification{
		Type:         "session.done",
		RootID:       rootID,
		RootTitle:    rootTitle,
		SessionKey:   sessionKey,
		SessionTitle: sessionTitle,
		Summary:      summary,
		EventID:      eventID,
	})
	s.notifyPayload(context.Background(), eventID, payload)
}

func (s *AppContext) notifyAskUserIfNeeded(rootID, sessionKey string, event *StreamEvent) {
	if s == nil || event == nil || event.Type != string(agenttypes.EventTypeToolCall) {
		return
	}
	toolCall, ok := event.Data.(agenttypes.ToolCall)
	if !ok || toolCall.Kind != agenttypes.ToolKindAskUser {
		return
	}
	payload := notify.BuildSessionPayload(notify.SessionNotification{
		Type:         "session.ask_user",
		RootID:       rootID,
		RootTitle:    s.rootTitle(rootID),
		SessionKey:   sessionKey,
		SessionTitle: s.sessionTitle(rootID, sessionKey),
		Summary:      askUserSummary(toolCall),
		EventID:      "session.ask_user:" + rootID + ":" + sessionKey + ":" + toolCall.CallID,
	})
	s.notifyPayload(context.Background(), notify.EventID(payload), payload)
}

func (s *AppContext) updateTaskAuxFlagsFromEvent(rootID, sessionKey string, event *StreamEvent) {
	if s == nil || event == nil {
		return
	}
	patch := kanban.TaskAuxFlagsPatch{}
	eventType := ""
	switch event.Type {
	case string(agenttypes.EventTypeToolCall):
		toolCall, ok := event.Data.(agenttypes.ToolCall)
		if !ok {
			return
		}
		switch toolCall.Kind {
		case agenttypes.ToolKindAskUser:
			value := true
			patch.AskUserWaiting = &value
			eventType = "aux_ask_user_waiting"
		case agenttypes.ToolKindTask:
			value := true
			patch.HasTask = &value
			eventType = "aux_task_seen"
		default:
			return
		}
	case string(agenttypes.EventTypeToolUpdate):
		toolCall, ok := event.Data.(agenttypes.ToolCall)
		if !ok || toolCall.Kind != agenttypes.ToolKindAskUser || strings.TrimSpace(toolCall.Status) != "complete" {
			return
		}
		value := false
		patch.AskUserWaiting = &value
		eventType = "aux_ask_user_answered"
	case string(agenttypes.EventTypePlanUpdate):
		value := true
		patch.HasPlan = &value
		eventType = "aux_plan_seen"
	case string(agenttypes.EventTypeTodoUpdate):
		value := true
		patch.HasTodos = &value
		eventType = "aux_todos_seen"
	default:
		return
	}
	s.updateTaskAuxFlagsForSession(rootID, sessionKey, patch, eventType)
}

func (s *AppContext) updateTaskAuxFlagsForSession(rootID, sessionKey string, patch kanban.TaskAuxFlagsPatch, eventType string) {
	if s == nil {
		return
	}
	manager, err := s.GetSessionManager(rootID)
	if err != nil {
		return
	}
	sess, err := manager.Get(context.Background(), sessionKey, 0)
	if err != nil || sess == nil || strings.TrimSpace(sess.TaskID) == "" {
		return
	}
	svc, err := s.GetKanbanService()
	if err != nil {
		return
	}
	if _, err := svc.UpdateTaskAuxFlags(context.Background(), rootID, sess.TaskID, patch, eventType); err != nil {
		log.Printf("[kanban] task.aux_flags.update.error root=%s task=%s session=%s err=%v", rootID, sess.TaskID, sessionKey, err)
	}
}

func (s *AppContext) notifyScheduled(rootID, taskID, taskName, sessionKey, summary, message string, success bool) {
	if s == nil {
		return
	}
	if strings.TrimSpace(summary) == "" && success {
		summary = s.sessionSummary(rootID, sessionKey)
	}
	eventID := "scheduled:" + rootID + ":" + taskID + ":" + time.Now().UTC().Format(time.RFC3339Nano)
	payload := notify.BuildScheduledPayload(notify.ScheduledNotification{
		RootID:     rootID,
		RootTitle:  s.rootTitle(rootID),
		TaskID:     taskID,
		TaskName:   taskName,
		SessionKey: sessionKey,
		Summary:    summary,
		Error:      message,
		Success:    success,
		EventID:    eventID,
	})
	s.notifyPayload(context.Background(), eventID, payload)
}

func (s *AppContext) notifyPayload(ctx context.Context, eventID string, payload notify.Payload) {
	if s == nil {
		return
	}
	if s.WebPush != nil && s.WebPush.Enabled() {
		s.WebPush.NotifyPayload(ctx, eventID, payload)
	}
	if s.Notify != nil && s.Notify.Enabled() {
		s.Notify.NotifyPayload(ctx, payload)
	}
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
			return lastRunes(strings.TrimSpace(sess.Exchanges[i].Content), notify.BodyMaxRunes)
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
			return "需要确认：" + lastRunes(input, notify.BodyMaxRunes)
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
