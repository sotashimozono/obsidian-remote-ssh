package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// ─── fs.mkdir ────────────────────────────────────────────────────────────

func TestFsMkdir_Recursive(t *testing.T) {
	root := t.TempDir()
	h := FsMkdir(root)
	raw, _ := json.Marshal(proto.MkdirParams{Path: "a/b/c", Recursive: true})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if info, err := os.Stat(filepath.Join(root, "a", "b", "c")); err != nil || !info.IsDir() {
		t.Errorf("expected a/b/c to exist as a directory")
	}
}

func TestFsMkdir_RecursiveIdempotent(t *testing.T) {
	root := t.TempDir()
	h := FsMkdir(root)
	raw, _ := json.Marshal(proto.MkdirParams{Path: "docs", Recursive: true})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatal(rerr)
	}
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("second call should be a no-op, got %+v", rerr)
	}
}

func TestFsMkdir_NonRecursiveRequiresParent(t *testing.T) {
	root := t.TempDir()
	h := FsMkdir(root)
	raw, _ := json.Marshal(proto.MkdirParams{Path: "missing-parent/child"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound without recursive, got %+v", rerr)
	}
}

func TestFsMkdir_NonRecursiveExistingDirIsIdempotent(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := FsMkdir(root)
	raw, _ := json.Marshal(proto.MkdirParams{Path: "docs"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("mkdir on existing dir should succeed, got %+v", rerr)
	}
}

func TestFsMkdir_NonRecursiveFileCollision(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "existing"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsMkdir(root)
	raw, _ := json.Marshal(proto.MkdirParams{Path: "existing"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorExists {
		t.Fatalf("want Exists when a file is in the way, got %+v", rerr)
	}
}

// ─── fs.remove ───────────────────────────────────────────────────────────

func TestFsRemove_DeletesFile(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "doomed.md")
	if err := os.WriteFile(p, []byte("bye"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsRemove(root, nil)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "doomed.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Errorf("file still exists after remove")
	}
}

func TestFsRemove_RefusesDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := FsRemove(root, nil)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "docs"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorIsADirectory {
		t.Fatalf("want IsADirectory, got %+v", rerr)
	}
}

func TestFsRemove_MissingReturnsFileNotFound(t *testing.T) {
	root := t.TempDir()
	h := FsRemove(root, nil)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "ghost.md"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

// ─── fs.rmdir ────────────────────────────────────────────────────────────

func TestFsRmdir_NonRecursiveOnNonEmptyFails(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := FsRmdir(root)
	raw, _ := json.Marshal(proto.RmdirParams{Path: "docs"})
	if _, rerr := h(context.Background(), raw); rerr == nil {
		t.Fatal("expected rmdir(non-empty, recursive=false) to fail")
	}
}

func TestFsRmdir_RecursiveWipesTree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "sub", "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsRmdir(root)
	raw, _ := json.Marshal(proto.RmdirParams{Path: "docs", Recursive: true})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(filepath.Join(root, "docs")); !os.IsNotExist(err) {
		t.Error("docs should be gone after recursive rmdir")
	}
}

func TestFsRmdir_RefusesVaultRoot(t *testing.T) {
	root := t.TempDir()
	h := FsRmdir(root)
	raw, _ := json.Marshal(proto.RmdirParams{Path: "", Recursive: true})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for vault-root rmdir, got %+v", rerr)
	}
	// Vault root must still exist.
	if _, err := os.Stat(root); err != nil {
		t.Errorf("vault root was touched: %v", err)
	}
}

func TestFsRmdir_RefusesFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsRmdir(root)
	raw, _ := json.Marshal(proto.RmdirParams{Path: "a.md"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorNotADirectory {
		t.Fatalf("want NotADirectory, got %+v", rerr)
	}
}

// ─── fs.rename ───────────────────────────────────────────────────────────

func TestFsRename_MovesFile(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "old.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsRename(root, nil)
	raw, _ := json.Marshal(proto.RenameParams{OldPath: "old.md", NewPath: "new.md"})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if mt, ok := result.(proto.MtimeResult); !ok || mt.Mtime <= 0 {
		t.Errorf("result = %+v, want positive mtime", result)
	}
	if _, err := os.Stat(filepath.Join(root, "old.md")); !os.IsNotExist(err) {
		t.Error("old.md should no longer exist")
	}
	if _, err := os.Stat(filepath.Join(root, "new.md")); err != nil {
		t.Errorf("new.md missing: %v", err)
	}
}

func TestFsRename_CreatesDestinationParents(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsRename(root, nil)
	raw, _ := json.Marshal(proto.RenameParams{OldPath: "a.md", NewPath: "archived/2026/a.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(filepath.Join(root, "archived", "2026", "a.md")); err != nil {
		t.Errorf("archived/2026/a.md missing: %v", err)
	}
}

func TestFsRename_MissingSource(t *testing.T) {
	root := t.TempDir()
	h := FsRename(root, nil)
	raw, _ := json.Marshal(proto.RenameParams{OldPath: "ghost.md", NewPath: "new.md"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

// ─── fs.copy ─────────────────────────────────────────────────────────────

func TestFsCopy_DuplicatesFile(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src.md")
	if err := os.WriteFile(src, []byte("content"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsCopy(root)
	raw, _ := json.Marshal(proto.CopyParams{SrcPath: "src.md", DestPath: "dst.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	dstData, _ := os.ReadFile(filepath.Join(root, "dst.md"))
	if string(dstData) != "content" {
		t.Errorf("dst = %q, want %q", dstData, "content")
	}
	srcData, _ := os.ReadFile(src)
	if string(srcData) != "content" {
		t.Error("source was modified by copy")
	}
}

func TestFsCopy_RefusesDirectorySource(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := FsCopy(root)
	raw, _ := json.Marshal(proto.CopyParams{SrcPath: "dir", DestPath: "dir-copy"})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorIsADirectory {
		t.Fatalf("want IsADirectory for directory source, got %+v", rerr)
	}
}

// ─── fs.trashLocal ───────────────────────────────────────────────────────

func TestFsTrashLocal_MovesUnderDotTrash(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("bye"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsTrashLocal(root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "note.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(filepath.Join(root, "note.md")); !os.IsNotExist(err) {
		t.Error("original should be gone after trashLocal")
	}
	data, err := os.ReadFile(filepath.Join(root, ".trash", "note.md"))
	if err != nil {
		t.Fatalf(".trash/note.md missing: %v", err)
	}
	if string(data) != "bye" {
		t.Errorf("trashed content = %q, want %q", data, "bye")
	}
}

func TestFsTrashLocal_CreatesNestedTrashDirs(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "docs", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "sub", "a.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsTrashLocal(root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: "docs/sub/a.md"})
	if _, rerr := h(context.Background(), raw); rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", "docs", "sub", "a.md")); err != nil {
		t.Errorf(".trash/docs/sub/a.md missing: %v", err)
	}
}

func TestFsTrashLocal_RefusesVaultRoot(t *testing.T) {
	root := t.TempDir()
	h := FsTrashLocal(root)
	raw, _ := json.Marshal(proto.PathOnlyParams{Path: ""})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for vault-root trash, got %+v", rerr)
	}
}
