package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/fs"
	"mindfs/server/internal/gitview"
)

type ListGitBranchesInput struct {
	RootID string
}

type ListGitBranchesOutput struct {
	Current  string               `json:"current,omitempty"`
	Branches []gitview.BranchItem `json:"branches"`
}

func (s *Service) ListGitBranches(ctx context.Context, in ListGitBranchesInput) (ListGitBranchesOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListGitBranchesOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ListGitBranchesOutput{}, err
	}
	result, err := gitview.ListBranches(ctx, root.RootPath)
	if err != nil {
		return ListGitBranchesOutput{}, err
	}
	return ListGitBranchesOutput{Current: result.Current, Branches: result.Branches}, nil
}

type CheckoutGitBranchInput struct {
	RootID string
	Branch string
}

type CheckoutGitBranchOutput struct {
	Status gitview.StatusResult `json:"status"`
}

func (s *Service) CheckoutGitBranch(ctx context.Context, in CheckoutGitBranchInput) (CheckoutGitBranchOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return CheckoutGitBranchOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return CheckoutGitBranchOutput{}, err
	}
	branch := strings.TrimSpace(in.Branch)
	if branch == "" {
		return CheckoutGitBranchOutput{}, errors.New("branch required")
	}
	if err := gitview.CheckoutBranch(ctx, root.RootPath, branch); err != nil {
		return CheckoutGitBranchOutput{}, err
	}
	status, err := gitview.InspectStatus(ctx, root.RootPath)
	if err != nil {
		return CheckoutGitBranchOutput{}, err
	}
	return CheckoutGitBranchOutput{Status: status}, nil
}

type GitActionInput struct {
	RootID  string
	Path    string
	Status  string
	Message string
}

type GitActionOutput struct {
	Output string               `json:"output"`
	Status gitview.StatusResult `json:"status"`
}

func (s *Service) GitPull(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.Pull(ctx, root.RootPath)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) GitPush(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.Push(ctx, root.RootPath)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) GitCommit(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.Commit(ctx, root.RootPath, in.Message)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) GitStagePath(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.StagePath(ctx, root.RootPath, in.Path)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) GitUnstagePath(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.UnstagePath(ctx, root.RootPath, in.Path)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) GitDiscardPath(ctx context.Context, in GitActionInput) (GitActionOutput, error) {
	root, err := s.gitActionRoot(in.RootID)
	if err != nil {
		return GitActionOutput{}, err
	}
	result, err := gitview.DiscardPath(ctx, root.RootPath, in.Path, in.Status)
	if err != nil {
		return GitActionOutput{}, err
	}
	return GitActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) gitActionRoot(rootID string) (fs.RootInfo, error) {
	if err := s.ensureRegistry(); err != nil {
		return fs.RootInfo{}, err
	}
	root, err := s.Registry.GetRoot(rootID)
	if err != nil {
		return fs.RootInfo{}, err
	}
	return root, nil
}

type ListGitWorktreesInput struct {
	RootID string
}

type ListGitWorktreesOutput struct {
	Items []gitview.WorktreeItem `json:"items"`
}

func (s *Service) ListGitWorktrees(ctx context.Context, in ListGitWorktreesInput) (ListGitWorktreesOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return ListGitWorktreesOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return ListGitWorktreesOutput{}, err
	}
	result, err := gitview.ListWorktrees(ctx, root.RootPath)
	if err != nil {
		return ListGitWorktreesOutput{}, err
	}
	return ListGitWorktreesOutput{Items: result.Items}, nil
}

type CreateGitWorktreeInput struct {
	RootID     string
	ParentPath string
	Name       string
	BranchMode string
	Branch     string
}

type CreateGitWorktreeOutput struct {
	Dir fs.RootInfo
}

func (s *Service) CreateGitWorktree(ctx context.Context, in CreateGitWorktreeInput) (CreateGitWorktreeOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	name, err := cleanWorktreeName(in.Name)
	if err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	parentPath := strings.TrimSpace(in.ParentPath)
	if parentPath == "" {
		return CreateGitWorktreeOutput{}, errors.New("parent_path required")
	}
	if !filepath.IsAbs(parentPath) {
		return CreateGitWorktreeOutput{}, errors.New("parent_path must be absolute")
	}
	parentPath = filepath.Clean(parentPath)
	info, err := os.Stat(parentPath)
	if err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	if !info.IsDir() {
		return CreateGitWorktreeOutput{}, errors.New("parent_path must be a directory")
	}
	targetPath := filepath.Join(parentPath, name)
	if _, err := os.Stat(targetPath); err == nil {
		return CreateGitWorktreeOutput{}, errors.New("worktree path already exists")
	} else if !os.IsNotExist(err) {
		return CreateGitWorktreeOutput{}, err
	}
	for _, existing := range s.Registry.ListRoots() {
		if filepath.Clean(existing.RootPath) == filepath.Clean(targetPath) {
			return CreateGitWorktreeOutput{}, errors.New("root already exists")
		}
	}

	branchMode := strings.TrimSpace(in.BranchMode)
	if branchMode == "" {
		branchMode = "new"
	}
	if branchMode != "new" && branchMode != "existing" {
		return CreateGitWorktreeOutput{}, errors.New("invalid branch_mode")
	}
	branch := strings.TrimSpace(in.Branch)
	if branchMode == "new" {
		branch = name
	} else if branch == "" {
		return CreateGitWorktreeOutput{}, errors.New("branch required")
	}

	if err := gitview.AddWorktree(ctx, root.RootPath, targetPath, branchMode, branch); err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	if _, err := fs.NewRootInfo(name, name, targetPath).EnsureMetaDir(); err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	dir, err := s.Registry.UpsertRoot(targetPath)
	if err != nil {
		return CreateGitWorktreeOutput{}, err
	}
	return CreateGitWorktreeOutput{Dir: dir}, nil
}

type RemoveGitWorktreeInput struct {
	RootID string
}

type RemoveGitWorktreeOutput struct {
	Dir fs.RootInfo
}

func (s *Service) RemoveGitWorktree(ctx context.Context, in RemoveGitWorktreeInput) (RemoveGitWorktreeOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return RemoveGitWorktreeOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return RemoveGitWorktreeOutput{}, err
	}
	if err := gitview.RemoveWorktree(ctx, root.RootPath); err != nil {
		return RemoveGitWorktreeOutput{}, err
	}
	dir, err := s.Registry.RemoveRoot(filepath.Clean(root.RootPath))
	if err != nil {
		return RemoveGitWorktreeOutput{}, err
	}
	return RemoveGitWorktreeOutput{Dir: dir}, nil
}

func cleanWorktreeName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", errors.New("worktree name required")
	}
	if name == "." || name == ".." {
		return "", errors.New("invalid worktree name")
	}
	if strings.Contains(name, "/") || strings.Contains(name, "\\") {
		return "", errors.New("worktree name must not contain path separators")
	}
	return name, nil
}
