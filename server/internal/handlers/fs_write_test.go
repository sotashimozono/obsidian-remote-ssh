package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// writeVault is a minimal fixture for write-side tests. It just
// returns a fresh temp dir; each test seeds whatever it needs.
func writeVault(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

// ─── fs.write ────────────────────────────────────────────────────────────

func TestFsWrite_CreatesFile(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "note.md", Content: "# hello"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	got, ok := result.(proto.MtimeResult)
	if !ok {
		t.Fatalf("result type = %T, want MtimeResult", result)
	}
	if got.Mtime <= 0 {
		t.Errorf("mtime = %d, want positive", got.Mtime)
	}
	data, err := os.ReadFile(filepath.Join(root, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "# hello" {
		t.Errorf("disk content = %q, want %q", data, "# hello")
	}
}

func TestFsWrite_AutoCreatesParentDirs(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "docs/sub/a.md", Content: "x"})
	_, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(filepath.Join(root, "docs", "sub", "a.md")); err != nil {
		t.Errorf("expected docs/sub/a.md to exist: %v", err)
	}
}

func TestFsWrite_Overwrites(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw1, _ := json.Marshal(proto.WriteTextParams{Path: "a.md", Content: "one"})
	if _, err := h(context.Background(), raw1); err != nil {
		t.Fatal(err)
	}
	raw2, _ := json.Marshal(proto.WriteTextParams{Path: "a.md", Content: "two"})
	if _, err := h(context.Background(), raw2); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(root, "a.md"))
	if string(data) != "two" {
		t.Errorf("disk = %q, want %q", data, "two")
	}
}

func TestFsWrite_ExpectedMtimeFailsWhenDrifted(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	// Seed an existing file, then attempt a write with a bogus mtime.
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("seed"), 0o644); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "a.md", Content: "updated", ExpectedMtime: 1})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPreconditionFailed {
		t.Fatalf("want PreconditionFailed, got %+v", rerr)
	}
	// File must be untouched.
	data, _ := os.ReadFile(filepath.Join(root, "a.md"))
	if string(data) != "seed" {
		t.Errorf("file changed despite failed precondition; got %q", data)
	}
}

func TestFsWrite_ExpectedMtimeAcceptsNewFile(t *testing.T) {
	// expectedMtime on a non-existent target is treated as "no constraint
	// required — there's nothing to race". This matches the TS adapter's
	// semantics where the client assumes "I think this file is new; create
	// it atomically".
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "new.md", Content: "fresh", ExpectedMtime: 12345})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
}

func TestFsWrite_PathOutsideVault(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "../sneaky.txt", Content: "x"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

// ─── fs.writeBinary ──────────────────────────────────────────────────────

func TestFsWriteBinary_RoundTrip(t *testing.T) {
	root := writeVault(t)
	h := FsWriteBinary(root, nil)
	bytes := []byte{0x00, 0x01, 0x02, 0xff, 0xfe}
	raw, _ := json.Marshal(proto.WriteBinaryParams{
		Path:          "blob.bin",
		ContentBase64: base64.StdEncoding.EncodeToString(bytes),
	})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	got, _ := os.ReadFile(filepath.Join(root, "blob.bin"))
	if len(got) != len(bytes) {
		t.Fatalf("size = %d, want %d", len(got), len(bytes))
	}
	for i := range bytes {
		if got[i] != bytes[i] {
			t.Errorf("byte[%d] = %#x, want %#x", i, got[i], bytes[i])
		}
	}
}

func TestFsWriteBinary_RejectsInvalidBase64(t *testing.T) {
	root := writeVault(t)
	h := FsWriteBinary(root, nil)
	raw, _ := json.Marshal(proto.WriteBinaryParams{
		Path:          "blob.bin",
		ContentBase64: "not-valid-base64-@@@",
	})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams, got %+v", rerr)
	}
}

// ─── fs.append ───────────────────────────────────────────────────────────

func TestFsAppend_ToNewFile(t *testing.T) {
	root := writeVault(t)
	h := FsAppend(root)
	raw, _ := json.Marshal(proto.AppendTextParams{Path: "log.md", Content: "line 1\n"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	data, _ := os.ReadFile(filepath.Join(root, "log.md"))
	if string(data) != "line 1\n" {
		t.Errorf("disk = %q, want %q", data, "line 1\n")
	}
}

func TestFsAppend_ToExistingFile(t *testing.T) {
	root := writeVault(t)
	if err := os.WriteFile(filepath.Join(root, "log.md"), []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsAppend(root)
	raw, _ := json.Marshal(proto.AppendTextParams{Path: "log.md", Content: "second\n"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	data, _ := os.ReadFile(filepath.Join(root, "log.md"))
	if string(data) != "first\nsecond\n" {
		t.Errorf("disk = %q, want %q", data, "first\nsecond\n")
	}
}

func TestFsAppend_ParentMissingReturnsFileNotFound(t *testing.T) {
	root := writeVault(t)
	h := FsAppend(root)
	raw, _ := json.Marshal(proto.AppendTextParams{Path: "nonexistent-dir/log.md", Content: "x"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound (parent missing), got %+v", rerr)
	}
}

// ─── fs.appendBinary ─────────────────────────────────────────────────────

func TestFsAppendBinary_Concatenates(t *testing.T) {
	root := writeVault(t)
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0x01, 0x02}, 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsAppendBinary(root)
	raw, _ := json.Marshal(proto.AppendBinaryParams{
		Path:          "blob.bin",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte{0x03, 0x04}),
	})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	data, _ := os.ReadFile(filepath.Join(root, "blob.bin"))
	if len(data) != 4 || data[0] != 0x01 || data[1] != 0x02 || data[2] != 0x03 || data[3] != 0x04 {
		t.Errorf("disk = %v, want [1 2 3 4]", data)
	}
}

// A sanity check on atomicWriteFile's tmp cleanup: the temp file name
// should never leak into the parent dir after either a successful or
// failing write.
func TestAtomicWriteFile_NoTmpLeftovers(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "docs/a.md", Content: "hi"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatal(rerr)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "docs"))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".rsh-write-") {
			t.Errorf("leftover temp file after successful write: %s", e.Name())
		}
	}
}
