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
	"strings"
	"syscall"
	"time"

	"mindfs/server/app"
)

func main() {
	addr := flag.String("addr", ":7331", "listen address")
	web := flag.Bool("web", true, "start web dev server")
	webDir := flag.String("web-dir", "web", "web project directory")
	staticDir := flag.String("static-dir", "web/dist", "directory for serving built web assets on the backend port")
	bindCode := flag.String("bind-code", "", "relay bind code for activation/binding")
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
		if strings.TrimSpace(*bindCode) != "" {
			if err := bindRelay(*addr, *bindCode); err != nil {
				fmt.Fprintln(os.Stderr, err.Error())
				os.Exit(1)
			}
			fmt.Fprintln(os.Stdout, "relay bind applied")
		}
		if err := addManagedDir(*addr, absRoot); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		fmt.Fprintln(os.Stdout, "added managed directory:", absRoot)
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- app.Start(ctx, *addr, app.StartOptions{
			StaticDir: *staticDir,
			BindCode:  *bindCode,
		})
	}()
	if err := waitForServer(*addr, 8*time.Second); err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	if err := addManagedDir(*addr, absRoot); err != nil {
		cancel()
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	fmt.Fprintln(os.Stdout, "added managed directory:", absRoot)

	if *web {
		if err := startWeb(ctx, *webDir); err != nil {
			cancel()
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
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

func addManagedDir(addr, path string) error {
	url := addrToURL(addr, "/api/dirs")
	body, err := json.Marshal(map[string]any{"path": path})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	return fmt.Errorf("failed to add managed directory: %s", resp.Status)
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

func bindRelay(addr, bindCode string) error {
	url := addrToURL(addr, "/api/relay/bind")
	body, err := json.Marshal(map[string]any{"bind_code": bindCode})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
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
	return fmt.Errorf("failed to bind relay: %s", message)
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
