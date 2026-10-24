//go:build linux || darwin

package handlers

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func inodeOf(info os.FileInfo) (uint64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Ino), true
}

// Vars, so a test can make the xattr calls fail.
var getXattr = func(path, name string, dest []byte) (int, error) {
	return unix.Getxattr(path, name, dest)
}

var setXattr = func(path, name string, data []byte) error {
	return unix.Setxattr(path, name, data, 0)
}

func removeXattr(path, name string) error {
	return unix.Removexattr(path, name)
}
