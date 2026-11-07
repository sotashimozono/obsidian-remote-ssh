//go:build linux

package handlers

import "golang.org/x/sys/unix"

// errNoXattr is getxattr's "no such attribute": Linux reports ENOATTR
// as ENODATA.
const errNoXattr = unix.ENODATA
