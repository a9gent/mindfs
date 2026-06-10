package app

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/config"
)

const localCLITokenBytes = 32

type localCLITokenStore struct {
	Tokens map[string]string `json:"tokens"`
}

func EnsureLocalCLIToken(addr string) (string, error) {
	token, err := newLocalCLIToken()
	if err != nil {
		return "", err
	}
	path, err := localCLITokenStorePath()
	if err != nil {
		return "", err
	}
	store, err := readLocalCLITokenStore(path)
	if err != nil {
		return "", err
	}
	store.Tokens[localCLITokenKey(addr)] = token
	if err := writeLocalCLITokenStore(path, store); err != nil {
		return "", err
	}
	return token, nil
}

func ReadLocalCLIToken(addr string) (string, error) {
	path, err := localCLITokenStorePath()
	if err != nil {
		return "", err
	}
	store, err := readLocalCLITokenStore(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(store.Tokens[localCLITokenKey(addr)])
	if token == "" {
		return "", fmt.Errorf("local CLI token not found for %s", addr)
	}
	return token, nil
}

func readLocalCLITokenStore(path string) (localCLITokenStore, error) {
	store := localCLITokenStore{Tokens: make(map[string]string)}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store, nil
		}
		return localCLITokenStore{}, err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return store, nil
	}
	if err := json.Unmarshal(raw, &store); err != nil {
		return localCLITokenStore{}, err
	}
	if store.Tokens == nil {
		store.Tokens = make(map[string]string)
	}
	return store, nil
}

func writeLocalCLITokenStore(path string, store localCLITokenStore) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func newLocalCLIToken() (string, error) {
	var raw [localCLITokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func localCLITokenStorePath() (string, error) {
	dir, err := config.MindFSConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "local-cli-tokens.json"), nil
}

func localCLITokenKey(addr string) string {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "127.0.0.1:7331"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		host = "127.0.0.1"
		port = strings.TrimPrefix(addr, ":")
	}
	if strings.TrimSpace(host) == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	if strings.TrimSpace(port) == "" {
		port = "7331"
	}
	return net.JoinHostPort(host, port)
}
