//go:build darwin

package handlers

import "golang.org/x/sys/unix"

func isLocalFS(abs string) bool {
	var st unix.Statfs_t
	if err := unix.Statfs(abs, &st); err != nil {
		return false
	}
	return st.Flags&unix.MNT_LOCAL != 0
}
