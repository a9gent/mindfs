// Package tlsutil provides utilities for TLS certificate management,
// specifically self-signed certificate generation for local development.
package tlsutil

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// EnsureCert resolves TLS certificate and key file paths.
// If certFile and keyFile are both non-empty, they are used as-is
// (caller must ensure they exist).
// Otherwise, a self-signed certificate is generated under
// os.UserConfigDir/mindfs/ and reused across restarts.
func EnsureCert(certFile, keyFile string) (string, string, error) {
	if certFile != "" && keyFile != "" {
		return certFile, keyFile, nil
	}

	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", "", fmt.Errorf("cannot determine user config dir: %w", err)
	}
	certPath := filepath.Join(configDir, "mindfs", "cert.pem")
	keyPath := filepath.Join(configDir, "mindfs", "key.pem")

	_, certErr := os.Stat(certPath)
	_, keyErr := os.Stat(keyPath)
	if certErr == nil && keyErr == nil {
		return certPath, keyPath, nil
	}

	if err := GenerateCert(certPath, keyPath); err != nil {
		return "", "", fmt.Errorf("failed to generate self-signed certificate: %w", err)
	}
	return certPath, keyPath, nil
}

// GenerateCert creates a self-signed ECDSA P-256 certificate and key,
// writing them atomically to certPath and keyPath. The certificate includes
// SANs for localhost, 127.0.0.1, ::1, and all non-loopback, non-link-local
// interface IPs so that LAN clients don't see certificate name mismatches.
func GenerateCert(certPath, keyPath string) error {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}

	ips, err := collectInterfaceIPs()
	if err != nil {
		return err
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}

	notBefore := time.Now()
	notAfter := notBefore.Add(10 * 365 * 24 * time.Hour)

	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName: "mindfs-local",
		},
		NotBefore: notBefore,
		NotAfter:  notAfter,
		DNSNames:  []string{"localhost"},
		IPAddresses: ips,
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &priv.PublicKey, priv)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyBytes, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyBytes})

	if err := atomicWrite(certPath, certPEM, 0o644); err != nil {
		return err
	}
	return atomicWrite(keyPath, keyPEM, 0o600)
}

func collectInterfaceIPs() ([]net.IP, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	ips := []net.IP{
		net.ParseIP("127.0.0.1"),
		net.ParseIP("::1"),
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			ips = append(ips, ip)
		}
	}
	return ips, nil
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".tmpcert-*")
	if err != nil {
		return err
	}
	tmpName := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmpName)
		return err
	}
	if err := f.Chmod(perm); err != nil {
		f.Close()
		os.Remove(tmpName)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}
