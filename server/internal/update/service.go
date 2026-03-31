package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultCheckInterval = time.Hour

type Status struct {
	CurrentVersion      string    `json:"current_version"`
	LatestVersion       string    `json:"latest_version,omitempty"`
	HasUpdate           bool      `json:"has_update"`
	Status              string    `json:"status"`
	Message             string    `json:"message,omitempty"`
	ReleaseName         string    `json:"release_name,omitempty"`
	ReleaseBody         string    `json:"release_body,omitempty"`
	ReleaseURL          string    `json:"release_url,omitempty"`
	PublishedAt         time.Time `json:"published_at,omitempty"`
	LastCheckedAt       time.Time `json:"last_checked_at,omitempty"`
	AutoUpdateSupported bool      `json:"auto_update_supported"`
}

type Service struct {
	repo          string
	current       string
	executable    string
	args          []string
	checkInterval time.Duration
	client        *http.Client

	mu        sync.RWMutex
	status    Status
	listeners []func(Status)
}

type latestRelease struct {
	TagName     string         `json:"tag_name"`
	Name        string         `json:"name"`
	Body        string         `json:"body"`
	HTMLURL     string         `json:"html_url"`
	PublishedAt time.Time      `json:"published_at"`
	Assets      []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

func NewService(repo, currentVersion, executable string, args []string, interval time.Duration) *Service {
	if interval <= 0 {
		interval = defaultCheckInterval
	}
	currentVersion = strings.TrimSpace(currentVersion)
	if currentVersion == "" {
		currentVersion = "dev"
	}
	s := &Service{
		repo:          strings.TrimSpace(repo),
		current:       currentVersion,
		executable:    strings.TrimSpace(executable),
		args:          append([]string(nil), args...),
		checkInterval: interval,
		client: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
	st := Status{
		CurrentVersion:      currentVersion,
		Status:              "idle",
		AutoUpdateSupported: s.canAutoUpdate(),
	}
	if !st.AutoUpdateSupported {
		st.Message = s.unsupportedMessage()
	}
	s.status = st
	return s
}

func (s *Service) Start(ctx context.Context) {
	if s == nil || strings.TrimSpace(s.repo) == "" {
		return
	}
	go func() {
		log.Printf("[update] checker.start repo=%s current=%s interval=%s auto_update_supported=%t", s.repo, s.current, s.checkInterval, s.canAutoUpdate())
		s.CheckNow(context.Background())
		ticker := time.NewTicker(s.checkInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.CheckNow(context.Background())
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *Service) AddListener(listener func(Status)) {
	if s == nil || listener == nil {
		return
	}
	s.mu.Lock()
	s.listeners = append(s.listeners, listener)
	s.mu.Unlock()
}

func (s *Service) GetStatus() Status {
	if s == nil {
		return Status{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

func (s *Service) CheckNow(ctx context.Context) {
	if s == nil || strings.TrimSpace(s.repo) == "" {
		return
	}
	log.Printf("[update] check.begin repo=%s current=%s", s.repo, s.current)
	release, err := s.fetchLatestRelease(ctx)
	if err != nil {
		log.Printf("[update] check.error repo=%s current=%s err=%v", s.repo, s.current, err)
		s.updateStatus(func(st *Status) {
			st.LastCheckedAt = time.Now().UTC()
			if st.Status == "downloading" || st.Status == "installing" || st.Status == "restarting" {
				return
			}
			if st.HasUpdate {
				return
			}
			st.Status = "idle"
			if !st.AutoUpdateSupported {
				st.Message = s.unsupportedMessage()
			}
		})
		return
	}
	latest := normalizeVersion(release.TagName)
	current := normalizeVersion(s.current)
	hasUpdate := isNewerVersion(latest, current)
	log.Printf("[update] check.result repo=%s current=%s latest=%s has_update=%t", s.repo, current, latest, hasUpdate)
	s.updateStatus(func(st *Status) {
		st.CurrentVersion = s.current
		st.LatestVersion = latest
		st.ReleaseName = strings.TrimSpace(release.Name)
		st.ReleaseBody = strings.TrimSpace(release.Body)
		st.ReleaseURL = strings.TrimSpace(release.HTMLURL)
		st.PublishedAt = release.PublishedAt
		st.LastCheckedAt = time.Now().UTC()
		st.HasUpdate = hasUpdate
		st.AutoUpdateSupported = s.canAutoUpdate()
		if !st.AutoUpdateSupported {
			st.Message = s.unsupportedMessage()
		} else if hasUpdate && (st.Status == "" || st.Status == "idle" || st.Status == "available") {
			st.Message = ""
		}
		if st.Status == "downloading" || st.Status == "installing" || st.Status == "restarting" {
			return
		}
		if hasUpdate {
			st.Status = "available"
			return
		}
		st.Status = "idle"
		if st.AutoUpdateSupported {
			st.Message = ""
		}
	})
}

func (s *Service) TriggerUpdate(ctx context.Context) error {
	if s == nil {
		return errors.New("update service not configured")
	}
	st := s.GetStatus()
	if !st.AutoUpdateSupported {
		return errors.New(firstNonEmpty(st.Message, "auto update is not supported in this install mode"))
	}
	if !st.HasUpdate || strings.TrimSpace(st.LatestVersion) == "" {
		return errors.New("no update available")
	}
	if st.Status == "downloading" || st.Status == "installing" || st.Status == "restarting" {
		return errors.New("update already in progress")
	}

	s.updateStatus(func(st *Status) {
		st.Status = "downloading"
		st.Message = "Downloading update..."
	})

	go s.runUpdate(context.WithoutCancel(ctx), st.LatestVersion)
	return nil
}

func (s *Service) runUpdate(ctx context.Context, version string) {
	release, err := s.fetchLatestRelease(ctx)
	if err != nil {
		s.fail(err)
		return
	}
	asset, err := s.pickAsset(release, version)
	if err != nil {
		s.fail(err)
		return
	}

	tmpDir, err := os.MkdirTemp("", "mindfs-update-*")
	if err != nil {
		s.fail(err)
		return
	}
	defer os.RemoveAll(tmpDir)

	archivePath := filepath.Join(tmpDir, asset.Name)
	if err := s.downloadFile(ctx, asset.BrowserDownloadURL, archivePath); err != nil {
		s.fail(err)
		return
	}

	s.updateStatus(func(st *Status) {
		st.Status = "installing"
		st.Message = "Installing update..."
	})

	extractDir := filepath.Join(tmpDir, "extract")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		s.fail(err)
		return
	}
	if err := extractArchive(archivePath, extractDir); err != nil {
		s.fail(err)
		return
	}
	pkgDir, err := findPackageDir(extractDir)
	if err != nil {
		s.fail(err)
		return
	}
	if runtime.GOOS == "windows" {
		s.updateStatus(func(st *Status) {
			st.Status = "restarting"
			st.Message = "Restarting service..."
		})
		if err := s.restartInstalledBinary(pkgDir); err != nil {
			s.fail(err)
		}
		return
	}
	if err := s.installPackage(pkgDir); err != nil {
		s.fail(err)
		return
	}

	s.updateStatus(func(st *Status) {
		st.Status = "restarting"
		st.Message = "Restarting service..."
	})
	if err := s.restartInstalledBinary(""); err != nil {
		s.fail(err)
		return
	}
}

func (s *Service) fail(err error) {
	msg := "update failed"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		msg = err.Error()
	}
	log.Printf("[update] run.error current=%s latest=%s err=%s", s.current, s.GetStatus().LatestVersion, msg)
	s.updateStatus(func(st *Status) {
		st.Status = "failed"
		st.Message = msg
	})
}

func (s *Service) updateStatus(apply func(*Status)) {
	s.mu.Lock()
	st := s.status
	apply(&st)
	s.status = st
	listeners := append([]func(Status){}, s.listeners...)
	s.mu.Unlock()
	for _, listener := range listeners {
		listener(st)
	}
}

func (s *Service) fetchLatestRelease(ctx context.Context) (latestRelease, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", s.repo), nil)
	if err != nil {
		return latestRelease{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "mindfs-update-checker")
	resp, err := s.client.Do(req)
	if err != nil {
		return latestRelease{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return latestRelease{}, fmt.Errorf("release check failed: %s", resp.Status)
	}
	var out latestRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return latestRelease{}, err
	}
	return out, nil
}

func (s *Service) pickAsset(release latestRelease, version string) (releaseAsset, error) {
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	candidates := []string{
		fmt.Sprintf("mindfs_%s_%s_%s%s", version, runtime.GOOS, runtime.GOARCH, ext),
		fmt.Sprintf("mindfs_v%s_%s_%s%s", strings.TrimPrefix(version, "v"), runtime.GOOS, runtime.GOARCH, ext),
	}
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		for _, candidate := range candidates {
			if name == candidate {
				return asset, nil
			}
		}
	}
	return releaseAsset{}, fmt.Errorf(
		"release asset not found for %s/%s (candidates: %s)",
		runtime.GOOS,
		runtime.GOARCH,
		strings.Join(candidates, ", "),
	)
}

func (s *Service) downloadFile(ctx context.Context, url, dst string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "mindfs-updater")
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("download failed: %s", resp.Status)
	}
	file, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(file, resp.Body)
	return err
}

func (s *Service) installPackage(pkgDir string) error {
	prefix, err := s.installPrefix()
	if err != nil {
		return err
	}
	binName := "mindfs"
	if runtime.GOOS == "windows" {
		binName = "mindfs.exe"
	}
	srcBin := filepath.Join(pkgDir, binName)
	if _, err := os.Stat(srcBin); err != nil {
		return fmt.Errorf("updated binary missing: %w", err)
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dstBin := filepath.Join(prefix, "bin", binName)
	if err := os.MkdirAll(filepath.Dir(dstBin), 0o755); err != nil {
		return err
	}
	if err := replaceFile(srcBin, dstBin, 0o755); err != nil {
		return err
	}
	srcWeb := filepath.Join(pkgDir, "web")
	if info, err := os.Stat(srcWeb); err == nil && info.IsDir() {
		dstWeb := filepath.Join(prefix, "share", "mindfs", "web")
		if err := os.RemoveAll(dstWeb); err != nil {
			return err
		}
		if err := copyDir(srcWeb, dstWeb); err != nil {
			return err
		}
	}
	srcAgents := filepath.Join(pkgDir, "agents.json")
	if info, err := os.Stat(srcAgents); err == nil && !info.IsDir() {
		dstAgents := filepath.Join(prefix, "share", "mindfs", "agents.json")
		if err := os.MkdirAll(filepath.Dir(dstAgents), 0o755); err != nil {
			return err
		}
		if err := replaceFile(srcAgents, dstAgents, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) restartInstalledBinary(pkgDir string) error {
	exe := s.executable
	if strings.TrimSpace(exe) == "" {
		return errors.New("current executable path unavailable")
	}
	prefix, err := s.installPrefix()
	if err != nil {
		return err
	}
	log.Printf("[update] restart.begin exe=%s args=%q", exe, s.args)
	if err := startReplacementProcess(os.Getpid(), exe, s.args, os.Stdout, os.Stderr, pkgDir, prefix); err != nil {
		return err
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		os.Exit(0)
	}()
	return nil
}

func (s *Service) canAutoUpdate() bool {
	if strings.TrimSpace(s.executable) == "" {
		return false
	}
	base := strings.ToLower(filepath.Base(s.executable))
	if base != "mindfs" && base != "mindfs.exe" {
		return false
	}
	_, err := s.installPrefix()
	return err == nil
}

func (s *Service) unsupportedMessage() string {
	base := strings.ToLower(filepath.Base(s.executable))
	if base != "mindfs" && base != "mindfs.exe" {
		return "Auto update is only available for installed mindfs release binaries."
	}
	return "Auto update is unavailable for the current install path."
}

func (s *Service) installPrefix() (string, error) {
	exe := strings.TrimSpace(s.executable)
	if exe == "" {
		return "", errors.New("executable path required")
	}
	binDir := filepath.Dir(exe)
	if strings.ToLower(filepath.Base(binDir)) != "bin" {
		return "", errors.New("unsupported executable layout")
	}
	return filepath.Dir(binDir), nil
}

func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	return v
}

func isNewerVersion(latest, current string) bool {
	latestParts, latestOK := parseVersionParts(latest)
	if !latestOK {
		return false
	}
	currentParts, currentOK := parseVersionParts(current)
	if !currentOK {
		return true
	}
	maxLen := len(latestParts)
	if len(currentParts) > maxLen {
		maxLen = len(currentParts)
	}
	for i := 0; i < maxLen; i++ {
		var latestPart, currentPart int
		if i < len(latestParts) {
			latestPart = latestParts[i]
		}
		if i < len(currentParts) {
			currentPart = currentParts[i]
		}
		if latestPart > currentPart {
			return true
		}
		if latestPart < currentPart {
			return false
		}
	}
	return false
}

func parseVersionParts(v string) ([]int, bool) {
	v = normalizeVersion(v)
	if v == "" {
		return nil, false
	}
	end := 0
	for end < len(v) {
		ch := v[end]
		if (ch >= '0' && ch <= '9') || ch == '.' {
			end++
			continue
		}
		break
	}
	if end == 0 {
		return nil, false
	}
	core := strings.Trim(v[:end], ".")
	if core == "" {
		return nil, false
	}
	segments := strings.Split(core, ".")
	parts := make([]int, 0, len(segments))
	for _, segment := range segments {
		if segment == "" {
			return nil, false
		}
		value, err := strconv.Atoi(segment)
		if err != nil {
			return nil, false
		}
		parts = append(parts, value)
	}
	return parts, len(parts) > 0
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func extractArchive(archivePath, dst string) error {
	switch {
	case strings.HasSuffix(archivePath, ".tar.gz"):
		return extractTarGz(archivePath, dst)
	case strings.HasSuffix(archivePath, ".zip"):
		return extractZip(archivePath, dst)
	default:
		return fmt.Errorf("unsupported archive format: %s", filepath.Base(archivePath))
	}
}

func extractTarGz(path, dst string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	gzr, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzr.Close()
	tr := tar.NewReader(gzr)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(dst, header.Name)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			file, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(header.Mode))
			if err != nil {
				return err
			}
			if _, err := io.Copy(file, tr); err != nil {
				file.Close()
				return err
			}
			if err := file.Close(); err != nil {
				return err
			}
		}
	}
}

func extractZip(path, dst string) error {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer reader.Close()
	for _, file := range reader.File {
		target := filepath.Join(dst, file.Name)
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		src, err := file.Open()
		if err != nil {
			return err
		}
		dstFile, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, file.Mode())
		if err != nil {
			src.Close()
			return err
		}
		if _, err := io.Copy(dstFile, src); err != nil {
			dstFile.Close()
			src.Close()
			return err
		}
		if err := dstFile.Close(); err != nil {
			src.Close()
			return err
		}
		if err := src.Close(); err != nil {
			return err
		}
	}
	return nil
}

func findPackageDir(root string) (string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "mindfs_") {
			return filepath.Join(root, entry.Name()), nil
		}
	}
	return "", errors.New("unexpected archive structure")
}

func replaceFile(src, dst string, mode os.FileMode) error {
	tmp := dst + ".tmp"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return replaceFile(path, target, info.Mode())
	})
}
