package fs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const homeMetaIdentityFile = ".mindfs-project.json"

type homeMetaIdentity struct {
	RootPath string `json:"root_path"`
}

func NormalizeMetaLocation(value string) (string, error) {
	switch strings.TrimSpace(value) {
	case "", MetaLocationProject:
		return MetaLocationProject, nil
	case MetaLocationHome:
		return MetaLocationHome, nil
	default:
		return "", errors.New("invalid metadata location")
	}
}

func canonicalProjectPath(path string) (string, error) {
	abs, err := filepath.Abs(filepath.Clean(strings.TrimSpace(path)))
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

func sameProjectIdentityPath(left, right string) bool {
	a, errA := canonicalProjectPath(left)
	b, errB := canonicalProjectPath(right)
	if errA != nil || errB != nil {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func (r RootInfo) ensureHomeMetaIdentity() error {
	if r.effectiveMetaLocation() != MetaLocationHome {
		return nil
	}
	metaDir := r.MetaDir()
	if metaDir == "" {
		return errors.New("metadata directory required")
	}
	identityPath := filepath.Join(metaDir, homeMetaIdentityFile)
	payload, err := os.ReadFile(identityPath)
	if err == nil {
		var identity homeMetaIdentity
		if json.Unmarshal(payload, &identity) != nil || !sameProjectIdentityPath(identity.RootPath, r.RootPath) {
			return fmt.Errorf("metadata directory %s belongs to another project", metaDir)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	entries, readErr := os.ReadDir(metaDir)
	if readErr != nil {
		return readErr
	}
	if len(entries) != 0 {
		return fmt.Errorf("metadata directory %s has no valid project identity", metaDir)
	}
	canonical, err := canonicalProjectPath(r.RootPath)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(homeMetaIdentity{RootPath: canonical}, "", "  ")
	if err != nil {
		return err
	}
	identityFile, err := os.OpenFile(identityPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			payload, readErr := os.ReadFile(identityPath)
			var identity homeMetaIdentity
			if readErr == nil && json.Unmarshal(payload, &identity) == nil && sameProjectIdentityPath(identity.RootPath, r.RootPath) {
				return nil
			}
		}
		return err
	}
	if _, err = identityFile.Write(append(b, '\n')); err == nil {
		err = identityFile.Chmod(0o600)
	}
	if closeErr := identityFile.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(identityPath)
		return err
	}
	return nil
}

// MetaLocationForNewRoot applies the add-time precedence rule: an existing
// project-local .mindfs directory always wins over the user's default.
func MetaLocationForNewRoot(rootPath, preferred string) (string, error) {
	preferred, err := NormalizeMetaLocation(preferred)
	if err != nil {
		return "", err
	}
	local := filepath.Join(filepath.Clean(rootPath), metaDirName)
	_, lstatErr := os.Lstat(local)
	if lstatErr == nil {
		info, statErr := os.Stat(local)
		if statErr != nil {
			return "", statErr
		}
		if !info.IsDir() {
			return "", errors.New("project .mindfs path is not a directory")
		}
		return MetaLocationProject, nil
	}
	if !os.IsNotExist(lstatErr) {
		return "", lstatErr
	}
	rootID := filepath.Base(filepath.Clean(rootPath))
	homeDir, homeErr := homeMetaDir(rootID)
	if homeErr != nil {
		if preferred == MetaLocationHome {
			return "", homeErr
		}
		return preferred, nil
	}
	identityPayload, identityErr := os.ReadFile(filepath.Join(homeDir, homeMetaIdentityFile))
	if identityErr == nil {
		var identity homeMetaIdentity
		if json.Unmarshal(identityPayload, &identity) == nil && sameProjectIdentityPath(identity.RootPath, rootPath) {
			return MetaLocationHome, nil
		}
	}
	return preferred, nil
}

func renameHomeMeta(old RootInfo, nextID, nextRootPath string) (func(), error) {
	if old.effectiveMetaLocation() != MetaLocationHome {
		return func() {}, nil
	}
	if err := old.ensureHomeMetaIdentity(); err != nil {
		return nil, err
	}
	oldDir := old.MetaDir()
	next := old
	next.ID = nextID
	next.Name = nextID
	next.RootPath = nextRootPath
	nextDir := next.MetaDir()
	if oldDir != nextDir {
		if _, err := os.Stat(nextDir); err == nil {
			return nil, fmt.Errorf("metadata directory already exists: %s", nextDir)
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(nextDir), 0o700); err != nil {
			return nil, err
		}
		if err := os.Rename(oldDir, nextDir); err != nil {
			return nil, err
		}
	}
	identityPath := filepath.Join(nextDir, homeMetaIdentityFile)
	previous, err := os.ReadFile(identityPath)
	if err != nil {
		if oldDir != nextDir {
			_ = os.Rename(nextDir, oldDir)
		}
		return nil, err
	}
	canonical, err := canonicalProjectPath(nextRootPath)
	if err == nil {
		var b []byte
		b, err = json.MarshalIndent(homeMetaIdentity{RootPath: canonical}, "", "  ")
		if err == nil {
			err = os.WriteFile(identityPath, append(b, '\n'), 0o600)
		}
	}
	if err != nil {
		if oldDir != nextDir {
			_ = os.Rename(nextDir, oldDir)
		}
		return nil, err
	}
	return func() {
		_ = os.WriteFile(identityPath, previous, 0o600)
		if oldDir != nextDir {
			_ = os.Rename(nextDir, oldDir)
		}
	}, nil
}
