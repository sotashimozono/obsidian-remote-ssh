package extensions

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestVerifyToolBinary_DetectsTamperingAfterLoad(t *testing.T) {
	dir := t.TempDir()
	binPath := filepath.Join(dir, "tool.bin")
	seed := []byte("tool-v1")
	if err := os.WriteFile(binPath, seed, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(seed)
	manifest := fmt.Sprintf(`{"version":1,"extensions":[{"tool":"x","command":%q,"sha256":%q}]}`,
		binPath, hex.EncodeToString(sum[:]))
	manifestPath := filepath.Join(dir, "capabilities.json")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}

	mgr, err := LoadAndVerify(manifestPath)
	if err != nil {
		t.Fatalf("LoadAndVerify: %v", err)
	}

	if err := os.WriteFile(binPath, []byte("tool-v2-tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := mgr.VerifyToolBinary("x"); err == nil {
		t.Fatalf("expected tamper detection error")
	}
}
