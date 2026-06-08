//go:build ignore

package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type manifest struct {
	Version   string     `json:"version"`
	Repo      string     `json:"repo,omitempty"`
	Artifacts []artifact `json:"artifacts"`
}

type signedManifest struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type artifact struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

func main() {
	version := flag.String("version", "", "release tag, for example v1.2.3")
	distDir := flag.String("dist", "dist", "directory containing release artifacts")
	repo := flag.String("repo", "a9gent/mindfs", "repository name recorded in the manifest")
	privateKeyValue := flag.String("private-key", "", "base64 Ed25519 private key seed or private key")
	privateKeyFile := flag.String("private-key-file", "", "file containing base64 Ed25519 private key seed or private key")
	flag.Parse()

	if strings.TrimSpace(*version) == "" {
		fatal(errors.New("-version is required"))
	}
	privateKey, err := loadPrivateKey(*privateKeyValue, *privateKeyFile)
	if err != nil {
		fatal(err)
	}
	manifestPath, err := writeManifest(*distDir, normalizeTag(*version), *repo, privateKey)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("Signed release manifest: %s\n", manifestPath)
}

func writeManifest(distDir, version, repo string, privateKey ed25519.PrivateKey) (string, error) {
	patterns := []string{
		filepath.Join(distDir, fmt.Sprintf("mindfs_%s_*.tar.gz", version)),
		filepath.Join(distDir, fmt.Sprintf("mindfs_%s_*.zip", version)),
		filepath.Join(distDir, fmt.Sprintf("mindfs_%s_*.apk", version)),
		filepath.Join(distDir, fmt.Sprintf("mindfs_%s_*.hap", version)),
	}
	var paths []string
	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			return "", err
		}
		paths = append(paths, matches...)
	}
	sort.Strings(paths)
	if len(paths) == 0 {
		return "", fmt.Errorf("no artifacts found for %s in %s", version, distDir)
	}

	out := manifest{Version: version, Repo: strings.TrimSpace(repo)}
	for _, path := range paths {
		sum, size, err := fileSHA256(path)
		if err != nil {
			return "", err
		}
		out.Artifacts = append(out.Artifacts, artifact{
			Name:   filepath.Base(path),
			SHA256: hex.EncodeToString(sum),
			Size:   size,
		})
	}

	payload, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return "", err
	}
	payload = append(payload, '\n')
	signature := ed25519.Sign(privateKey, payload)
	envelope := signedManifest{
		Payload:   base64.StdEncoding.EncodeToString(payload),
		Signature: base64.StdEncoding.EncodeToString(signature),
	}
	body, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return "", err
	}
	body = append(body, '\n')
	manifestPath := filepath.Join(distDir, fmt.Sprintf("mindfs_%s_manifest.json", version))
	if err := os.WriteFile(manifestPath, body, 0o644); err != nil {
		return "", err
	}
	return manifestPath, nil
}

func loadPrivateKey(value, file string) (ed25519.PrivateKey, error) {
	value = strings.TrimSpace(value)
	file = strings.TrimSpace(file)
	if value == "" && file != "" {
		body, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		value = strings.TrimSpace(string(body))
	}
	if value == "" {
		value = strings.TrimSpace(os.Getenv("MINDFS_RELEASE_PRIVATE_KEY"))
	}
	if value == "" {
		if path := strings.TrimSpace(os.Getenv("MINDFS_RELEASE_PRIVATE_KEY_FILE")); path != "" {
			body, err := os.ReadFile(path)
			if err != nil {
				return nil, err
			}
			value = strings.TrimSpace(string(body))
		}
	}
	if value == "" {
		return nil, errors.New("release private key is required")
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil {
		return nil, fmt.Errorf("release private key is not valid base64: %w", err)
	}
	switch len(raw) {
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(raw), nil
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(raw), nil
	default:
		return nil, fmt.Errorf("release private key length = %d, want %d-byte seed or %d-byte private key", len(raw), ed25519.SeedSize, ed25519.PrivateKeySize)
	}
}

func fileSHA256(path string) ([]byte, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return nil, 0, err
	}
	return hash.Sum(nil), size, nil
}

func normalizeTag(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(value, "v"))
	if value == "" {
		return ""
	}
	return "v" + value
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "Error:", err)
	os.Exit(1)
}
