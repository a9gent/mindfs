package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"mindfs/server/app"
)

var version = "dev"

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
		fmt.Fprintf(out, "  mindfs -web=true\n")
		fmt.Fprintf(out, "  mindfs -addr :9000 /path/to/project\n")
		fmt.Fprintf(out, "  mindfs -remove /path/to/project\n")
	}

	addr := flag.String("addr", ":7331", "listen address")
	web := flag.Bool("web", false, "start the web dev server (development only)")
	webDir := flag.String("web-dir", "web", "web project directory")
	staticDir := flag.String("static-dir", "web/dist", "directory for serving built web assets on the backend port")
	noRelayer := flag.Bool("no-relayer", false, "disable relay integration")
	remove := flag.Bool("remove", false, "remove the managed directory")
	flag.Parse()

	root := "."
	if flag.NArg() > 0 {
		root = flag.Arg(0)
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	if *remove {
		if err := handleRemoveRoot(*addr, absRoot); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "removed managed directory:", absRoot)
		return
	}

	if serverRunning(*addr) {
		fmt.Fprintf(os.Stdout, "server already running on %s, reusing existing process\n", *addr)
		rootInfo, err := addManagedDir(*addr, absRoot)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)
		if err := openTarget(*addr, *web, rootInfo.ID); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
		}
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Start(ctx, *addr, app.StartOptions{
			StaticDir: *staticDir,
			NoRelayer: *noRelayer,
			Version:   version,
			Args:      os.Args[1:],
		})
	}()
	if err := waitForServer(*addr, 8*time.Second); err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	rootInfo, err := addManagedDir(*addr, absRoot)
	if err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	fmt.Fprintln(os.Stdout, "added managed directory:", rootInfo.RootPath)

	if *web {
		if err := startWeb(ctx, *webDir); err != nil {
			cancel()
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
	}
	if err := openTarget(*addr, *web, rootInfo.ID); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
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

func serverRunning(addr string) bool {
	url := addrToURL(addr, "/health")
	client := &http.Client{Timeout: 800 * time.Millisecond}
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

func addManagedDir(addr, path string) (managedDirResponse, error) {
	url := addrToURL(addr, "/api/dirs")
	body, err := json.Marshal(map[string]any{"path": path})
	if err != nil {
		return managedDirResponse{}, err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return managedDirResponse{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 3 * time.Second}
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
	return managedDirResponse{}, fmt.Errorf("failed to add managed directory: %s", resp.Status)
}

func removeManagedDir(addr, path string) error {
	endpoint := addrToURL(addr, "/api/dirs?path="+url.QueryEscape(path))
	req, err := http.NewRequest(http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	payload, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	message := strings.TrimSpace(string(payload))
	if message == "" {
		message = resp.Status
	}
	return fmt.Errorf("failed to remove managed directory: %s", message)
}

func removeManagedDirFromRegistry(path string) error {
	return app.RemoveManagedDirFromRegistry(path)
}

func handleRemoveRoot(addr, path string) error {
	if serverRunning(addr) {
		return removeManagedDir(addr, path)
	}
	return removeManagedDirFromRegistry(path)
}

func fetchRelayStatus(addr string) (relayStatusResponse, error) {
	url := addrToURL(addr, "/api/relay/status")
	client := &http.Client{Timeout: 3 * time.Second}
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

func openTarget(addr string, web bool, rootID string) error {
	status, err := fetchRelayStatus(addr)
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
		target = localOpenURL(addr, web, rootID)
	}
	return openBrowser(target)
}

func localOpenURL(addr string, web bool, rootID string) string {
	base := addrToURL(addr, "")
	if web {
		base = "http://localhost:5173"
	}
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

func addrToURL(addr, path string) string {
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
	if port == "" {
		port = "7331"
	}
	return fmt.Sprintf("http://%s:%s%s", host, port, path)
}

func waitForServer(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if serverRunning(addr) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server did not become ready on %s within %s", addr, timeout)
}

func startWeb(ctx context.Context, dir string) error {
	cmd := exec.CommandContext(ctx, "npm", "run", "dev")
	cmd.Dir = dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}
