package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"mindfs/server/app"
)

var version = "dev"

var errBrowserUnavailable = errors.New("browser auto-open unavailable")

const (
	daemonEnvKey          = "MINDFS_DAEMON"
	internalRestartEnvKey = "MINDFS_INTERNAL_RESTART"
	staticDirEnvKey       = "MINDFS_STATIC_DIR"
	maxLogSizeBytes       = 10 * 1024 * 1024
	maxLogBackups         = 3
)

func main() {
	flag.Usage = func() {
		out := flag.CommandLine.Output()
		fmt.Fprintf(out, "Usage:\n")
		fmt.Fprintf(out, "  mindfs [flags] [root]\n\n")
		fmt.Fprintf(out, "Arguments:\n")
		fmt.Fprintf(out, "  root    Directory to manage. Defaults to the current directory.\n\n")
		fmt.Fprintf(out, "Flags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(out, "\nExamples:\n")
		fmt.Fprintf(out, "  mindfs\n")
		fmt.Fprintf(out, "  mindfs /path/to/project\n")
		fmt.Fprintf(out, "  mindfs --foreground\n")
		fmt.Fprintf(out, "  mindfs --status\n")
		fmt.Fprintf(out, "  mindfs --stop\n")
		fmt.Fprintf(out, "  mindfs -addr :9000 /path/to/project\n")
		fmt.Fprintf(out, "  mindfs -remove /path/to/project\n")
	}

	addr := flag.String("addr", "127.0.0.1:7331", "listen address")
	noRelayer := flag.Bool("no-relayer", false, "disable relay integration")
	e2eeFlag := flag.Bool("e2ee", false, "enable end-to-end encryption for sensitive data")
	foreground := flag.Bool("foreground", false, "run in the foreground instead of as a background service")
	stop := flag.Bool("stop", false, "stop the background mindfs service")
	restart := flag.Bool("restart", false, "restart the background mindfs service")
	statusFlag := flag.Bool("status", false, "show background service status")
	remove := flag.Bool("remove", false, "remove the managed directory")
	tlsFlag := flag.Bool("tls", false, "enable HTTPS (auto-generates self-signed cert if -cert/-key not provided)")
	certFlag := flag.String("cert", "", "TLS certificate file (PEM); auto-generated if empty with -tls")
	keyFlag := flag.String("key", "", "TLS private key file (PEM); auto-generated if empty with -tls")
	flag.Parse()
	internalRestart := os.Getenv(internalRestartEnvKey) == "1"
	daemonMode := os.Getenv(daemonEnvKey) == "1"
	if internalRestart {
		log.Printf("[mindfs] internal restart detected addr=%s root_arg_count=%d", *addr, flag.NArg())
	}

	root := "."
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	stateDir, err := ensureStateDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	pidPath, logPath, err := servicePaths(stateDir, *addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	if *statusFlag {
		if err := printServiceStatus(*addr, *tlsFlag, pidPath, logPath); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}
	if *stop {
		if err := stopService(*addr, *tlsFlag, pidPath); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				fmt.Fprintln(os.Stdout, "mindfs service already stopped")
				return
			}
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "mindfs service stopped")
		return
	}
	if *restart {
		if err := stopService(*addr, *tlsFlag, pidPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
	}

	if *remove {
		if err := handleRemoveRoot(*addr, *tlsFlag, absRoot); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "removed managed directory:", absRoot)
		return
	}

	e2eeResult, err := app.EnsureE2EEConfig(*e2eeFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	if *e2eeFlag && strings.TrimSpace(e2eeResult.Config.PairingSecret) != "" {
		fmt.Fprintln(os.Stdout, "E2EE enabled")
		fmt.Fprintln(os.Stdout, "pairing secret:", e2eeResult.Config.PairingSecret)
	}

	if !internalRestart && !*restart && serverRunning(*addr, *tlsFlag) {
		fmt.Fprintf(os.Stdout, "server already running on %s, reusing existing process\n", *addr)
		rootInfo, err := addManagedDir(*addr, *tlsFlag, absRoot)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
		if err := openTarget(*addr, *tlsFlag, rootInfo.ID); err != nil {
			reportOpenTargetError(os.Stderr, err)
		}
		return
	}

	// Resolve TLS certificate/key paths when TLS is enabled.
	resolvedCert, resolvedKey := *certFlag, *keyFlag
	if *tlsFlag && (resolvedCert == "" || resolvedKey == "") {
		resolvedCert, resolvedKey, err = app.EnsureTLSCert(*certFlag, *keyFlag)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
	}

	if !*foreground && !daemonMode && !internalRestart {
		if err := startBackgroundProcess(logPath); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		if err := waitForServer(*addr, *tlsFlag, 8*time.Second); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		rootInfo, err := addManagedDir(*addr, *tlsFlag, absRoot)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "mindfs service started")
		fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
		if err := openTarget(*addr, *tlsFlag, rootInfo.ID); err != nil {
			reportOpenTargetError(os.Stderr, err)
		}
		fmt.Fprintf(os.Stdout, "logs: %s\n", logPath)
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := writePIDFile(pidPath); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	defer removePIDFile(pidPath)

	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Start(ctx, *addr, app.StartOptions{
			NoRelayer:  *noRelayer,
			Version:    version,
			Args:       os.Args[1:],
			E2EEConfig: e2eeResult.Config,
			UseTLS:     *tlsFlag,
			CertFile:   resolvedCert,
			KeyFile:    resolvedKey,
		})
	}()
	if err := waitForServer(*addr, *tlsFlag, 8*time.Second); err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	rootInfo, err := addManagedDir(*addr, *tlsFlag, absRoot)
	if err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)

	if !internalRestart && (*foreground || !daemonMode) {
		if err := openTarget(*addr, *tlsFlag, rootInfo.ID); err != nil {
			reportOpenTargetError(os.Stderr, err)
		}
	}

	select {
	case <-ctx.Done():
		return
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
	}
}

func ensureStateDir() (string, error) {
	base, err := platformStateDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "mindfs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func servicePaths(stateDir, addr string) (string, string, error) {
	logDir := filepath.Join(stateDir, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return "", "", err
	}
	key := sanitizeAddrForFile(addr)
	return filepath.Join(stateDir, "mindfs-"+key+".pid"), filepath.Join(logDir, "mindfs.log"), nil
}

func sanitizeAddrForFile(addr string) string {
	if strings.TrimSpace(addr) == "" {
		return "default"
	}
	var b strings.Builder
	for _, r := range addr {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "default"
	}
	return b.String()
}

func startBackgroundProcess(logPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if err := rotateLogIfNeeded(logPath, maxLogSizeBytes, maxLogBackups); err != nil {
		return err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = append(cmd.Environ(), daemonEnvKey+"=1")
	if staticDir := resolveDevelopmentStaticDir(); staticDir != "" {
		cmd.Env = append(cmd.Env, staticDirEnvKey+"="+staticDir)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Stdin = nil
	configureBackgroundCommand(cmd)
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return err
	}
	return logFile.Close()
}

func resolveDevelopmentStaticDir() string {
	if len(os.Args) == 0 {
		return ""
	}
	arg0 := strings.TrimSpace(os.Args[0])
	if arg0 == "" || !strings.HasPrefix(arg0, "."+string(os.PathSeparator)) {
		return ""
	}
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	candidate := filepath.Join(cwd, "web", "dist")
	if info, err := os.Stat(candidate); err == nil && info.IsDir() {
		return candidate
	}
	return ""
}

func rotateLogIfNeeded(path string, maxSize int64, backups int) error {
	if strings.TrimSpace(path) == "" || maxSize <= 0 || backups < 1 {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Size() < maxSize {
		return nil
	}
	oldest := rotatedLogPath(path, backups)
	if err := os.Remove(oldest); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for i := backups - 1; i >= 1; i-- {
		src := rotatedLogPath(path, i)
		dst := rotatedLogPath(path, i+1)
		if err := os.Rename(src, dst); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := os.Rename(path, rotatedLogPath(path, 1)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func rotatedLogPath(path string, index int) string {
	return fmt.Sprintf("%s.%d", path, index)
}

func writePIDFile(pidPath string) error {
	return writePIDValue(pidPath, os.Getpid())
}

func writePIDValue(pidPath string, pid int) error {
	return os.WriteFile(pidPath, []byte(strconv.Itoa(pid)+"\n"), 0o644)
}

func removePIDFile(pidPath string) {
	_ = os.Remove(pidPath)
}

func readPIDFile(pidPath string) (int, error) {
	raw, err := os.ReadFile(pidPath)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0, err
	}
	if pid <= 0 {
		return 0, fmt.Errorf("invalid pid in %s", pidPath)
	}
	return pid, nil
}

func stopService(addr string, useTLS bool, pidPath string) error {
	pid, err := resolveServicePID(addr, useTLS, pidPath)
	if err != nil {
		return err
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := stopProcess(proc, pid); err != nil {
		if errors.Is(err, os.ErrProcessDone) {
			_ = os.Remove(pidPath)
			return nil
		}
		return err
	}
	for i := 0; i < 50; i++ {
		if !processExists(pid) {
			_ = os.Remove(pidPath)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timed out stopping process %d", pid)
}

func printServiceStatus(addr string, useTLS bool, pidPath, logPath string) error {
	pid, err := resolveServicePID(addr, useTLS, pidPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stdout, "mindfs status: stopped")
			return nil
		}
		return err
	}
	fmt.Fprintln(os.Stdout, "mindfs status: running")
	fmt.Fprintf(os.Stdout, "pid: %d\n", pid)
	fmt.Fprintf(os.Stdout, "addr: %s\n", addrToURL(addr, "", useTLS))
	fmt.Fprintf(os.Stdout, "log file: %s\n", logPath)
	return nil
}

func resolveServicePID(addr string, useTLS bool, pidPath string) (int, error) {
	pid, err := readPIDFile(pidPath)
	if err == nil {
		if processExists(pid) {
			return pid, nil
		}
		_ = os.Remove(pidPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}

	if strings.TrimSpace(addr) == "" || !serverRunning(addr, useTLS) {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		return 0, os.ErrNotExist
	}

	pid, err = findListeningMindfsPID(addr)
	if err != nil {
		return 0, err
	}
	if pid <= 0 {
		return 0, os.ErrNotExist
	}
	if writeErr := writePIDValue(pidPath, pid); writeErr != nil {
		return 0, writeErr
	}
	return pid, nil
}

func processExists(pid int) bool {
	if pid <= 0 {
		return false
	}
	return processExistsPlatform(pid)
}

func newHTTPClient(useTLS bool, timeout time.Duration) *http.Client {
	c := &http.Client{Timeout: timeout}
	if useTLS {
		// InsecureSkipVerify is used because these CLI health checks and API
		// calls connect to the local MindFS server (loopback or same machine),
		// which may present a self-signed certificate. No traffic leaves the host.
		c.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		}
	}
	return c
}

func serverRunning(addr string, useTLS bool) bool {
	url := addrToURL(addr, "/health", useTLS)
	client := newHTTPClient(useTLS, 800*time.Millisecond)
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

type managedDirResponse struct {
	ID       string `json:"id"`
	RootPath string `json:"root_path"`
}

type relayStatusResponse struct {
	Bound        bool   `json:"relay_bound"`
	NoRelayer    bool   `json:"no_relayer"`
	PendingCode  string `json:"pending_code"`
	NodeID       string `json:"node_id"`
	RelayBaseURL string `json:"relay_base_url"`
	NodeURL      string `json:"node_url"`
}

func addManagedDir(addr string, useTLS bool, path string) (managedDirResponse, error) {
	url := addrToURL(addr, "/api/dirs", useTLS)
	body, err := json.Marshal(map[string]any{"path": path})
	if err != nil {
		return managedDirResponse{}, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return managedDirResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := newHTTPClient(useTLS, 3*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return managedDirResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		var out managedDirResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return managedDirResponse{}, err
		}
		if strings.TrimSpace(out.RootPath) == "" {
			out.RootPath = path
		}
		return out, nil
	}
	message := httpErrorMessage(resp)
	return managedDirResponse{}, fmt.Errorf("failed to add managed directory: %s", message)
}

func removeManagedDir(addr string, useTLS bool, path string) error {
	endpoint := addrToURL(addr, "/api/dirs?path="+url.QueryEscape(path), useTLS)
	req, err := http.NewRequest(http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	client := newHTTPClient(useTLS, 3*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	message := httpErrorMessage(resp)
	return fmt.Errorf("failed to remove managed directory: %s", message)
}

func httpErrorMessage(resp *http.Response) string {
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	message := strings.TrimSpace(string(payload))
	var apiErr struct {
		Error string `json:"error"`
	}
	if message != "" && json.Unmarshal(payload, &apiErr) == nil && strings.TrimSpace(apiErr.Error) != "" {
		message = strings.TrimSpace(apiErr.Error)
	}
	if message == "" {
		message = resp.Status
	}
	return message
}

func removeManagedDirFromRegistry(path string) error {
	return app.RemoveManagedDirFromRegistry(path)
}

func handleRemoveRoot(addr string, useTLS bool, path string) error {
	if serverRunning(addr, useTLS) {
		return removeManagedDir(addr, useTLS, path)
	}
	return removeManagedDirFromRegistry(path)
}

func fetchRelayStatus(addr string, useTLS bool) (relayStatusResponse, error) {
	url := addrToURL(addr, "/api/relay/status", useTLS)
	client := newHTTPClient(useTLS, 3*time.Second)
	resp, err := client.Get(url)
	if err != nil {
		return relayStatusResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(payload))
		if message == "" {
			message = resp.Status
		}
		return relayStatusResponse{}, fmt.Errorf("failed to fetch relay status: %s", message)
	}
	var out relayStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return relayStatusResponse{}, err
	}
	return out, nil
}

func openTarget(addr string, useTLS bool, rootID string) error {
	status, err := fetchRelayStatus(addr, useTLS)
	if err != nil {
		return err
	}
	target := ""
	if status.Bound && strings.TrimSpace(status.NodeURL) != "" {
		u, err := url.Parse(status.NodeURL)
		if err != nil {
			return err
		}
		if strings.TrimSpace(rootID) != "" {
			q := u.Query()
			q.Set("root", rootID)
			u.RawQuery = q.Encode()
		}
		target = u.String()
	} else {
		target = localOpenURL(addr, useTLS, rootID)
	}
	return openBrowser(target)
}

func reportOpenTargetError(w io.Writer, err error) {
	if err == nil || w == nil {
		return
	}
	if errors.Is(err, errBrowserUnavailable) {
		fmt.Fprintln(w, err.Error())
		return
	}
	fmt.Fprintln(w, err.Error())
}

func localOpenURL(addr string, useTLS bool, rootID string) string {
	base := addrToURL(addr, "", useTLS)
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	if strings.TrimSpace(rootID) != "" {
		q.Set("root", rootID)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func openBrowser(target string) error {
	if strings.TrimSpace(target) == "" {
		return nil
	}
	if runtime.GOOS == "linux" && strings.TrimSpace(os.Getenv("DISPLAY")) == "" && strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) == "" {
		return fmt.Errorf("%w; open this URL manually: %s", errBrowserUnavailable, target)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

func addrToURL(addr, path string, useTLS bool) string {
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return addr + path
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		host = "localhost"
		port = strings.TrimPrefix(addr, ":")
	}
	if host == "" {
		host = "localhost"
	}
	if host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "7331"
	}
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s:%s%s", scheme, host, port, path)
}

func waitForServer(addr string, useTLS bool, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if serverRunning(addr, useTLS) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server did not become ready on %s within %s", addr, timeout)
}
