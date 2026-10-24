//go:build darwin

package handlers

import (
	"os"
	"syscall"
)

// birthMillis reads st_birthtimespec.
func birthMillis(_ string, info os.FileInfo) (int64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Birthtimespec.Sec*1000 + st.Birthtimespec.Nsec/1_000_000, true
}
