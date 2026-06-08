package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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

const (
	defaultCheckInterval = time.Hour
	releaseNotesPath     = "release-notes.md"
)

var releaseManifestPublicKey string

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

type releaseManifest struct {
	Version   string             `json:"version"`
	Repo      string             `json:"repo,omitempty"`
	Artifacts []manifestArtifact `json:"artifacts"`
}

type signedReleaseManifest struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type manifestArtifact struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
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
			Timeout: 10 * time.Minute,
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
	manifest, err := s.fetchAndVerifyManifest(ctx, version)
	if err != nil {
		s.fail(err)
		return
	}
	artifact, err := manifest.findArtifact(asset.Name)
	if err != nil {
		s.fail(err)
		return
	}

	tmpDir, err := os.MkdirTemp("", "mindfs-update-*")
	if err != nil {
		s.fail(err)
		return
	}
	cleanupTmpDir := true
	defer func() {
		if cleanupTmpDir {
			_ = os.RemoveAll(tmpDir)
		}
	}()

	archivePath := filepath.Join(tmpDir, asset.Name)
	if err := s.downloadFile(ctx, asset.BrowserDownloadURL, archivePath); err != nil {
		s.fail(err)
		return
	}
	if err := verifyFileSHA256(archivePath, artifact.SHA256, artifact.Size); err != nil {
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
			return
		}
		cleanupTmpDir = false
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
	body, err := s.fetchRawText(ctx, releaseNotesPath, 1<<20)
	if err != nil {
		return latestRelease{}, err
	}
	tag := parseReleaseNotesVersion(body)
	if tag == "" {
		return latestRelease{}, fmt.Errorf("release check failed: no version found in %s", releaseNotesPath)
	}
	tag = normalizeTag(tag)
	return latestRelease{
		TagName: tag,
		Name:    tag,
		Body:    latestReleaseNotesBody(body),
		HTMLURL: fmt.Sprintf("https://github.com/%s/releases/tag/%s", s.repo, tag),
		Assets:  []releaseAsset{s.releaseAssetForVersion(tag)},
	}, nil
}

func (s *Service) fetchRawText(ctx context.Context, path string, limit int64) (string, error) {
	url := fmt.Sprintf("https://raw.githubusercontent.com/%s/main/%s", s.repo, strings.TrimPrefix(path, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "mindfs-update-checker")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("raw file fetch failed: %s", resp.Status)
	}
	if limit <= 0 {
		limit = 64 << 10
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return "", err
	}
	return string(body), nil
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

func (s *Service) releaseAssetForVersion(version string) releaseAsset {
	version = normalizeTag(version)
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	name := fmt.Sprintf("mindfs_%s_%s_%s%s", version, runtime.GOOS, runtime.GOARCH, ext)
	return releaseAsset{
		Name:               name,
		BrowserDownloadURL: fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", s.repo, version, name),
	}
}

func (s *Service) fetchAndVerifyManifest(ctx context.Context, version string) (releaseManifest, error) {
	publicKey, err := updatePublicKey()
	if err != nil {
		return releaseManifest{}, err
	}
	version = normalizeTag(version)
	base := fmt.Sprintf("https://github.com/%s/releases/download/%s/mindfs_%s_manifest.json", s.repo, version, version)
	body, err := s.fetchURL(ctx, base, 4<<20)
	if err != nil {
		return releaseManifest{}, err
	}
	var envelope signedReleaseManifest
	if err := json.Unmarshal(body, &envelope); err != nil {
		return releaseManifest{}, fmt.Errorf("release manifest envelope invalid: %w", err)
	}
	if strings.TrimSpace(envelope.Payload) == "" || strings.TrimSpace(envelope.Signature) == "" {
		return releaseManifest{}, errors.New("release manifest envelope missing payload or signature")
	}
	payload, err := decodeBase64String(envelope.Payload)
	if err != nil {
		return releaseManifest{}, fmt.Errorf("release manifest payload invalid: %w", err)
	}
	signature, err := decodeBase64String(envelope.Signature)
	if err != nil {
		return releaseManifest{}, fmt.Errorf("release manifest signature invalid: %w", err)
	}
	if !ed25519.Verify(publicKey, payload, signature) {
		return releaseManifest{}, errors.New("release manifest signature verification failed")
	}
	var manifest releaseManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return releaseManifest{}, fmt.Errorf("release manifest invalid: %w", err)
	}
	if normalizeTag(manifest.Version) != version {
		return releaseManifest{}, fmt.Errorf("release manifest version mismatch: got %q want %q", manifest.Version, version)
	}
	return manifest, nil
}

func updatePublicKey() (ed25519.PublicKey, error) {
	encoded := strings.TrimSpace(releaseManifestPublicKey)
	if encoded == "" {
		return nil, errors.New("auto update requires a configured release manifest public key")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	if err != nil {
		return nil, fmt.Errorf("release manifest public key invalid: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("release manifest public key invalid length: got %d want %d", len(raw), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

func (m releaseManifest) findArtifact(name string) (manifestArtifact, error) {
	for _, artifact := range m.Artifacts {
		if strings.TrimSpace(artifact.Name) == name {
			if _, err := parseSHA256Hex(artifact.SHA256); err != nil {
				return manifestArtifact{}, fmt.Errorf("release manifest artifact %s invalid sha256: %w", name, err)
			}
			return artifact, nil
		}
	}
	return manifestArtifact{}, fmt.Errorf("release manifest missing artifact: %s", name)
}

func verifyFileSHA256(path, wantHex string, wantSize int64) error {
	want, err := parseSHA256Hex(wantHex)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	if wantSize > 0 && size != wantSize {
		return fmt.Errorf("downloaded artifact size mismatch: got %d want %d", size, wantSize)
	}
	if got := hash.Sum(nil); !bytesEqual(got, want) {
		return errors.New("downloaded artifact sha256 verification failed")
	}
	return nil
}

func parseSHA256Hex(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if len(value) != sha256.Size*2 {
		return nil, fmt.Errorf("got %d hex chars want %d", len(value), sha256.Size*2)
	}
	out, err := hex.DecodeString(value)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func decodeBase64String(value string) ([]byte, error) {
	encoded := strings.TrimSpace(value)
	out, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		out, err = base64.RawStdEncoding.DecodeString(encoded)
	}
	return out, err
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

func (s *Service) fetchURL(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "mindfs-updater")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("download failed: %s", resp.Status)
	}
	reader := io.Reader(resp.Body)
	if limit > 0 {
		reader = io.LimitReader(resp.Body, limit+1)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		return nil, err
	}
	if limit > 0 && int64(len(body)) > limit {
		return nil, fmt.Errorf("download exceeds size limit: %d bytes", limit)
	}
	return body, nil
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
	if _, err := updatePublicKey(); err != nil {
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
	if _, err := updatePublicKey(); err != nil {
		return "Auto update is unavailable because the release verification public key is not configured."
	}
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

func normalizeTag(v string) string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "v")
	if v == "" {
		return ""
	}
	return "v" + v
}

func parseReleaseNotesVersion(text string) string {
	firstLine := strings.TrimSpace(strings.TrimSuffix(strings.SplitN(text, "\n", 2)[0], "\r"))
	const prefix = "# MindFS "
	if !strings.HasPrefix(firstLine, prefix) {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(strings.TrimPrefix(firstLine, prefix)))
	if len(fields) == 0 {
		return ""
	}
	version := fields[0]
	if _, ok := parseVersionParts(version); ok {
		return version
	}
	return ""
}

func latestReleaseNotesBody(text string) string {
	lines := strings.SplitAfter(text, "\n")
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(strings.TrimSuffix(lines[i], "\r"))
		if strings.HasPrefix(line, "# MindFS ") && parseReleaseNotesVersion(line) != "" {
			return strings.TrimSpace(strings.Join(lines[:i], ""))
		}
	}
	return strings.TrimSpace(text)
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

func bytesEqual(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var diff byte
	for i := range left {
		diff |= left[i] ^ right[i]
	}
	return diff == 0
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
		target, err := safeArchiveTarget(dst, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
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
		default:
			return fmt.Errorf("unsupported tar entry type for %s", header.Name)
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
		if file.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsupported zip symlink entry: %s", file.Name)
		}
		target, err := safeArchiveTarget(dst, file.Name)
		if err != nil {
			return err
		}
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

func safeArchiveTarget(root, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("empty archive entry name")
	}
	if filepath.IsAbs(name) {
		return "", fmt.Errorf("unsafe absolute archive entry: %s", name)
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("unsafe archive entry path: %s", name)
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	target := filepath.Join(rootAbs, clean)
	rel, err := filepath.Rel(rootAbs, target)
	if err != nil {
		return "", err
	}
	if rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("archive entry escapes destination: %s", name)
	}
	return target, nil
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
