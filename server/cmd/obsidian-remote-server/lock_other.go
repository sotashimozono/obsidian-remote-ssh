//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package main

import "os"

// tryLock is a no-op where syscall.Flock is unavailable (Windows,
// solaris, aix). The daemon ships for Linux and macOS only; this keeps
// other builds compiling, without the #614 protection.
func tryLock(*os.File) error { return nil }
