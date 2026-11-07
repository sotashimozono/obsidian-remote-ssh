//go:build linux

package handlers

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestIsLocalFSType(t *testing.T) {
	for _, tc := range []struct {
		name  string
		magic int64
		want  bool
	}{
		{"ext4", unix.EXT4_SUPER_MAGIC, true},
		{"xfs", unix.XFS_SUPER_MAGIC, true},
		{"btrfs", unix.BTRFS_SUPER_MAGIC, true},
		{"tmpfs", unix.TMPFS_MAGIC, true},
		{"overlay", unix.OVERLAYFS_SUPER_MAGIC, true},
		{"nfs", unix.NFS_SUPER_MAGIC, false},
		{"smb2", unix.SMB2_SUPER_MAGIC, false},
		{"cifs", unix.CIFS_SUPER_MAGIC, false},
		{"fuse", unix.FUSE_SUPER_MAGIC, false},
		{"unknown", 0x12345678, false},
	} {
		if got := isLocalFSType(tc.magic); got != tc.want {
			t.Errorf("isLocalFSType(%s) = %t, want %t", tc.name, got, tc.want)
		}
	}
}
