//go:build linux || darwin

package handlers

import (
	"errors"
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

func deviceOf(info os.FileInfo) (uint64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return uint64(st.Dev), true
}

// xattrAbsent reports whether a getxattr error means the file has no
// such xattr, or can't have one, rather than that the read failed.
// ERANGE: the value is longer than any of ours. ENOTSUP and EOPNOTSUPP
// match errors.ErrUnsupported.
func xattrAbsent(err error) bool {
	return errors.Is(err, errNoXattr) || errors.Is(err, unix.ERANGE) || errors.Is(err, errors.ErrUnsupported)
}

// Vars, so a test can make the xattr calls fail.
var getXattr = func(path, name string, dest []byte) (int, error) {
	return unix.Getxattr(path, name, dest)
}

var setXattr = func(path, name string, data []byte) error {
	return unix.Setxattr(path, name, data, 0)
}
