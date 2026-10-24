package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// Far from "now", so no test passes because btime or mtime is close.
const seededCreated int64 = 1_600_000_000_000

// seedCreated writes root/rel and stamps the xattr, skipping the test
// where the filesystem has no user xattrs.
func seedCreated(t *testing.T, root, rel, content string) string {
	t.Helper()
	abs := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeCreatedXattr(abs, seededCreated); err != nil {
		t.Skipf("filesystem has no user xattrs (%v)", err)
	}
	return abs
}

// requireXattrs skips the test unless user xattrs can be set on abs.
func requireXattrs(t *testing.T, abs string) {
	t.Helper()
	const probe = "user.obsidian-remote.probe"
	if err := setXattr(abs, probe, []byte("1")); err != nil {
		t.Skipf("filesystem has no user xattrs (%v)", err)
	}
	_ = removeXattr(abs, probe)
}

func TestCreatedMillis_PrefersXattr(t *testing.T) {
	root := t.TempDir()
	abs := seedCreated(t, root, "a.md", "x")
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got != seededCreated {
		t.Errorf("createdMillis = %d, want xattr value %d", got, seededCreated)
	}
}

func TestCreatedMillis_FallsBackToBirthOrMtime(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "a.md")
	if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	got := createdMillis(abs, info)
	if birth, ok := birthMillis(abs, info); ok {
		if want := min(birth, mtimeMillis(info)); got != want {
			t.Errorf("createdMillis = %d, want btime %d", got, want)
		}
	} else if got != mtimeMillis(info) {
		t.Errorf("createdMillis = %d, want mtime fallback %d", got, mtimeMillis(info))
	}
}

// Copied vaults keep mtimes but get fresh birth times.
func TestCreatedMillis_ClampsBirthToMtime(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "old.md")
	if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.UnixMilli(1_500_000_000_000)
	if err := os.Chtimes(abs, old, old); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got != old.UnixMilli() {
		t.Errorf("createdMillis = %d, want mtime %d (birth postdates it)", got, old.UnixMilli())
	}
}

// The plugin ignores folder ctimes, so directories skip the lookups.
func TestCreatedMillis_DirectoryIsMtime(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "sub")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	requireXattrs(t, dir)
	if err := writeCreatedXattr(dir, seededCreated); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(dir, info); got != mtimeMillis(info) {
		t.Errorf("createdMillis(dir) = %d, want mtime %d", got, mtimeMillis(info))
	}
}

// cp -a / rsync -X copy the xattr onto a new inode.
func TestCreatedMillis_IgnoresXattrCopiedToAnotherInode(t *testing.T) {
	root := t.TempDir()
	src := seedCreated(t, root, "old.md", "x")
	raw := make([]byte, 64)
	n, err := getXattr(src, createdXattr, raw)
	if err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(root, "copy.md")
	if err := os.WriteFile(dst, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := setXattr(dst, createdXattr, raw[:n]); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(dst, info); got == seededCreated {
		t.Errorf("copy reports the original's created %d; want its own", got)
	}
}

// Without an inode tag, a value can't be told apart from a copy.
func TestCreatedMillis_IgnoresUntaggedXattr(t *testing.T) {
	root := t.TempDir()
	abs := seedCreated(t, root, "a.md", "x")
	if err := setXattr(abs, createdXattr, []byte("1600000000000")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got == seededCreated {
		t.Errorf("untagged xattr was trusted (%d)", got)
	}
}

func TestCreatedMillis_IgnoresGarbageXattr(t *testing.T) {
	root := t.TempDir()
	abs := seedCreated(t, root, "a.md", "x")
	if err := setXattr(abs, createdXattr, []byte("not-a-number")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got == 0 {
		t.Errorf("createdMillis = 0, want a btime / mtime fallback")
	}
}

// tmp+rename swaps the inode; the xattr must carry the creation time.
func TestAtomicWriteFile_PreservesCreatedAcrossOverwrite(t *testing.T) {
	root := t.TempDir()
	abs := seedCreated(t, root, "note.md", "v1")

	if _, _, rerr := atomicWriteFile(abs, "note.md", []byte("v2"), 0); rerr != nil {
		t.Fatalf("atomicWriteFile: %+v", rerr)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got != seededCreated {
		t.Errorf("created after overwrite = %d, want %d", got, seededCreated)
	}
}

// With no xattr yet, the first overwrite carries the birth time over.
func TestAtomicWriteFile_CarriesBirthTimeOnFirstOverwrite(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "note.md")
	if err := os.WriteFile(abs, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireXattrs(t, abs)
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	before := createdMillis(abs, info)

	time.Sleep(20 * time.Millisecond)
	if _, _, rerr := atomicWriteFile(abs, "note.md", []byte("v2"), 0); rerr != nil {
		t.Fatalf("atomicWriteFile: %+v", rerr)
	}
	info, err = os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	if got := createdMillis(abs, info); got != before {
		t.Errorf("created after overwrite = %d, want original %d", got, before)
	}
}

func TestFsStat_ReportsCreated(t *testing.T) {
	root := t.TempDir()
	seedCreated(t, root, "a.md", "x")
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "a.md"})
	result, rerr := FsStat(root)(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if got := result.(proto.Stat).Created; got != seededCreated {
		t.Errorf("Stat.Created = %d, want %d", got, seededCreated)
	}
}

func TestFsList_ReportsCreated(t *testing.T) {
	root := t.TempDir()
	seedCreated(t, root, "a.md", "x")
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: ""})
	result, rerr := FsList(root)(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	entries := result.(proto.ListResult).Entries
	if len(entries) != 1 || entries[0].Created != seededCreated {
		t.Errorf("entries = %+v, want one entry with Created %d", entries, seededCreated)
	}
}

func TestFsWalk_ReportsCreated(t *testing.T) {
	root := t.TempDir()
	seedCreated(t, root, "sub/a.md", "x")
	raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: true})
	result, rerr := FsWalk(root)(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	for _, e := range result.(proto.WalkResult).Entries {
		if e.Path == "sub/a.md" {
			if e.Created != seededCreated {
				t.Errorf("WalkEntry.Created = %d, want %d", e.Created, seededCreated)
			}
			return
		}
	}
	t.Errorf("sub/a.md missing from walk")
}

// The xattr is best-effort: failing to read or write it must not fail
// the write.
func TestAtomicWriteFile_SucceedsWhenXattrsFail(t *testing.T) {
	root := t.TempDir()
	abs := filepath.Join(root, "note.md")
	if err := os.WriteFile(abs, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	origGet, origSet := getXattr, setXattr
	t.Cleanup(func() { getXattr, setXattr = origGet, origSet })
	getXattr = func(string, string, []byte) (int, error) { return 0, errors.New("xattr read failed") }
	setXattr = func(string, string, []byte) error { return errors.New("xattr write failed") }

	if _, _, rerr := atomicWriteFile(abs, "note.md", []byte("v2"), 0); rerr != nil {
		t.Fatalf("atomicWriteFile: %+v", rerr)
	}
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "v2" {
		t.Errorf("content = %q, want %q", got, "v2")
	}
}

func TestCreatedHelpers_ErrorPaths(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing.md")

	if err := writeCreatedXattr(missing, seededCreated); err == nil {
		t.Error("writeCreatedXattr on a missing file: want error")
	}
	if _, ok := birthMillis(missing, nil); ok {
		t.Error("birthMillis on a missing file: want ok=false")
	}
	if _, ok := inodeOf(fakeInfo{}); ok {
		t.Error("inodeOf without a Stat_t: want ok=false")
	}

	// Right inode tag, unparsable timestamp.
	abs := seedCreated(t, root, "a.md", "x")
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	ino, _ := inodeOf(info)
	if err := setXattr(abs, createdXattr, []byte(fmt.Sprintf("soon:%d", ino))); err != nil {
		t.Fatal(err)
	}
	if _, ok := readCreatedXattr(abs, info); ok {
		t.Error("readCreatedXattr with a non-numeric timestamp: want ok=false")
	}
	if _, ok := readCreatedXattr(abs, fakeInfo{}); ok {
		t.Error("readCreatedXattr without an inode: want ok=false")
	}
}

// fakeInfo is an os.FileInfo whose Sys() isn't a *syscall.Stat_t.
type fakeInfo struct{ os.FileInfo }

func (fakeInfo) Sys() any { return nil }
