//go:build darwin

package handlers

import "golang.org/x/sys/unix"

// errNoXattr is getxattr's "no such attribute".
const errNoXattr = unix.ENOATTR
