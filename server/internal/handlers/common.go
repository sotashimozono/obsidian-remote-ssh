package handlers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"syscall"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/vaultfs"
)

// decodeParams unmarshals raw into out and returns an InvalidParams
// rpc.Error on failure. `methodName` is used to tag the error so the
// client can correlate it with the call that failed.
func decodeParams(methodName string, raw json.RawMessage, out interface{}) *rpc.Error {
	if len(raw) == 0 || string(raw) == "null" {
		// Methods with no params accept this; methods that need params
		// will notice the zero value downstream.
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return rpc.ErrInvalidParams(methodName + ": " + err.Error())
	}
	return nil
}

// resolveOrErr wraps vaultfs.Resolve with a PathOutsideVault response.
func resolveOrErr(vaultRoot, relative string) (string, *rpc.Error) {
	abs, err := vaultfs.Resolve(vaultRoot, relative)
	if err != nil {
		return "", rpc.ErrPathOutsideVault(relative)
	}
	return abs, nil
}

// mapFsError maps a filesystem error to the nearest proto error code.
// `relativePath` is echoed in the message so the client sees a vault-
// relative path, not the absolute path on the remote.
func mapFsError(err error, relativePath string) *rpc.Error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return rpc.ErrFileNotFound(relativePath)
	case errors.Is(err, fs.ErrPermission):
		return rpc.ErrPermissionDenied(relativePath)
	case errors.Is(err, fs.ErrExist):
		return rpc.ErrExists(relativePath)
	case isNotDirectoryErr(err):
		return rpc.ErrNotADirectory(relativePath)
	case isIsDirectoryErr(err):
		return rpc.ErrIsADirectory(relativePath)
	}
	return rpc.ErrInternal(err.Error())
}

// entryTypeFrom maps an os.FileInfo / fs.DirEntry type to the proto
// EntryType string the client speaks. Symlinks are reported as
// symlinks (not followed); the caller decides whether to stat the
// target separately.
func entryTypeFrom(mode os.FileMode) proto.EntryType {
	switch {
	case mode&os.ModeSymlink != 0:
		return proto.EntryTypeSymlink
	case mode.IsDir():
		return proto.EntryTypeFolder
	default:
		return proto.EntryTypeFile
	}
}

// mtimeMillis renders a file mtime as unix milliseconds, matching the
// wire format used by proto.Stat.Mtime and proto.Entry.Mtime.
func mtimeMillis(info os.FileInfo) int64 {
	return info.ModTime().UnixMilli()
}

// isNotDirectoryErr / isIsDirectoryErr detect the POSIX-style
// directory-related errors (ENOTDIR, EISDIR) across platforms. Go's
// standard library doesn't expose these as sentinel errors, so we
// unwrap to the syscall.Errno layer manually. On Windows these errors
// are reported with different codes; the best-effort fallthrough is
// harmless (mapFsError returns InternalError in that case).

func isNotDirectoryErr(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == syscall.ENOTDIR
	}
	return false
}

func isIsDirectoryErr(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno == syscall.EISDIR
	}
	return false
}
