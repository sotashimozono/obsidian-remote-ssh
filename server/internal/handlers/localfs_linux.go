//go:build linux

package handlers

import "golang.org/x/sys/unix"

// zfsSuperMagic is ZFS's statfs type; x/sys/unix doesn't define it.
const zfsSuperMagic = 0x2fc12fc1

func isLocalFS(abs string) bool {
	var st unix.Statfs_t
	if err := unix.Statfs(abs, &st); err != nil {
		return false
	}
	return isLocalFSType(int64(st.Type))
}

// isLocalFSType reports whether a statfs type is a local disk filesystem.
// It compares the low 32 bits: Statfs_t.Type is an int32 on 32-bit
// platforms, where the larger magics come out negative.
func isLocalFSType(t int64) bool {
	switch uint32(t) {
	case unix.EXT4_SUPER_MAGIC, // also ext2 and ext3
		unix.XFS_SUPER_MAGIC,
		unix.BTRFS_SUPER_MAGIC,
		unix.F2FS_SUPER_MAGIC,
		zfsSuperMagic,
		unix.TMPFS_MAGIC,
		unix.OVERLAYFS_SUPER_MAGIC: // containers
		return true
	}
	return false
}
