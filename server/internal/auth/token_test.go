package auth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGenerate_Uniqueness(t *testing.T) {
	a, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("two successive Generate() calls returned the same token: %q", a)
	}
	// 32 bytes hex-encoded = 64 chars.
	if len(a) != 64 {
		t.Errorf("want 64-char hex token, got %d chars", len(a))
	}
	if strings.TrimFunc(string(a), isHex) != "" {
		t.Errorf("token contains non-hex chars: %q", a)
	}
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

func TestToken_Equals(t *testing.T) {
	tk := Token("aaaa")
	if !tk.Equals("aaaa") {
		t.Error("Equals should accept exact match")
	}
	if tk.Equals("aaab") {
		t.Error("Equals should reject different value of same length")
	}
	if tk.Equals("") {
		t.Error("Equals should reject empty string")
	}
	if tk.Equals("aaaaa") {
		t.Error("Equals should reject different length")
	}
}

func TestWriteAndReadFile_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "token")

	tk := Token("0123456789abcdef")
	if err := WriteFile(path, tk); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	// POSIX perm bits are advisory on Windows; assert only on POSIX.
	if runtime.GOOS != "windows" {
		got := info.Mode().Perm()
		if got != 0o600 {
			t.Errorf("token file perm = %04o, want 0600", got)
		}
	}

	got, err := ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if got != tk {
		t.Errorf("round-trip mismatch: got %q, want %q", got, tk)
	}
}

func TestWriteFile_Overwrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")

	if err := WriteFile(path, "first"); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, "second"); err != nil {
		t.Fatal(err)
	}

	got, err := ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "second" {
		t.Errorf("after overwrite, got %q, want %q", got, "second")
	}

	// Ensure the temp file didn't leak in the same directory.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".token-") {
			t.Errorf("leftover temp file after WriteFile: %q", e.Name())
		}
	}
}
