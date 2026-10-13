//go:build linux

package handlers

import (
	"os"

	"golang.org/x/sys/unix"
)

// birthMillis reads the birth time via statx(2). ok is false where
// STATX_BTIME isn't reported (older kernels, NFS, some FUSE mounts).
func birthMillis(abs string, _ os.FileInfo) (int64, bool) {
	var stx unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, abs, unix.AT_STATX_SYNC_AS_STAT, unix.STATX_BTIME, &stx); err != nil {
		return 0, false
	}
	if stx.Mask&unix.STATX_BTIME == 0 {
		return 0, false
	}
	return stx.Btime.Sec*1000 + int64(stx.Btime.Nsec)/1_000_000, true
}
