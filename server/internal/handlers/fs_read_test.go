package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// vaultFixture returns a temp dir seeded with a small file tree and
// the absolute paths to a couple of anchor files for assertions.
type vaultFixture struct {
	Root     string
	NoteAbs  string // <root>/note.md
	ImgAbs   string // <root>/img/logo.png
	SubDirs  []string
}

func newVault(t *testing.T) *vaultFixture {
	t.Helper()
	root := t.TempDir()
	mustMkdir := func(rel string) {
		if err := os.MkdirAll(filepath.Join(root, rel), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite := func(rel string, data []byte) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mustMkdir("docs/sub")
	mustMkdir("img")
	mustMkdir("empty")
	mustWrite("note.md", []byte("# Hello\nbody"))
	mustWrite("docs/a.md", []byte("one"))
	mustWrite("docs/sub/b.md", []byte("two"))
	mustWrite("img/logo.png", []byte{0x89, 0x50, 0x4e, 0x47, 0x01, 0x02})
	return &vaultFixture{
		Root:    root,
		NoteAbs: filepath.Join(root, "note.md"),
		ImgAbs:  filepath.Join(root, "img", "logo.png"),
		SubDirs: []string{"docs", "img", "empty"},
	}
}

// ─── fs.stat ─────────────────────────────────────────────────────────────

func TestFsStat_File(t *testing.T) {
	v := newVault(t)
	h := FsStat(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "note.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	got, ok := result.(proto.Stat)
	if !ok {
		t.Fatalf("result type = %T, want proto.Stat", result)
	}
	if got.Type != proto.EntryTypeFile {
		t.Errorf("Type = %q, want file", got.Type)
	}
	if got.Size != int64(len("# Hello\nbody")) {
		t.Errorf("Size = %d, want %d", got.Size, len("# Hello\nbody"))
	}
	if got.Mtime <= 0 {
		t.Errorf("Mtime = %d, want positive unix ms", got.Mtime)
	}
	if time.UnixMilli(got.Mtime).After(time.Now().Add(time.Minute)) {
		t.Errorf("Mtime %d is unreasonably in the future", got.Mtime)
	}
}

func TestFsStat_Folder(t *testing.T) {
	v := newVault(t)
	h := FsStat(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "docs"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	got, ok := result.(proto.Stat)
	if !ok {
		t.Fatalf("result type = %T", result)
	}
	if got.Type != proto.EntryTypeFolder {
		t.Errorf("Type = %q, want folder", got.Type)
	}
}

func TestFsStat_MissingReturnsNull(t *testing.T) {
	v := newVault(t)
	h := FsStat(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "missing.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if result != nil {
		t.Errorf("missing path should return nil result, got %+v", result)
	}
}

func TestFsStat_PathOutsideVault(t *testing.T) {
	v := newVault(t)
	h := FsStat(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "../etc/passwd"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

// ─── fs.exists ───────────────────────────────────────────────────────────

func TestFsExists_TrueForFile(t *testing.T) {
	v := newVault(t)
	h := FsExists(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "note.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if !result.(proto.ExistsResult).Exists {
		t.Error("want exists=true for note.md")
	}
}

func TestFsExists_FalseForMissing(t *testing.T) {
	v := newVault(t)
	h := FsExists(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "nope.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if result.(proto.ExistsResult).Exists {
		t.Error("want exists=false for nope.md")
	}
}

func TestFsExists_PathOutsideVault(t *testing.T) {
	v := newVault(t)
	h := FsExists(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "/etc/passwd"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

// ─── fs.list ─────────────────────────────────────────────────────────────

func TestFsList_Root(t *testing.T) {
	v := newVault(t)
	h := FsList(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: ""})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	list := result.(proto.ListResult)
	names := make([]string, 0, len(list.Entries))
	types := map[string]proto.EntryType{}
	for _, e := range list.Entries {
		names = append(names, e.Name)
		types[e.Name] = e.Type
	}
	sort.Strings(names)
	wantNames := []string{"docs", "empty", "img", "note.md"}
	if len(names) != len(wantNames) {
		t.Fatalf("names = %v, want %v", names, wantNames)
	}
	for i := range wantNames {
		if names[i] != wantNames[i] {
			t.Errorf("names[%d] = %q, want %q", i, names[i], wantNames[i])
		}
	}
	if types["note.md"] != proto.EntryTypeFile {
		t.Errorf("note.md type = %q, want file", types["note.md"])
	}
	if types["docs"] != proto.EntryTypeFolder {
		t.Errorf("docs type = %q, want folder", types["docs"])
	}
}

func TestFsList_Subdirectory(t *testing.T) {
	v := newVault(t)
	h := FsList(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "docs"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	list := result.(proto.ListResult)
	got := map[string]bool{}
	for _, e := range list.Entries {
		got[e.Name] = true
	}
	if !got["a.md"] {
		t.Error("docs should contain a.md")
	}
	if !got["sub"] {
		t.Error("docs should contain sub/")
	}
}

func TestFsList_MissingReturnsFileNotFound(t *testing.T) {
	v := newVault(t)
	h := FsList(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "nope"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

func TestFsList_OnFileReturnsNotADirectory(t *testing.T) {
	v := newVault(t)
	h := FsList(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "note.md"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorNotADirectory {
		t.Fatalf("want NotADirectory, got %+v", rerr)
	}
}

// ─── fs.readText ─────────────────────────────────────────────────────────

func TestFsReadText_Happy(t *testing.T) {
	v := newVault(t)
	h := FsReadText(v.Root)
	raw, _ := json.Marshal(proto.ReadTextParams{Path: "note.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	got := result.(proto.ReadTextResult)
	if got.Content != "# Hello\nbody" {
		t.Errorf("Content = %q, want %q", got.Content, "# Hello\nbody")
	}
	if got.Encoding != "utf8" {
		t.Errorf("Encoding = %q, want utf8", got.Encoding)
	}
	if got.Size != int64(len(got.Content)) {
		t.Errorf("Size = %d, want %d", got.Size, len(got.Content))
	}
}

func TestFsReadText_RejectsInvalidUTF8(t *testing.T) {
	v := newVault(t)
	h := FsReadText(v.Root)
	// The seeded PNG header is not valid UTF-8.
	raw, _ := json.Marshal(proto.ReadTextParams{Path: "img/logo.png"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for non-UTF-8, got %+v", rerr)
	}
}

func TestFsReadText_RejectsDirectory(t *testing.T) {
	v := newVault(t)
	h := FsReadText(v.Root)
	raw, _ := json.Marshal(proto.ReadTextParams{Path: "docs"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorIsADirectory {
		t.Fatalf("want IsADirectory, got %+v", rerr)
	}
}

func TestFsReadText_MissingReturnsFileNotFound(t *testing.T) {
	v := newVault(t)
	h := FsReadText(v.Root)
	raw, _ := json.Marshal(proto.ReadTextParams{Path: "nope.md"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

func TestFsReadText_RejectsUnknownEncoding(t *testing.T) {
	v := newVault(t)
	h := FsReadText(v.Root)
	raw, _ := json.Marshal(proto.ReadTextParams{Path: "note.md", Encoding: "shift-jis"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for unknown encoding, got %+v", rerr)
	}
}

// ─── fs.readBinary ───────────────────────────────────────────────────────

func TestFsReadBinary_Happy(t *testing.T) {
	v := newVault(t)
	h := FsReadBinary(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "img/logo.png"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	got := result.(proto.ReadBinaryResult)
	decoded, err := base64.StdEncoding.DecodeString(got.ContentBase64)
	if err != nil {
		t.Fatalf("base64 decode: %v", err)
	}
	wantBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x01, 0x02}
	if len(decoded) != len(wantBytes) {
		t.Fatalf("decoded len = %d, want %d", len(decoded), len(wantBytes))
	}
	for i := range wantBytes {
		if decoded[i] != wantBytes[i] {
			t.Errorf("decoded[%d] = %#x, want %#x", i, decoded[i], wantBytes[i])
		}
	}
	if got.Size != int64(len(wantBytes)) {
		t.Errorf("Size = %d, want %d", got.Size, len(wantBytes))
	}
}

func TestFsReadBinary_RejectsDirectory(t *testing.T) {
	v := newVault(t)
	h := FsReadBinary(v.Root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "docs"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorIsADirectory {
		t.Fatalf("want IsADirectory, got %+v", rerr)
	}
}
