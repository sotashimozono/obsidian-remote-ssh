package handlers

import (
	"context"
	"encoding/json"
	"sort"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// ─── fs.walk ─────────────────────────────────────────────────────────────

func TestFsWalk_RootRecursiveReturnsEverything(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: true})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	res := result.(proto.WalkResult)
	if res.Truncated {
		t.Fatal("recursive walk of small fixture should not truncate")
	}

	gotPaths := make([]string, 0, len(res.Entries))
	gotTypes := map[string]proto.EntryType{}
	for _, e := range res.Entries {
		gotPaths = append(gotPaths, e.Path)
		gotTypes[e.Path] = e.Type
	}
	sort.Strings(gotPaths)

	wantPaths := []string{
		"docs",
		"docs/a.md",
		"docs/sub",
		"docs/sub/b.md",
		"empty",
		"img",
		"img/logo.png",
		"note.md",
	}
	if len(gotPaths) != len(wantPaths) {
		t.Fatalf("paths = %v, want %v", gotPaths, wantPaths)
	}
	for i := range wantPaths {
		if gotPaths[i] != wantPaths[i] {
			t.Errorf("paths[%d] = %q, want %q", i, gotPaths[i], wantPaths[i])
		}
	}

	if gotTypes["note.md"] != proto.EntryTypeFile {
		t.Errorf("note.md type = %q, want file", gotTypes["note.md"])
	}
	if gotTypes["docs"] != proto.EntryTypeFolder {
		t.Errorf("docs type = %q, want folder", gotTypes["docs"])
	}
	if gotTypes["docs/sub/b.md"] != proto.EntryTypeFile {
		t.Errorf("docs/sub/b.md type = %q, want file", gotTypes["docs/sub/b.md"])
	}
}

func TestFsWalk_RootNonRecursiveStopsAtFirstLevel(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: false})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	res := result.(proto.WalkResult)

	gotPaths := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		gotPaths = append(gotPaths, e.Path)
	}
	sort.Strings(gotPaths)

	want := []string{"docs", "empty", "img", "note.md"}
	if len(gotPaths) != len(want) {
		t.Fatalf("paths = %v, want %v", gotPaths, want)
	}
	for i := range want {
		if gotPaths[i] != want[i] {
			t.Errorf("paths[%d] = %q, want %q", i, gotPaths[i], want[i])
		}
	}
}

func TestFsWalk_SubdirectoryRecursive(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "docs", Recursive: true})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	res := result.(proto.WalkResult)

	gotPaths := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		gotPaths = append(gotPaths, e.Path)
	}
	sort.Strings(gotPaths)

	want := []string{"docs/a.md", "docs/sub", "docs/sub/b.md"}
	if len(gotPaths) != len(want) {
		t.Fatalf("paths = %v, want %v", gotPaths, want)
	}
	for i := range want {
		if gotPaths[i] != want[i] {
			t.Errorf("paths[%d] = %q, want %q", i, gotPaths[i], want[i])
		}
	}
}

func TestFsWalk_HonorsMaxEntriesAndSetsTruncated(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	// The fixture has 8 entries total; cap at 3 so we definitely hit
	// the limit before the walk would otherwise finish.
	raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: true, MaxEntries: 3})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	res := result.(proto.WalkResult)

	if !res.Truncated {
		t.Errorf("expected Truncated=true when MaxEntries < total")
	}
	if len(res.Entries) != 3 {
		t.Errorf("len(entries) = %d, want 3", len(res.Entries))
	}
}

func TestFsWalk_EntriesCarryMtimeAndSize(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: true})
	result, _ := h(context.Background(), raw)
	res := result.(proto.WalkResult)

	for _, e := range res.Entries {
		if e.Path == "note.md" {
			if e.Size <= 0 {
				t.Errorf("note.md size = %d, want > 0", e.Size)
			}
			if e.Mtime <= 0 {
				t.Errorf("note.md mtime = %d, want > 0", e.Mtime)
			}
			return
		}
	}
	t.Fatal("note.md not found in walk output")
}

func TestFsWalk_MissingReturnsFileNotFound(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "nope", Recursive: true})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

func TestFsWalk_OnFileReturnsNotADirectory(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "note.md", Recursive: true})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorNotADirectory {
		t.Fatalf("want NotADirectory, got %+v", rerr)
	}
}

func TestFsWalk_PathOutsideVault(t *testing.T) {
	v := newVault(t)
	h := FsWalk(v.Root)
	raw, _ := json.Marshal(proto.WalkParams{Path: "../escape", Recursive: true})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}
