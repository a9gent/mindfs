package usecase

import (
	"errors"

	"mindfs/server/internal/agent"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

type Registry interface {
	GetRoot(rootID string) (fs.RootInfo, error)
	GetSessionManager(rootID string) (*session.Manager, error)
	UpsertRoot(path string) (fs.RootInfo, error)
	ListRoots() []fs.RootInfo
	GetAgentPool() *agent.Pool
	GetProber() *agent.Prober
	GetFileWatcher(rootID string, manager *session.Manager) (*fs.SharedFileWatcher, error)
	ReleaseFileWatcher(rootID, sessionKey string)
}

type Service struct {
	Registry Registry
}

func (s *Service) ensureRegistry() error {
	if s == nil || s.Registry == nil {
		return errors.New("services not configured")
	}
	return nil
}
