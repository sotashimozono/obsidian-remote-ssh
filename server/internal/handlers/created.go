package handlers

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// createdXattr keeps a file's creation time across atomicWriteFile's
// tmp+rename, which swaps in a new inode; Linux can't set a birth time.
// The value is "<unix ms>:<inode>". A value whose inode doesn't match
// was copied along with the file (cp -a, rsync -X) and is ignored.
const createdXattr = "user.obsidian-remote.created"

// createdMillis returns the creation time in unix ms (Obsidian
// FileStats.ctime, not POSIX st_ctime): the xattr, else the OS birth
// time clamped to mtime (copied vaults get fresh birth times), else
// mtime. Non-regular files return mtime: the plugin ignores folder
// ctimes, and the lookups would follow symlinks.
func createdMillis(abs string, info os.FileInfo) int64 {
	if info.Mode().IsRegular() {
		if ms, ok := readCreatedXattr(abs, info); ok {
			return ms
		}
		if ms, ok := birthMillis(abs, info); ok {
			return min(ms, mtimeMillis(info))
		}
	}
	return mtimeMillis(info)
}

func readCreatedXattr(abs string, info os.FileInfo) (int64, bool) {
	ino, ok := inodeOf(info)
	if !ok {
		return 0, false
	}
	// Fits "<int64>:<uint64>"; anything longer isn't ours.
	buf := make([]byte, 48)
	n, err := getXattr(abs, createdXattr, buf)
	if err != nil || n <= 0 {
		return 0, false
	}
	msStr, inoStr, found := strings.Cut(string(buf[:n]), ":")
	if !found || inoStr != strconv.FormatUint(ino, 10) {
		return 0, false
	}
	ms, err := strconv.ParseInt(msStr, 10, 64)
	if err != nil || ms <= 0 {
		return 0, false
	}
	return ms, true
}

// writeCreatedXattr tags the value with abs's inode. Rename keeps the
// inode, so a stamp on the tmp file matches the destination.
func writeCreatedXattr(abs string, ms int64) error {
	info, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	ino, ok := inodeOf(info)
	if !ok {
		return errors.ErrUnsupported
	}
	val := strconv.FormatInt(ms, 10) + ":" + strconv.FormatUint(ino, 10)
	return setXattr(abs, createdXattr, []byte(val))
}
