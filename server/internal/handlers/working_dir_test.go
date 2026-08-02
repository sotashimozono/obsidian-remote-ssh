package handlers

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

func TestValidateWorkingDir_InsideVault(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	got, rerr := validateWorkingDir(root, "sub")
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	want, _ := filepath.EvalSymlinks(sub)
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestValidateWorkingDir_RejectsOutsideVault(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	_, rerr := validateWorkingDir(root, outside)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

func TestValidateWorkingDir_RejectsSymlinkBreakout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is environment-dependent on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "out")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink not available: %v", err)
	}
	_, rerr := validateWorkingDir(root, "out")
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}
