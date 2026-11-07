//go:build linux || darwin

package handlers

import (
	"os"
	"syscall"
	"testing"
)

// statInfo is an os.FileInfo whose Sys() is st; nothing else is called.
type statInfo struct {
	os.FileInfo
	st *syscall.Stat_t
}

func (i statInfo) Sys() any { return i.st }

// onLocalDisk asks statfs once per device and caches the answer: statfs can
// itself be a round trip on the network filesystems this check exists for.
func TestOnLocalDisk_CachesPerDevice(t *testing.T) {
	localDevs.Clear()
	t.Cleanup(localDevs.Clear)
	orig := localFS
	t.Cleanup(func() { localFS = orig })
	calls := 0
	localFS = func(string) bool { calls++; return calls == 1 }

	// Constants: Dev is a uint64 on Linux and an int32 on macOS.
	a, b := &syscall.Stat_t{}, &syscall.Stat_t{}
	a.Dev, b.Dev = 7, 8

	for range 3 {
		if !onLocalDisk("/vault/a.md", statInfo{st: a}) {
			t.Fatal("device 7: want local")
		}
	}
	if calls != 1 {
		t.Fatalf("statfs calls for one device = %d, want 1", calls)
	}

	// A failed or non-local answer is cached too: xattrs stay off for that
	// device until the daemon restarts, which only loses creation times.
	for range 2 {
		if onLocalDisk("/mnt/nfs/b.md", statInfo{st: b}) {
			t.Fatal("device 8: want not local")
		}
	}
	if calls != 2 {
		t.Fatalf("statfs calls for two devices = %d, want 2", calls)
	}
}
