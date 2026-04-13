package githubimport

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/fs"
)

type RootRegistrar interface {
	UpsertRoot(path string) (fs.RootInfo, error)
}

type Status struct {
	TaskID     string    `json:"task_id"`
	URL        string    `json:"url"`
	Status     string    `json:"status"`
	Progress   int       `json:"progress"`
	Message    string    `json:"message"`
	TargetPath string    `json:"target_path,omitempty"`
	RootID     string    `json:"root_id,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type StartInput struct {
	URL        string
	ParentPath string
}

type Service struct {
	registrar RootRegistrar

	mu        sync.RWMutex
	statuses  map[string]Status
	listeners []func(Status)
}

func NewService(registrar RootRegistrar) (*Service, error) {
	if registrar == nil {
		return nil, errors.New("root registrar required")
	}
	return &Service{
		registrar: registrar,
		statuses:  make(map[string]Status),
	}, nil
}

func (s *Service) AddListener(listener func(Status)) {
	if s == nil || listener == nil {
		return
	}
	s.mu.Lock()
	s.listeners = append(s.listeners, listener)
	s.mu.Unlock()
}

func (s *Service) ActiveStatuses() []Status {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Status, 0, len(s.statuses))
	for _, status := range s.statuses {
		if status.Status == "done" || status.Status == "failed" {
			continue
		}
		out = append(out, status)
	}
	return out
}

func (s *Service) Start(ctx context.Context, in StartInput) (Status, error) {
	if s == nil {
		return Status{}, errors.New("github import service not configured")
	}
	repoURL := strings.TrimSpace(in.URL)
	if repoURL == "" {
		return Status{}, errors.New("url required")
	}
	parentPath := strings.TrimSpace(in.ParentPath)
	if parentPath == "" {
		return Status{}, errors.New("parent_path required")
	}
	if !filepath.IsAbs(parentPath) {
		return Status{}, errors.New("parent_path must be absolute")
	}
	parentPath = filepath.Clean(parentPath)
	info, err := os.Stat(parentPath)
	if err != nil {
		return Status{}, err
	}
	if !info.IsDir() {
		return Status{}, errors.New("parent_path must be a directory")
	}
	_, repo, normalizedURL, err := parseGitHubRepoURL(repoURL)
	if err != nil {
		return Status{}, err
	}
	targetPath := filepath.Join(parentPath, sanitizeName(repo))
	if _, err := os.Stat(targetPath); err == nil {
		return Status{}, errors.New("target directory already exists")
	} else if !os.IsNotExist(err) {
		return Status{}, err
	}
	taskID := newTaskID()
	now := time.Now().UTC()
	status := Status{
		TaskID:    taskID,
		URL:       normalizedURL,
		Status:    "pending",
		Progress:  0,
		Message:   "pending import",
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.setStatus(status)
	go s.run(context.WithoutCancel(ctx), status, parentPath)
	return status, nil
}

func (s *Service) run(ctx context.Context, status Status, parentPath string) {
	owner, repo, normalizedURL, err := parseGitHubRepoURL(status.URL)
	if err != nil {
		log.Printf("[github_import] validate.failed task_id=%s url=%s err=%v", status.TaskID, status.URL, err)
		s.fail(status.TaskID, status.URL, "", err)
		return
	}
	targetPath := filepath.Join(parentPath, sanitizeName(repo))
	s.updateStatus(status.TaskID, func(st *Status) {
		st.URL = normalizedURL
		st.Status = "validating"
		st.Progress = 10
		st.Message = "validating repository"
		st.TargetPath = targetPath
	})

	if _, err := os.Stat(targetPath); err == nil {
		s.fail(status.TaskID, normalizedURL, targetPath, fmt.Errorf("target directory already exists"))
		return
	} else if !os.IsNotExist(err) {
		s.fail(status.TaskID, normalizedURL, targetPath, err)
		return
	}

	s.updateStatus(status.TaskID, func(st *Status) {
		st.Status = "cloning"
		st.Progress = 60
		st.Message = "cloning repository"
	})
	log.Printf("[github_import] clone.start task_id=%s url=%s owner=%s target=%s", status.TaskID, normalizedURL, owner, targetPath)
	if err := cloneRepository(ctx, normalizedURL, targetPath); err != nil {
		log.Printf("[github_import] clone.failed task_id=%s url=%s target=%s err=%v", status.TaskID, normalizedURL, targetPath, err)
		_ = os.RemoveAll(targetPath)
		s.fail(status.TaskID, normalizedURL, targetPath, err)
		return
	}

	s.updateStatus(status.TaskID, func(st *Status) {
		st.Status = "registering"
		st.Progress = 90
		st.Message = "registering root"
	})
	root, err := s.registrar.UpsertRoot(targetPath)
	if err != nil {
		log.Printf("[github_import] register.failed task_id=%s url=%s target=%s err=%v", status.TaskID, normalizedURL, targetPath, err)
		s.fail(status.TaskID, normalizedURL, targetPath, err)
		return
	}

	s.updateStatus(status.TaskID, func(st *Status) {
		st.Status = "done"
		st.Progress = 100
		st.Message = "import completed"
		st.RootID = root.ID
	})
	log.Printf("[github_import] done task_id=%s url=%s target=%s root_id=%s", status.TaskID, normalizedURL, targetPath, root.ID)
}

func (s *Service) fail(taskID, repoURL, targetPath string, err error) {
	s.updateStatus(taskID, func(st *Status) {
		st.URL = repoURL
		st.TargetPath = targetPath
		st.Status = "failed"
		st.Progress = 100
		st.Message = err.Error()
	})
}

func (s *Service) updateStatus(taskID string, update func(*Status)) {
	s.mu.Lock()
	status, ok := s.statuses[taskID]
	if !ok {
		s.mu.Unlock()
		return
	}
	update(&status)
	status.UpdatedAt = time.Now().UTC()
	s.statuses[taskID] = status
	listeners := append([]func(Status){}, s.listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(status)
	}
}

func (s *Service) setStatus(status Status) {
	s.mu.Lock()
	s.statuses[status.TaskID] = status
	listeners := append([]func(Status){}, s.listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(status)
	}
}

func cloneRepository(ctx context.Context, repoURL, targetPath string) error {
	cmd := exec.CommandContext(ctx, "git", "clone", "--depth=1", repoURL, targetPath)
	var stderr bytes.Buffer
	cmd.Stdout = ioDiscard{}
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			return err
		}
		return fmt.Errorf("%s", message)
	}
	return nil
}

func parseGitHubRepoURL(raw string) (owner string, repo string, normalized string, err error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", "", "", err
	}
	if !strings.EqualFold(parsed.Host, "github.com") {
		return "", "", "", errors.New("only github.com repositories are supported")
	}
	segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(segments) < 2 {
		return "", "", "", errors.New("invalid github repository url")
	}
	owner = strings.TrimSpace(segments[0])
	repo = strings.TrimSuffix(strings.TrimSpace(segments[1]), ".git")
	if owner == "" || repo == "" {
		return "", "", "", errors.New("invalid github repository url")
	}
	parsed.Path = "/" + owner + "/" + repo
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	parsed.Scheme = "https"
	return owner, repo, parsed.String(), nil
}

func sanitizeName(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "repo"
	}
	replacer := strings.NewReplacer("/", "-", "\\", "-", ":", "-", " ", "-")
	result := replacer.Replace(trimmed)
	if runtime.GOOS == "windows" {
		result = strings.ToLower(result)
	}
	return result
}

func newTaskID() string {
	return fmt.Sprintf("ghimp_%d", time.Now().UTC().UnixNano())
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) {
	return len(p), nil
}
