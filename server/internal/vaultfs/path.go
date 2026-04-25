// Package vaultfs is the thin filesystem layer the daemon uses to
// enforce "every remote operation stays inside the configured vault
// root". Handlers call Resolve to turn a client-supplied
// vault-relative path into an absolute OS path (or an error) and then
// use os.* / io.* as usual.
package vaultfs

import (
	"errors"
	"path/filepath"
)

// ErrOutsideVault is returned by Resolve when the input escapes the
// vault root through an absolute path, `..` component, or Windows
// reserved device name.
var ErrOutsideVault = errors.New("vaultfs: path escapes vault root")

// Resolve returns the absolute OS path for a vault-relative input.
//
// Accepted shapes:
//
//	""     → the vault root itself
//	"/"    → the vault root itself (convenience for clients that always prepend "/")
//	"a.md" → <root>/a.md
//	"docs/sub/a.md" → <root>/docs/sub/a.md (slashes may also be OS-native)
//
// Rejected shapes (all return ErrOutsideVault):
//
//	"/etc/passwd"      — absolute path
//	"../outside"       — parent escape
//	"docs/../../etc"   — parent escape after cleaning
//	"NUL" on Windows   — reserved device name
//
// Path safety relies on Go's filepath.IsLocal (Go 1.20+), which does
// lexical analysis only. Symlink escapes on disk are *not* caught
// here; they're the caller's problem (currently out of scope — the
// vault root is assumed to be a single-owner directory tree).
func Resolve(vaultRoot, relative string) (string, error) {
	if relative == "" || relative == "/" {
		return vaultRoot, nil
	}
	if !filepath.IsLocal(filepath.FromSlash(relative)) {
		return "", ErrOutsideVault
	}
	return filepath.Join(vaultRoot, filepath.FromSlash(relative)), nil
}
