// Package auth owns the session token that proves a connecting client
// is the same user that started the daemon. The token is generated
// once at startup, written to a file the user owns (POSIX mode 0600),
// and read by the plugin over the same SSH session that started the
// daemon. Tokens are not rotated during a session.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Token is a hex-encoded random string backing a single server run.
type Token string

// Generate returns a 32-byte cryptographically random token as hex.
func Generate() (Token, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("auth: generate token: %w", err)
	}
	return Token(hex.EncodeToString(b[:])), nil
}

// Equals performs a constant-time comparison against another string.
// Both arguments may be of different lengths; a mismatch never falls
// back to early-exit comparison.
func (t Token) Equals(other string) bool {
	return subtle.ConstantTimeCompare([]byte(t), []byte(other)) == 1
}

// WriteFile persists the token to path with mode 0600. Any parent
// directory is created with mode 0700 if missing; the file itself is
// truncated + rewritten atomically via a sibling temp file + rename.
// Existing tokens are replaced silently.
func WriteFile(path string, t Token) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("auth: mkdir %q: %w", dir, err)
	}
	// Create a sibling tmp with the same mode so the eventual rename
	// never exposes a file with looser perms.
	tmp, err := os.CreateTemp(dir, ".token-*")
	if err != nil {
		return fmt.Errorf("auth: tempfile: %w", err)
	}
	// On any error below, do our best to remove the tmp.
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	if err := os.Chmod(tmpPath, 0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("auth: chmod %q: %w", tmpPath, err)
	}
	if _, err := tmp.WriteString(string(t)); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("auth: write %q: %w", tmpPath, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("auth: close %q: %w", tmpPath, err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("auth: rename %q → %q: %w", tmpPath, path, err)
	}
	// os.Rename doesn't preserve mode on all platforms; reassert.
	if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("auth: chmod %q: %w", path, err)
	}
	return nil
}

// ReadFile loads a token previously written by WriteFile.
func ReadFile(path string) (Token, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("auth: read %q: %w", path, err)
	}
	return Token(b), nil
}
