package handlers

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"sync"
)

// createdXattr keeps a file's creation time across atomicWriteFile's
// tmp+rename, which swaps in a new inode; Linux can't set a birth time.
// The value is "<unix ms>:<inode>". A value whose inode doesn't match
// was copied along with the file (cp -a, rsync -X) and is ignored.
const createdXattr = "user.obsidian-remote.created"

// createdMillis returns the creation time in unix ms (Obsidian
// FileStats.ctime, not POSIX st_ctime): the xattr, else the OS birth
// time clamped to mtime (copied vaults get fresh birth times), else
// mtime. It returns 0, unknown, when the xattr couldn't be read: the
// stamp may be there, and a fallback would contradict it. Non-regular
// files return mtime: the plugin ignores folder ctimes, and the lookups
// would follow symlinks.
func createdMillis(abs string, info os.FileInfo) int64 {
	if info.Mode().IsRegular() {
		ms, ok, err := readCreatedXattr(abs, info)
		if err != nil {
			return 0
		}
		if ok {
			return ms
		}
		// 0: the filesystem doesn't record a birth time (macOS reports
		// 0 on NFS, SMB and some FUSE mounts).
		if ms, ok := birthTime(abs, info); ok && ms > 0 {
			return min(ms, mtimeMillis(info))
		}
	}
	return mtimeMillis(info)
}

// A var, so a test can fake the OS birth time.
var birthTime = birthMillis

// readCreatedXattr returns our stamp on abs, if it has a valid one. err
// is set only when the read failed, not for a missing, foreign or
// garbled value, nor where xattrs aren't supported.
func readCreatedXattr(abs string, info os.FileInfo) (int64, bool, error) {
	ino, ok := inodeOf(info)
	if !ok || !xattrsUsable(abs, info) {
		return 0, false, nil
	}
	// Fits "<int64>:<uint64>"; anything longer isn't ours.
	buf := make([]byte, 48)
	n, err := getXattr(abs, createdXattr, buf)
	if err != nil {
		if xattrAbsent(err) {
			return 0, false, nil
		}
		return 0, false, err
	}
	msStr, inoStr, found := strings.Cut(string(buf[:n]), ":")
	if !found || inoStr != strconv.FormatUint(ino, 10) {
		return 0, false, nil
	}
	ms, err := strconv.ParseInt(msStr, 10, 64)
	if err != nil || ms <= 0 {
		return 0, false, nil
	}
	return ms, true, nil
}

// writeCreatedXattr tags the value with abs's inode. Rename keeps the
// inode, so a stamp on the tmp file matches the destination.
func writeCreatedXattr(abs string, ms int64) error {
	info, err := os.Lstat(abs)
	if err != nil {
		return err
	}
	ino, ok := inodeOf(info)
	if !ok || !xattrsUsable(abs, info) {
		return errors.ErrUnsupported
	}
	val := strconv.FormatInt(ms, 10) + ":" + strconv.FormatUint(ino, 10)
	return setXattr(abs, createdXattr, []byte(val))
}

// A var, so a test can fake the filesystem.
var xattrsUsable = onLocalDisk

// localDevs caches onLocalDisk per device: statfs can itself be a round
// trip on a network filesystem.
var localDevs sync.Map // uint64 → bool

// onLocalDisk reports whether abs is on a local disk, the only place the
// xattr is read or written. Over NFS a file without it costs a round trip
// on every lookup, since the client doesn't cache "no such attribute":
// that made fs.walk of an unstamped vault 65x slower at a 0.5 ms round
// trip. Off local disks, created falls back as on a filesystem without
// xattrs. A filesystem it doesn't recognize counts as not local.
func onLocalDisk(abs string, info os.FileInfo) bool {
	dev, ok := deviceOf(info)
	if !ok {
		return false
	}
	if v, ok := localDevs.Load(dev); ok {
		return v.(bool)
	}
	local := isLocalFS(abs)
	localDevs.Store(dev, local)
	return local
}
