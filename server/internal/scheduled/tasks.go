package scheduled

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"

	"github.com/robfig/cron/v3"
)

const tasksMetaFile = "scheduled-agent-tasks.json"

type SessionActivityBroadcaster interface {
	BroadcastSessionMetaUpdated(rootID string, sess *session.Session)
	SetSessionPendingReply(rootID, sessionKey, sessionTitle string)
	BroadcastSessionUserMessage(rootID, sessionKey, sessionType, sessionName, agentName, model, mode, effort, fastService, content string)
	BroadcastSessionUpdate(rootID, sessionKey string, update agenttypes.Event)
	BroadcastSessionError(rootID, sessionKey, message string)
	BroadcastSessionDone(rootID, sessionKey, requestID string)
	BroadcastScheduledTaskDone(rootID, taskID, taskName, sessionKey, summary string)
	BroadcastScheduledTaskFailed(rootID, taskID, taskName, sessionKey, message string)
}

type Task struct {
	ID                 string     `json:"id"`
	RootID             string     `json:"root_id"`
	Name               string     `json:"name"`
	Enabled            bool       `json:"enabled"`
	TaskCron           string     `json:"task_cron"`
	Agent              string     `json:"agent"`
	Model              string     `json:"model,omitempty"`
	Mode               string     `json:"mode,omitempty"`
	Effort             string     `json:"effort,omitempty"`
	FastService        string     `json:"fast_service,omitempty"`
	Prompt             string     `json:"prompt"`
	NewSessionCron     string     `json:"new_session_cron,omitempty"`
	SessionKey         string     `json:"session_key,omitempty"`
	LastRunAt          *time.Time `json:"last_run_at,omitempty"`
	LastSuccessAt      *time.Time `json:"last_success_at,omitempty"`
	LastError          string     `json:"last_error,omitempty"`
	LastSessionResetAt *time.Time `json:"last_session_reset_at,omitempty"`
	NextRunAt          *time.Time `json:"next_run_at,omitempty"`
	NextNewSessionAt   *time.Time `json:"next_new_session_at,omitempty"`
	Running            bool       `json:"running,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

type Store struct {
	root fs.RootInfo
}

func NewStore(root fs.RootInfo) *Store {
	return &Store{root: root}
}

func (s *Store) List() ([]Task, error) {
	data, err := s.root.ReadMetaFile(tasksMetaFile)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Task{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return []Task{}, nil
	}
	var tasks []Task
	if err := json.Unmarshal(data, &tasks); err != nil {
		return nil, err
	}
	sort.SliceStable(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	return tasks, nil
}

func (s *Store) Save(tasks []Task) error {
	sort.SliceStable(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	data, err := json.MarshalIndent(tasks, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return s.root.WriteMetaFile(tasksMetaFile, data)
}

type Service struct {
	registry    usecase.Registry
	usecase     *usecase.Service
	broadcaster SessionActivityBroadcaster
	parser      cron.Parser
	cron        *cron.Cron

	mu      sync.Mutex
	entries map[string][]cron.EntryID
	running map[string]bool
}

func NewService(registry usecase.Registry, broadcaster SessionActivityBroadcaster) *Service {
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	return &Service{
		registry:    registry,
		usecase:     &usecase.Service{Registry: registry},
		broadcaster: broadcaster,
		parser:      parser,
		cron:        cron.New(cron.WithParser(parser)),
		entries:     map[string][]cron.EntryID{},
		running:     map[string]bool{},
	}
}

func (s *Service) Start(ctx context.Context) {
	if s == nil {
		return
	}
	s.cron.Start()
	for _, root := range s.registry.ListRoots() {
		if err := s.ReloadRoot(root.ID); err != nil {
			log.Printf("[scheduled-agent] reload.error root=%s err=%v", root.ID, err)
		}
	}
	go func() {
		<-ctx.Done()
		stopCtx := s.cron.Stop()
		<-stopCtx.Done()
	}()
}

func (s *Service) List(ctx context.Context, rootID string) ([]Task, error) {
	store, err := s.store(rootID)
	if err != nil {
		return nil, err
	}
	tasks, err := store.List()
	if err != nil {
		return nil, err
	}
	for i := range tasks {
		s.decorateTask(&tasks[i])
	}
	return tasks, nil
}

type SaveInput struct {
	ID             string `json:"id"`
	RootID         string `json:"root_id"`
	Name           string `json:"name"`
	Enabled        bool   `json:"enabled"`
	TaskCron       string `json:"task_cron"`
	Agent          string `json:"agent"`
	Model          string `json:"model"`
	Mode           string `json:"mode"`
	Effort         string `json:"effort"`
	FastService    string `json:"fast_service"`
	Prompt         string `json:"prompt"`
	NewSessionCron string `json:"new_session_cron"`
}

func (s *Service) Create(ctx context.Context, in SaveInput) (Task, error) {
	if err := s.validateInput(in); err != nil {
		return Task{}, err
	}
	store, err := s.store(in.RootID)
	if err != nil {
		return Task{}, err
	}
	tasks, err := store.List()
	if err != nil {
		return Task{}, err
	}
	now := time.Now().UTC()
	task := Task{
		ID:             newID(),
		RootID:         strings.TrimSpace(in.RootID),
		Name:           strings.TrimSpace(in.Name),
		Enabled:        in.Enabled,
		TaskCron:       strings.TrimSpace(in.TaskCron),
		Agent:          strings.TrimSpace(in.Agent),
		Model:          strings.TrimSpace(in.Model),
		Mode:           strings.TrimSpace(in.Mode),
		Effort:         strings.TrimSpace(in.Effort),
		FastService:    strings.TrimSpace(in.FastService),
		Prompt:         strings.TrimSpace(in.Prompt),
		NewSessionCron: strings.TrimSpace(in.NewSessionCron),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	tasks = append(tasks, task)
	if err := store.Save(tasks); err != nil {
		return Task{}, err
	}
	if err := s.ReloadRoot(task.RootID); err != nil {
		return Task{}, err
	}
	s.decorateTask(&task)
	return task, nil
}

func (s *Service) Update(ctx context.Context, in SaveInput) (Task, error) {
	if strings.TrimSpace(in.ID) == "" {
		return Task{}, errors.New("task id required")
	}
	if err := s.validateInput(in); err != nil {
		return Task{}, err
	}
	store, err := s.store(in.RootID)
	if err != nil {
		return Task{}, err
	}
	tasks, err := store.List()
	if err != nil {
		return Task{}, err
	}
	for i := range tasks {
		if tasks[i].ID != strings.TrimSpace(in.ID) {
			continue
		}
		tasks[i].Name = strings.TrimSpace(in.Name)
		tasks[i].Enabled = in.Enabled
		tasks[i].TaskCron = strings.TrimSpace(in.TaskCron)
		tasks[i].Agent = strings.TrimSpace(in.Agent)
		tasks[i].Model = strings.TrimSpace(in.Model)
		tasks[i].Mode = strings.TrimSpace(in.Mode)
		tasks[i].Effort = strings.TrimSpace(in.Effort)
		tasks[i].FastService = strings.TrimSpace(in.FastService)
		tasks[i].Prompt = strings.TrimSpace(in.Prompt)
		tasks[i].NewSessionCron = strings.TrimSpace(in.NewSessionCron)
		tasks[i].UpdatedAt = time.Now().UTC()
		if err := store.Save(tasks); err != nil {
			return Task{}, err
		}
		if err := s.ReloadRoot(in.RootID); err != nil {
			return Task{}, err
		}
		task := tasks[i]
		s.decorateTask(&task)
		return task, nil
	}
	return Task{}, errors.New("task not found")
}

func (s *Service) Delete(ctx context.Context, rootID, id string) error {
	store, err := s.store(rootID)
	if err != nil {
		return err
	}
	tasks, err := store.List()
	if err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	next := tasks[:0]
	found := false
	for _, task := range tasks {
		if task.ID == id {
			found = true
			continue
		}
		next = append(next, task)
	}
	if !found {
		return errors.New("task not found")
	}
	if err := store.Save(next); err != nil {
		return err
	}
	return s.ReloadRoot(rootID)
}

func (s *Service) RunNow(ctx context.Context, rootID, id string) (Task, error) {
	task, err := s.findTask(rootID, id)
	if err != nil {
		return Task{}, err
	}
	if err := s.runTask(ctx, task, true); err != nil {
		task.LastError = err.Error()
	}
	updated, err := s.findTask(rootID, id)
	if err != nil {
		return Task{}, err
	}
	s.decorateTask(&updated)
	return updated, nil
}

func (s *Service) ReloadRoot(rootID string) error {
	rootID = strings.TrimSpace(rootID)
	if rootID == "" {
		return errors.New("root id required")
	}
	tasks, err := s.List(context.Background(), rootID)
	if err != nil {
		return err
	}
	s.mu.Lock()
	for _, id := range s.entries[rootID] {
		s.cron.Remove(id)
	}
	delete(s.entries, rootID)
	s.mu.Unlock()
	for _, task := range tasks {
		task := task
		if !task.Enabled {
			continue
		}
		entryID, err := s.cron.AddFunc(task.TaskCron, func() {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := s.runTask(ctx, task, false); err != nil {
				log.Printf("[scheduled-agent] run.error root=%s task=%s err=%v", task.RootID, task.ID, err)
			}
		})
		if err != nil {
			return err
		}
		s.mu.Lock()
		s.entries[rootID] = append(s.entries[rootID], entryID)
		s.mu.Unlock()
	}
	return nil
}

func (s *Service) RemoveRoot(rootID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range s.entries[strings.TrimSpace(rootID)] {
		s.cron.Remove(id)
	}
	delete(s.entries, strings.TrimSpace(rootID))
}

func (s *Service) store(rootID string) (*Store, error) {
	if s == nil || s.registry == nil {
		return nil, errors.New("scheduled service not configured")
	}
	root, err := s.registry.GetRoot(strings.TrimSpace(rootID))
	if err != nil {
		return nil, err
	}
	return NewStore(root), nil
}

func (s *Service) validateInput(in SaveInput) error {
	if strings.TrimSpace(in.RootID) == "" {
		return errors.New("root id required")
	}
	if strings.TrimSpace(in.Name) == "" {
		return errors.New("task name required")
	}
	if strings.TrimSpace(in.TaskCron) == "" {
		return errors.New("task crontab required")
	}
	if _, err := s.parser.Parse(strings.TrimSpace(in.TaskCron)); err != nil {
		return fmt.Errorf("invalid task crontab: %w", err)
	}
	if strings.TrimSpace(in.NewSessionCron) != "" {
		if _, err := s.parser.Parse(strings.TrimSpace(in.NewSessionCron)); err != nil {
			return fmt.Errorf("invalid new session crontab: %w", err)
		}
	}
	if strings.TrimSpace(in.Agent) == "" {
		return errors.New("agent required")
	}
	if strings.TrimSpace(in.Prompt) == "" {
		return errors.New("prompt required")
	}
	return nil
}

func (s *Service) findTask(rootID, id string) (Task, error) {
	store, err := s.store(rootID)
	if err != nil {
		return Task{}, err
	}
	tasks, err := store.List()
	if err != nil {
		return Task{}, err
	}
	id = strings.TrimSpace(id)
	for _, task := range tasks {
		if task.ID == id {
			return task, nil
		}
	}
	return Task{}, errors.New("task not found")
}

func (s *Service) runTask(ctx context.Context, task Task, force bool) error {
	runKey := task.RootID + ":" + task.ID
	s.mu.Lock()
	if s.running[runKey] {
		s.mu.Unlock()
		_ = s.updateTask(task.RootID, task.ID, func(t *Task) {
			now := time.Now().UTC()
			t.LastRunAt = &now
			t.LastError = "previous run still active"
			t.UpdatedAt = now
		})
		return errors.New("previous run still active")
	}
	s.running[runKey] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.running, runKey)
		s.mu.Unlock()
	}()

	current, err := s.findTask(task.RootID, task.ID)
	if err != nil {
		return err
	}
	if !force && !current.Enabled {
		return nil
	}
	broadcaster := s.broadcaster
	if broadcaster == nil {
		err := errors.New("session activity broadcaster not configured")
		_ = s.recordRunError(current, err)
		return err
	}
	manager, err := s.registry.GetSessionManager(current.RootID)
	if err != nil {
		_ = s.recordRunError(current, err)
		broadcaster.BroadcastScheduledTaskFailed(current.RootID, current.ID, current.Name, "", err.Error())
		return err
	}
	sessionKey := strings.TrimSpace(current.SessionKey)
	if sessionKey != "" {
		if _, err := manager.Get(ctx, sessionKey, 0); err != nil {
			sessionKey = ""
		}
	}
	if sessionKey == "" || s.shouldCreateNewSession(current, time.Now().UTC()) {
		created, err := s.usecase.CreateSession(ctx, usecase.CreateSessionInput{
			RootID: current.RootID,
			Input: session.CreateInput{
				Type:  session.TypeChat,
				Agent: current.Agent,
				Model: current.Model,
				Name:  current.Name,
			},
		})
		if err != nil {
			_ = s.recordRunError(current, err)
			broadcaster.BroadcastScheduledTaskFailed(current.RootID, current.ID, current.Name, "", err.Error())
			return err
		}
		broadcaster.BroadcastSessionMetaUpdated(current.RootID, created)
		sessionKey = created.Key
		resetAt := time.Now().UTC()
		current.SessionKey = sessionKey
		current.LastSessionResetAt = &resetAt
		if err := s.updateTask(current.RootID, current.ID, func(t *Task) {
			t.SessionKey = sessionKey
			t.LastSessionResetAt = &resetAt
			t.UpdatedAt = resetAt
		}); err != nil {
			return err
		}
	}
	sessionName := current.Name
	err = s.usecase.SendMessage(ctx, usecase.SendMessageInput{
		RootID:      current.RootID,
		Key:         sessionKey,
		Agent:       current.Agent,
		Model:       current.Model,
		Mode:        current.Mode,
		Effort:      current.Effort,
		FastService: current.FastService,
		Content:     current.Prompt,
		ClientCtx: usecase.ClientContext{
			CurrentRoot: current.RootID,
		},
		OnStart: func() {
			broadcaster.BroadcastSessionUserMessage(current.RootID, sessionKey, session.TypeChat, sessionName, current.Agent, current.Model, current.Mode, current.Effort, current.FastService, current.Prompt)
		},
		OnUpdate: func(update agenttypes.Event) {
			broadcaster.BroadcastSessionUpdate(current.RootID, sessionKey, update)
		},
		OnSubSessionCreated: func(created *session.Session) {
			broadcaster.BroadcastSessionMetaUpdated(current.RootID, created)
			if created != nil {
				broadcaster.SetSessionPendingReply(current.RootID, created.Key, created.Name)
			}
		},
		OnSubSessionUpdate: func(sessionKey string, update agenttypes.Event) {
			broadcaster.BroadcastSessionUpdate(current.RootID, sessionKey, update)
			if update.Type == agenttypes.EventTypeMessageDone {
				broadcaster.BroadcastSessionDone(current.RootID, sessionKey, "")
			}
		},
	})
	now := time.Now().UTC()
	if err != nil {
		broadcaster.BroadcastSessionError(current.RootID, sessionKey, err.Error())
		broadcaster.BroadcastSessionDone(current.RootID, sessionKey, "scheduled:"+current.ID)
		broadcaster.BroadcastScheduledTaskFailed(current.RootID, current.ID, current.Name, sessionKey, err.Error())
		_ = s.updateTask(current.RootID, current.ID, func(t *Task) {
			t.LastRunAt = &now
			t.LastError = err.Error()
			t.UpdatedAt = now
		})
		return err
	}
	broadcaster.BroadcastSessionDone(current.RootID, sessionKey, "scheduled:"+current.ID)
	broadcaster.BroadcastScheduledTaskDone(current.RootID, current.ID, current.Name, sessionKey, "")
	return s.updateTask(current.RootID, current.ID, func(t *Task) {
		t.SessionKey = sessionKey
		t.LastRunAt = &now
		t.LastSuccessAt = &now
		t.LastError = ""
		t.UpdatedAt = now
	})
}

func (s *Service) recordRunError(task Task, err error) error {
	now := time.Now().UTC()
	return s.updateTask(task.RootID, task.ID, func(t *Task) {
		t.LastRunAt = &now
		t.LastError = err.Error()
		t.UpdatedAt = now
	})
}

func (s *Service) updateTask(rootID, id string, update func(*Task)) error {
	store, err := s.store(rootID)
	if err != nil {
		return err
	}
	tasks, err := store.List()
	if err != nil {
		return err
	}
	for i := range tasks {
		if tasks[i].ID != id {
			continue
		}
		update(&tasks[i])
		return store.Save(tasks)
	}
	return errors.New("task not found")
}

func (s *Service) shouldCreateNewSession(task Task, now time.Time) bool {
	if strings.TrimSpace(task.NewSessionCron) == "" {
		return false
	}
	schedule, err := s.parser.Parse(strings.TrimSpace(task.NewSessionCron))
	if err != nil {
		return false
	}
	if task.LastSessionResetAt == nil || task.LastSessionResetAt.IsZero() {
		return true
	}
	next := schedule.Next(task.LastSessionResetAt.UTC())
	return !next.After(now)
}

func (s *Service) decorateTask(task *Task) {
	if task == nil {
		return
	}
	if schedule, err := s.parser.Parse(strings.TrimSpace(task.TaskCron)); err == nil {
		next := schedule.Next(time.Now())
		task.NextRunAt = &next
	}
	if strings.TrimSpace(task.NewSessionCron) != "" {
		if schedule, err := s.parser.Parse(strings.TrimSpace(task.NewSessionCron)); err == nil {
			base := time.Now()
			if task.LastSessionResetAt != nil && !task.LastSessionResetAt.IsZero() {
				base = task.LastSessionResetAt.UTC()
			}
			next := schedule.Next(base)
			task.NextNewSessionAt = &next
		}
	}
	s.mu.Lock()
	task.Running = s.running[task.RootID+":"+task.ID]
	s.mu.Unlock()
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
