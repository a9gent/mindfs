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
	maxLogSizeBytes       = 10 * 1024 * 1024
	maxLogBackups         = 3
)

func main() {
	flag.Usage = func() {
		out := flag.CommandLine.Output()
		fmt.Fprintf(out, "Usage:\n")
		fmt.Fprintf(out, "  mindfs [flags] [root]\n\n")
		fmt.Fprintf(out, "Arguments:\n")
		fmt.Fprintf(out, "  root    Directory to manage. If omitted, MindFS opens without adding a directory.\n\n")
		fmt.Fprintf(out, "Flags:\n")
		flag.PrintDefaults()
		fmt.Fprintf(out, "\nExamples:\n")
		fmt.Fprintf(out, "  mindfs\n")
		fmt.Fprintf(out, "  mindfs /path/to/project\n")
		fmt.Fprintf(out, "  mindfs --foreground\n")
		fmt.Fprintf(out, "  mindfs --status\n")
		fmt.Fprintf(out, "  mindfs --version\n")
		fmt.Fprintf(out, "  mindfs --update\n")
		fmt.Fprintf(out, "  mindfs --uninstall\n")
		fmt.Fprintf(out, "  mindfs --stop\n")
		fmt.Fprintf(out, "  mindfs -addr :9000 /path/to/project\n")
		fmt.Fprintf(out, "  mindfs -remove /path/to/project\n")
		fmt.Fprintf(out, "  mindfs <rootid> -task 12\n")
		fmt.Fprintf(out, "  mindfs <rootid> -task 12 -next\n")
	}

	addr := flag.String("addr", "127.0.0.1:7331", "listen address")
	noRelayer := flag.Bool("no-relayer", false, "disable relay integration")
	e2eeFlag := flag.Bool("e2ee", false, "enable end-to-end encryption for sensitive data")
	webPushFlag := flag.Bool("web-push", true, "enable PWA Web Push notifications")
	foreground := flag.Bool("foreground", false, "run in the foreground instead of as a background service")
	stop := flag.Bool("stop", false, "stop the background mindfs service")
	restart := flag.Bool("restart", false, "restart the background mindfs service")
	statusFlag := flag.Bool("status", false, "show background service status")
	versionFlag := flag.Bool("version", false, "show version")
	updateFlag := flag.Bool("update", false, "check for and install the latest MindFS release")
	uninstallFlag := flag.Bool("uninstall", false, "print the MindFS uninstall command")
	bindRelay := flag.Bool("bind-relay", false, "start relay binding and print the relayer bind URL")
	configFlag := flag.String("config", "", "mindfs startup config file; command-line flags override file values")
	agentConfigFlag := flag.String("agent-config", "", "extra agents.json file for customizable agent(ACP-protocol) and shell")
	notifyScriptFlag := flag.String("notify-script", "", "executable script for notification events; receives JSON payload on stdin")
	remove := flag.Bool("remove", false, "remove the managed directory")
	taskNumber := flag.String("task", "", "task number for task stage control; defaults to status when set")
	taskNext := flag.Bool("next", false, "advance task to next stage")
	taskPrev := flag.Bool("prev", false, "move task to previous stage")
	tlsFlag := flag.Bool("tls", false, "enable HTTPS (auto-generates self-signed cert if -cert/-key not provided)")
	certFlag := flag.String("cert", "", "TLS certificate file (PEM); auto-generated if empty with -tls")
	keyFlag := flag.String("key", "", "TLS private key file (PEM); auto-generated if empty with -tls")
	_ = flag.CommandLine.Parse(normalizeTaskRootFirstArgs(os.Args[1:]))
	explicitFlags := visitedFlags(flag.CommandLine)
	startupCfg, err := loadStartupConfig(*configFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	applyStartupConfig(startupCfg, explicitFlags, addr, noRelayer, e2eeFlag, webPushFlag, foreground, bindRelay, tlsFlag, certFlag, keyFlag, agentConfigFlag, notifyScriptFlag)
	if *versionFlag {
		printVersion()
		return
	}
	if strings.TrimSpace(*taskNumber) != "" {
		rootID := ""
		if flag.NArg() > 0 {
			rootID = flag.Arg(0)
		}
		action := taskCLIAction(*statusFlag, *taskNext, *taskPrev)
		if err := handleTaskCommand(*addr, *tlsFlag, rootID, strings.TrimSpace(*taskNumber), action); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}
	if *uninstallFlag {
		printUninstallCommand()
		return
	}
	internalRestart := os.Getenv(internalRestartEnvKey) == "1"
	daemonMode := os.Getenv(daemonEnvKey) == "1"
	if internalRestart {
		log.Printf("[mindfs] internal restart detected addr=%s root_arg_count=%d", *addr, flag.NArg())
	}

	hasRootArg := flag.NArg() > 0
	root := "."
	if hasRootArg {
		root = flag.Arg(0)
	}
	absRoot := ""
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

	if *updateFlag {
		if err := handleUpdateCommand(context.Background(), *addr, *tlsFlag); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
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
		absRoot, err = filepath.Abs(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
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
		rootID := ""
		if hasRootArg {
			absRoot, err = filepath.Abs(root)
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
			rootInfo, err := addManagedDir(*addr, *tlsFlag, absRoot)
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
			rootID = rootInfo.ID
			fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
		}
		if *bindRelay {
			if err := printRelayBindTarget(os.Stdout, *addr, *tlsFlag, rootID); err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
		} else if err := openTarget(*addr, *tlsFlag, rootID); err != nil {
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
		rootID := ""
		fmt.Fprintln(os.Stdout, "mindfs service started")
		if hasRootArg {
			absRoot, err = filepath.Abs(root)
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
			rootInfo, err := addManagedDir(*addr, *tlsFlag, absRoot)
			if err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
			rootID = rootInfo.ID
			fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
		}
		if *bindRelay {
			if err := printRelayBindTarget(os.Stdout, *addr, *tlsFlag, rootID); err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
		} else if err := openTarget(*addr, *tlsFlag, rootID); err != nil {
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
			NoRelayer:       *noRelayer,
			Version:         version,
			Args:            os.Args[1:],
			AgentConfigPath: *agentConfigFlag,
			E2EEConfig:      e2eeResult.Config,
			WebPushEnabled:  *webPushFlag,
			NotifyScript:    *notifyScriptFlag,
			UseTLS:          *tlsFlag,
			CertFile:        resolvedCert,
			KeyFile:         resolvedKey,
		})
	}()
	if err := waitForServer(*addr, *tlsFlag, 8*time.Second); err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	rootID := ""
	if hasRootArg {
		absRoot, err = filepath.Abs(root)
		if err != nil {
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
		rootID = rootInfo.ID
		fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
	}

	if !internalRestart && (*foreground || !daemonMode) {
		if *bindRelay {
			if err := printRelayBindTarget(os.Stdout, *addr, *tlsFlag, rootID); err != nil {
				cancel()
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
		} else if err := openTarget(*addr, *tlsFlag, rootID); err != nil {
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

type startupConfig struct {
	Addr          *string `json:"addr"`
	NoRelayer     *bool   `json:"noRelayer"`
	NoRelayerFlag *bool   `json:"no-relayer"`
	E2EE          *bool   `json:"e2ee"`
	WebPush       *bool   `json:"webPush"`
	WebPushFlag   *bool   `json:"web-push"`
	Foreground    *bool   `json:"foreground"`
	BindRelay     *bool   `json:"bindRelay"`
	BindRelayFlag *bool   `json:"bind-relay"`
	TLS           *bool   `json:"tls"`
	Cert          *string `json:"cert"`
	Key           *string `json:"key"`
	AgentConfig   *string `json:"agent-config"`
	NotifyScript  *string `json:"notify-script"`
}

func loadStartupConfig(path string) (startupConfig, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return startupConfig{}, nil
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return startupConfig{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg startupConfig
	if err := json.Unmarshal(payload, &cfg); err != nil {
		return startupConfig{}, fmt.Errorf("decode config %s: %w", path, err)
	}
	return cfg, nil
}

func visitedFlags(flags *flag.FlagSet) map[string]bool {
	visited := make(map[string]bool)
	flags.Visit(func(f *flag.Flag) {
		visited[f.Name] = true
	})
	return visited
}

func applyStartupConfig(
	cfg startupConfig,
	explicit map[string]bool,
	addr *string,
	noRelayer *bool,
	e2ee *bool,
	webPush *bool,
	foreground *bool,
	bindRelay *bool,
	tlsFlag *bool,
	cert *string,
	key *string,
	agentConfig *string,
	notifyScript *string,
) {
	if cfg.Addr != nil && !explicit["addr"] {
		*addr = strings.TrimSpace(*cfg.Addr)
	}
	if value := firstBool(cfg.NoRelayer, cfg.NoRelayerFlag); value != nil && !explicit["no-relayer"] {
		*noRelayer = *value
	}
	if cfg.E2EE != nil && !explicit["e2ee"] {
		*e2ee = *cfg.E2EE
	}
	if value := firstBool(cfg.WebPush, cfg.WebPushFlag); value != nil && !explicit["web-push"] {
		*webPush = *value
	}
	if cfg.Foreground != nil && !explicit["foreground"] {
		*foreground = *cfg.Foreground
	}
	if value := firstBool(cfg.BindRelay, cfg.BindRelayFlag); value != nil && !explicit["bind-relay"] {
		*bindRelay = *value
	}
	if cfg.TLS != nil && !explicit["tls"] {
		*tlsFlag = *cfg.TLS
	}
	if cfg.Cert != nil && !explicit["cert"] {
		*cert = strings.TrimSpace(*cfg.Cert)
	}
	if cfg.Key != nil && !explicit["key"] {
		*key = strings.TrimSpace(*cfg.Key)
	}
	if cfg.AgentConfig != nil && !explicit["agent-config"] {
		*agentConfig = strings.TrimSpace(*cfg.AgentConfig)
	}
	if cfg.NotifyScript != nil && !explicit["notify-script"] {
		*notifyScript = strings.TrimSpace(*cfg.NotifyScript)
	}
}

func firstBool(values ...*bool) *bool {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
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

func printVersion() {
	fmt.Fprintf(os.Stdout, "mindfs version: %s\n", version)
}

func printUninstallCommand() {
	if runtime.GOOS == "windows" {
		fmt.Fprintln(os.Stdout, "Run one of the following commands manually:")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Uninstall MindFS, keeping user config and project data:")
		fmt.Fprintln(os.Stdout, "Download scripts/install.ps1 from https://github.com/a9gent/mindfs, then run it with -Uninstall.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Purge MindFS, including user config and logs:")
		fmt.Fprintln(os.Stdout, "Download scripts/install.ps1 from https://github.com/a9gent/mindfs, then run it with -Uninstall -Purge.")
		return
	}
	fmt.Fprintln(os.Stdout, "Run one of the following commands manually:")
	fmt.Fprintln(os.Stdout, "")
	fmt.Fprintln(os.Stdout, "Uninstall MindFS, keeping user config and project data:")
	fmt.Fprintln(os.Stdout, `installer="${TMPDIR:-/tmp}/mindfs-install.sh"`)
	fmt.Fprintln(os.Stdout, `curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh -o "$installer"`)
	fmt.Fprintln(os.Stdout, `bash "$installer" --uninstall`)
	fmt.Fprintln(os.Stdout, "")
	fmt.Fprintln(os.Stdout, "Purge MindFS, including user config and logs:")
	fmt.Fprintln(os.Stdout, `installer="${TMPDIR:-/tmp}/mindfs-install.sh"`)
	fmt.Fprintln(os.Stdout, `curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh -o "$installer"`)
	fmt.Fprintln(os.Stdout, `bash "$installer" --uninstall --purge`)
}

func handleUpdateCommand(ctx context.Context, addr string, useTLS bool) error {
	if runtime.GOOS == "windows" && serverRunning(addr, useTLS) {
		return errors.New("mindfs service is running. Stop it before updating:\n  mindfs -stop\n  mindfs -update\n  mindfs")
	}
	fmt.Fprintln(os.Stdout, "Checking for updates...")
	result, err := app.UpdateNow(ctx, app.UpdateOptions{
		Version:  version,
		Progress: os.Stdout,
	})
	if strings.TrimSpace(result.CurrentVersion) != "" {
		fmt.Fprintf(os.Stdout, "current version: %s\n", result.CurrentVersion)
	}
	if strings.TrimSpace(result.LatestVersion) != "" {
		fmt.Fprintf(os.Stdout, "latest version: %s\n", result.LatestVersion)
	}
	if err != nil {
		return err
	}
	if !result.HasUpdate {
		fmt.Fprintln(os.Stdout, "mindfs is already up to date")
		return nil
	}
	if result.Installed {
		fmt.Fprintln(os.Stdout, "Restart MindFS to use the new version:")
		fmt.Fprintln(os.Stdout, "  mindfs -restart")
	}
	return nil
}

func printServiceStatus(addr string, useTLS bool, pidPath, logPath string) error {
	pid, err := resolveServicePID(addr, useTLS, pidPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintln(os.Stdout, "mindfs status: stopped")
			fmt.Fprintf(os.Stdout, "version: %s\n", version)
			return nil
		}
		return err
	}
	fmt.Fprintln(os.Stdout, "mindfs status: running")
	fmt.Fprintf(os.Stdout, "pid: %d\n", pid)
	fmt.Fprintf(os.Stdout, "addr: %s\n", addrToURL(addr, "", useTLS))
	fmt.Fprintf(os.Stdout, "log file: %s\n", logPath)
	fmt.Fprintf(os.Stdout, "version: %s\n", version)
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

	if strings.TrimSpace(addr) == "" {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		return 0, os.ErrNotExist
	}

	pid, err = findListeningMindfsPID(addr)
	if err != nil {
		return 0, err
	}
	if pid <= 0 && !serverRunning(addr, useTLS) {
		return 0, os.ErrNotExist
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
	NodeName     string `json:"node_name"`
	NodeID       string `json:"node_id"`
	RelayBaseURL string `json:"relay_base_url"`
	NodeURL      string `json:"node_url"`
}

func addManagedDir(addr string, useTLS bool, path string) (managedDirResponse, error) {
	token, err := app.ReadLocalCLIToken(addr)
	if err != nil {
		return managedDirResponse{}, err
	}
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
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
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
	return managedDirResponse{}, fmt.Errorf("failed to add managed directory:\n%s", message)
}

func removeManagedDir(addr string, useTLS bool, path string) error {
	token, err := app.ReadLocalCLIToken(addr)
	if err != nil {
		return err
	}
	endpoint := addrToURL(addr, "/api/dirs?path="+url.QueryEscape(path), useTLS)
	req, err := http.NewRequest(http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
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

func normalizeTaskRootFirstArgs(args []string) []string {
	if len(args) < 2 || strings.HasPrefix(args[0], "-") || !containsTaskFlag(args[1:]) {
		return args
	}
	out := make([]string, 0, len(args))
	out = append(out, args[1:]...)
	out = append(out, args[0])
	return out
}

func containsTaskFlag(args []string) bool {
	for _, arg := range args {
		if arg == "-task" || arg == "--task" || strings.HasPrefix(arg, "-task=") || strings.HasPrefix(arg, "--task=") {
			return true
		}
	}
	return false
}

func taskCLIAction(status, next, prev bool) string {
	actions := []string{}
	if status {
		actions = append(actions, "status")
	}
	if next {
		actions = append(actions, "next")
	}
	if prev {
		actions = append(actions, "prev")
	}
	if len(actions) == 0 {
		return "status"
	}
	if len(actions) > 1 {
		return ""
	}
	return actions[0]
}

type taskCLIListResponse struct {
	Items []json.RawMessage `json:"items"`
}

type taskCLIDetailHeader struct {
	Task struct {
		ID         string `json:"id"`
		TaskNumber int    `json:"task_number"`
	} `json:"task"`
}

func handleTaskCommand(addr string, useTLS bool, rootID, taskNumberRaw, action string) error {
	rootID = strings.TrimSpace(rootID)
	taskNumberRaw = strings.TrimSpace(strings.TrimPrefix(taskNumberRaw, "#"))
	if rootID == "" {
		return errors.New("root id argument required: mindfs <rootid> -task <task_number>")
	}
	taskNumber, err := strconv.Atoi(taskNumberRaw)
	if err != nil || taskNumber <= 0 {
		return errors.New("task number must be a positive integer")
	}
	if action == "" {
		return errors.New("at most one task action allowed: -status, -next, or -prev")
	}
	token, err := app.ReadLocalCLIToken(addr)
	if err != nil {
		return err
	}
	taskID, detail, err := fetchTaskDetailByNumber(addr, useTLS, token, rootID, taskNumber)
	if err != nil {
		return err
	}
	if action == "status" {
		_, err = os.Stdout.Write(detail)
		if err == nil {
			fmt.Fprintln(os.Stdout)
		}
		return err
	}
	payload, err := json.Marshal(map[string]any{"root_id": rootID})
	if err != nil {
		return err
	}
	path := "/api/tasks/" + url.PathEscape(taskID) + "/" + action
	req, err := http.NewRequest(http.MethodPost, addrToURL(addr, path, useTLS), bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
	req.Header.Set("Content-Type", "application/json")
	client := newHTTPClient(useTLS, 10*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("task command failed: %s", httpErrorMessage(resp))
	}
	_, err = io.Copy(os.Stdout, resp.Body)
	if err == nil {
		fmt.Fprintln(os.Stdout)
	}
	return err
}

func fetchTaskDetailByNumber(addr string, useTLS bool, token, rootID string, taskNumber int) (string, json.RawMessage, error) {
	query := url.Values{}
	query.Set("root", rootID)
	query.Set("task_number", strconv.Itoa(taskNumber))
	query.Set("limit", "1")
	req, err := http.NewRequest(http.MethodGet, addrToURL(addr, "/api/tasks?"+query.Encode(), useTLS), nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
	client := newHTTPClient(useTLS, 10*time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", nil, fmt.Errorf("task lookup failed: %s", httpErrorMessage(resp))
	}
	var list taskCLIListResponse
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return "", nil, err
	}
	if len(list.Items) == 0 {
		return "", nil, fmt.Errorf("task #%d not found in root %s", taskNumber, rootID)
	}
	var header taskCLIDetailHeader
	if err := json.Unmarshal(list.Items[0], &header); err != nil {
		return "", nil, err
	}
	if strings.TrimSpace(header.Task.ID) == "" || header.Task.TaskNumber != taskNumber {
		return "", nil, fmt.Errorf("invalid task lookup response for #%d", taskNumber)
	}
	return header.Task.ID, list.Items[0], nil
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

func startRelayBinding(addr string, useTLS bool) (relayStatusResponse, error) {
	token, err := app.ReadLocalCLIToken(addr)
	if err != nil {
		return relayStatusResponse{}, err
	}
	endpoint := addrToURL(addr, "/api/relay/bind/start", useTLS)
	client := newHTTPClient(useTLS, 3*time.Second)
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		return relayStatusResponse{}, err
	}
	req.Header.Set("X-MindFS-Local-CLI-Token", token)
	resp, err := client.Do(req)
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
		return relayStatusResponse{}, fmt.Errorf("failed to start relay binding: %s", message)
	}
	var out relayStatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return relayStatusResponse{}, err
	}
	return out, nil
}

func printRelayBindTarget(w io.Writer, addr string, useTLS bool, rootID string) error {
	status, err := startRelayBinding(addr, useTLS)
	if err != nil {
		return err
	}
	if status.NoRelayer {
		return errors.New("relay integration is disabled")
	}
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
		fmt.Fprintln(w, "Relay already bound:")
		fmt.Fprintln(w, u.String())
		return nil
	}
	pendingCode := strings.TrimSpace(status.PendingCode)
	relayBaseURL := strings.TrimSpace(status.RelayBaseURL)
	if pendingCode == "" || relayBaseURL == "" {
		return errors.New("relay bind URL unavailable")
	}
	u, err := url.Parse(strings.TrimSuffix(relayBaseURL, "/") + "/bind")
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("code", pendingCode)
	if strings.TrimSpace(rootID) != "" {
		q.Set("root", rootID)
	}
	if nodeName := strings.TrimSpace(status.NodeName); nodeName != "" {
		q.Set("node_name", nodeName)
	}
	u.RawQuery = q.Encode()
	fmt.Fprintln(w, "Open this URL in a browser to bind relay:")
	fmt.Fprintln(w, u.String())
	return nil
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
		return fmt.Errorf("%w; open this URL manually: %s; you can run `mindfs -bind-relay` to get a relay binding URL and access MindFS from the public internet after binding", errBrowserUnavailable, target)
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
