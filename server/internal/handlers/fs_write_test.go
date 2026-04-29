package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/watcher"
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
	h := FsWrite(root, nil, nil)
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
	h := FsWrite(root, nil, nil)
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
	h := FsWrite(root, nil, nil)
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
	h := FsWrite(root, nil, nil)
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
	h := FsWrite(root, nil, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "new.md", Content: "fresh", ExpectedMtime: 12345})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
}

func TestFsWrite_PathOutsideVault(t *testing.T) {
	root := writeVault(t)
	h := FsWrite(root, nil, nil)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "../sneaky.txt", Content: "x"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

// ─── fs.writeBinary ──────────────────────────────────────────────────────

func TestFsWriteBinary_RoundTrip(t *testing.T) {
	root := writeVault(t)
	h := FsWriteBinary(root, nil, nil)
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
	h := FsWriteBinary(root, nil, nil)
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
	h := FsWrite(root, nil, nil)
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

// ─── #108 fix B: synthetic Modified after atomic-rename ──────────────────
//
// When an fs.write replaces an existing file via tmp+rename, the
// daemon must inject a synthetic Modified event into the watcher.
// Linux fsnotify drops IN_MOVED_TO when the watcher has been alive
// across an earlier write to the same parent dir, so without the
// injection the plugin's live-update fanout misses the change.
//
// These tests exercise the handler ↔ onModify wiring directly. The
// real watcher Inject is tested in the watcher package; here we just
// verify the handler invokes onModify with the correct path on
// overwrite, and skips it on fresh create.

func TestFsWrite_emitsSyntheticModifyOnExistingFile(t *testing.T) {
	root := writeVault(t)
	// Pre-create the target so the next write is an overwrite.
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("seed"), 0o644); err != nil {
		t.Fatal(err)
	}
	var injected []string
	h := FsWrite(root, nil, func(p string) { injected = append(injected, p) })
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "note.md", Content: "updated"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(injected) != 1 || injected[0] != "note.md" {
		t.Errorf("onModify calls = %v, want exactly [\"note.md\"]", injected)
	}
}

func TestFsWrite_doesNotEmitOnFreshCreate(t *testing.T) {
	root := writeVault(t)
	// Target does NOT exist before the write.
	var injected []string
	h := FsWrite(root, nil, func(p string) { injected = append(injected, p) })
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "fresh.md", Content: "hello"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(injected) != 0 {
		t.Errorf("onModify should not fire on fresh create; got %v", injected)
	}
}

func TestFsWriteBinary_emitsSyntheticModifyOnExistingFile(t *testing.T) {
	root := writeVault(t)
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0x00}, 0o644); err != nil {
		t.Fatal(err)
	}
	var injected []string
	h := FsWriteBinary(root, nil, func(p string) { injected = append(injected, p) })
	raw, _ := json.Marshal(proto.WriteBinaryParams{
		Path:          "blob.bin",
		ContentBase64: base64.StdEncoding.EncodeToString([]byte{0x01, 0x02}),
	})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(injected) != 1 || injected[0] != "blob.bin" {
		t.Errorf("onModify calls = %v, want exactly [\"blob.bin\"]", injected)
	}
}

func TestFsCopy_emitsSyntheticModifyWhenDestinationExists(t *testing.T) {
	root := writeVault(t)
	// Both source and destination exist; copy overwrites destination.
	if err := os.WriteFile(filepath.Join(root, "src.md"), []byte("src"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dst.md"), []byte("old-dst"), 0o644); err != nil {
		t.Fatal(err)
	}
	var injected []string
	h := FsCopy(root, func(p string) { injected = append(injected, p) })
	raw, _ := json.Marshal(proto.CopyParams{SrcPath: "src.md", DestPath: "dst.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(injected) != 1 || injected[0] != "dst.md" {
		t.Errorf("onModify calls = %v, want exactly [\"dst.md\"] (destination path)", injected)
	}
}

func TestFsCopy_doesNotEmitOnFreshDestination(t *testing.T) {
	root := writeVault(t)
	if err := os.WriteFile(filepath.Join(root, "src.md"), []byte("src"), 0o644); err != nil {
		t.Fatal(err)
	}
	var injected []string
	h := FsCopy(root, func(p string) { injected = append(injected, p) })
	raw, _ := json.Marshal(proto.CopyParams{SrcPath: "src.md", DestPath: "fresh-dst.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(injected) != 0 {
		t.Errorf("onModify should not fire when destination did not pre-exist; got %v", injected)
	}
}

// TestFsWrite_syntheticModifyReachesWatcherSubscriber wires the
// production-shape closure (calling Watcher.Inject) and asserts the
// injected event is delivered to a root-recursive subscriber. This
// is the end-to-end shape exercised by main.go.
//
// Tolerant of duplicate Modified events: the underlying fsnotify
// backend may also see the rename and fire its own Modified event.
// We require >=1 Modified for the path; the synthetic one is the
// contract.
func TestFsWrite_syntheticModifyReachesWatcherSubscriber(t *testing.T) {
	root := writeVault(t)
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("seed"), 0o644); err != nil {
		t.Fatal(err)
	}

	w, err := watcher.New(root)
	if err != nil {
		t.Fatalf("watcher.New: %v", err)
	}
	defer func() { _ = w.Close() }()

	var (
		mu     sync.Mutex
		events []watcher.Event
	)
	subID, err := w.Subscribe("", true, func(ev watcher.Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, ev)
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer w.Unsubscribe(subID)

	// Production-shape onModify closure: hand-wire what main.go
	// constructs — Inject a Modified event for the relative path.
	inject := func(rel string) {
		w.Inject(watcher.Event{Path: rel, Type: watcher.EventModified})
	}
	h := FsWrite(root, nil, inject)
	raw, _ := json.Marshal(proto.WriteTextParams{Path: "note.md", Content: "updated"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("fs.write: %+v", rerr)
	}

	// Wait briefly for fsnotify + injection to drain; the synthetic
	// path is dispatched on the watcher's own goroutine via emit().
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		mu.Lock()
		hit := false
		for _, ev := range events {
			if ev.Path == "note.md" && ev.Type == watcher.EventModified {
				hit = true
				break
			}
		}
		mu.Unlock()
		if hit {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	t.Fatalf("never observed Modified event for note.md; saw %v", events)
}
