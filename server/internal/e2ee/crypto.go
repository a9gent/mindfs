package e2ee

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const (
	InfoTransport = "transport"
)

type CipherEnvelope struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type DerivedKey struct {
	Transport []byte
}

func GenerateECDHKeypair() (*ecdh.PrivateKey, string, error) {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, "", err
	}
	return priv, base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes()), nil
}

func DecodePublicKey(encoded string) (*ecdh.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	return ecdh.P256().NewPublicKey(raw)
}

func BuildOpenProof(pairingSecret, nodeID, clientEphPK, clientNonce string) string {
	return buildProof(pairingSecret, "mindfs-e2ee-open", nodeID, clientEphPK, clientNonce)
}

func BuildAcceptProof(pairingSecret, nodeID, clientEphPK, nodeEphPK, clientNonce, serverNonce string) string {
	return buildProof(pairingSecret, "mindfs-e2ee-accept", nodeID, clientEphPK, nodeEphPK, clientNonce, serverNonce)
}

func buildProof(pairingSecret, label string, parts ...string) string {
	h := hmac.New(sha256.New, []byte(pairingSecret))
	sum := sha256.Sum256([]byte(joinParts(label, parts...)))
	_, _ = h.Write(sum[:])
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func VerifyProof(expected, provided string) bool {
	return hmac.Equal([]byte(expected), []byte(provided))
}

func BuildRequestProof(key []byte, method, path, ts, clientID string) string {
	h := hmac.New(sha256.New, key)
	sum := sha256.Sum256([]byte(joinParts("mindfs-request-proof", method, path, ts, clientID)))
	_, _ = h.Write(sum[:])
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func DeriveKey(pairingSecret, nodeID, clientEphPK, nodeEphPK, clientNonce, serverNonce string, localPriv *ecdh.PrivateKey, remotePub *ecdh.PublicKey) (DerivedKey, error) {
	sharedSecret, err := localPriv.ECDH(remotePub)
	if err != nil {
		return DerivedKey{}, err
	}
	infoHash := sha256.Sum256([]byte(joinParts("", nodeID, clientEphPK, nodeEphPK, clientNonce, serverNonce)))
	salt := sha256.Sum256([]byte(pairingSecret))
	sessionMaster, err := hkdfBytes(sharedSecret, salt[:], infoHash[:], 32)
	if err != nil {
		return DerivedKey{}, err
	}
	transportKey, err := hkdfBytes(sessionMaster, nil, []byte(InfoTransport), 32)
	if err != nil {
		return DerivedKey{}, err
	}
	return DerivedKey{Transport: transportKey}, nil
}

func EncryptJSON(key []byte, value any) (*CipherEnvelope, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return EncryptBytes(key, payload)
}

func EncryptBytes(key, plaintext []byte) (*CipherEnvelope, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, nil)
	return &CipherEnvelope{
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}, nil
}

func DecryptJSON(key []byte, envelope *CipherEnvelope, out any) error {
	plaintext, err := DecryptBytes(key, envelope)
	if err != nil {
		return err
	}
	return json.Unmarshal(plaintext, out)
}

func DecryptBytes(key []byte, envelope *CipherEnvelope) ([]byte, error) {
	if envelope == nil {
		return nil, errors.New("cipher envelope required")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce, err := base64.StdEncoding.DecodeString(envelope.Nonce)
	if err != nil {
		return nil, err
	}
	if len(nonce) != aead.NonceSize() {
		return nil, fmt.Errorf("invalid nonce size: %d", len(nonce))
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, err
	}
	return aead.Open(nil, nonce, ciphertext, nil)
}

func hkdfBytes(secret, salt, info []byte, length int) ([]byte, error) {
	reader := hkdf.New(sha256.New, secret, salt, info)
	out := make([]byte, length)
	if _, err := io.ReadFull(reader, out); err != nil {
		return nil, err
	}
	return out, nil
}

func joinParts(label string, parts ...string) string {
	buf := label
	for _, part := range parts {
		if buf != "" {
			buf += "\x1f"
		}
		buf += part
	}
	return buf
}
