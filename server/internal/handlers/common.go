package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/correlator"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/vaultfs"
)

// registerCidIfPresent threads the optional Phase C correlation id
// from the inbound RPC envelope (request `meta.cid`) into the
// per-daemon Correlator, keyed by `paths`. Multi-path callers (e.g.
// fs.rename) register the cid against both the source and destination
// so whichever fsnotify event fires first carries it.
//
// All branches are short-circuited when the daemon was built without
// a correlator (production may run with cid threading disabled) or
// when no meta was on the wire — handlers stay one-line.
func registerCidIfPresent(ctx context.Context, cor *correlator.Correlator, paths ...string) {
	if cor == nil {
		return
	}
	meta, ok := rpc.MetaFromContext(ctx)
	if !ok || meta == nil || meta.Cid == "" {
		return
	}
	for _, p := range paths {
		cor.Register(p, meta.Cid)
	}
}

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

// writeFilePerm is the mode used for newly-written files. Matches the
// default Obsidian produces on desktop (umask-applied 0644).
const writeFilePerm = 0o644

// atomicWriteFile writes data to abs via a sibling tmp file + rename,
// so a crashed or partial write never leaves the destination in a
// half-written state. Parent directories are created as needed.
//
// If expectedMtime is non-zero, the existing file (when present) must
// have exactly that mtime in unix milliseconds, otherwise the function
// returns PreconditionFailed without touching disk. A target that
// does not exist at all is accepted unconditionally, even when
// expectedMtime is set — this matches the Obsidian semantics of
// "write the file, asserting it didn't change out from under me".
//
// The returned int64 is the post-write mtime in unix milliseconds.
// relativePath is used solely to tag error messages with a path the
// client recognises.
func atomicWriteFile(abs, relativePath string, data []byte, expectedMtime int64) (int64, *rpc.Error) {
	if expectedMtime != 0 {
		if info, err := os.Stat(abs); err == nil {
			got := info.ModTime().UnixMilli()
			if got != expectedMtime {
				return 0, rpc.ErrPreconditionFailed(
					fmt.Sprintf("%s: expected mtime %d, found %d", relativePath, expectedMtime, got),
				)
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return 0, mapFsError(err, relativePath)
		}
	}

	parent := filepath.Dir(abs)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return 0, mapFsError(err, relativePath)
	}

	tmp, err := os.CreateTemp(parent, ".rsh-write-*.tmp")
	if err != nil {
		return 0, mapFsError(err, relativePath)
	}
	tmpPath := tmp.Name()
	// Best-effort cleanup in every non-success path below.
	cleanup := func() { _ = os.Remove(tmpPath) }

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return 0, mapFsError(err, relativePath)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return 0, mapFsError(err, relativePath)
	}
	if err := os.Chmod(tmpPath, writeFilePerm); err != nil {
		// Non-fatal on platforms that don't fully support chmod (e.g.
		// some Windows filesystems): keep going.
		_ = err
	}
	if err := os.Rename(tmpPath, abs); err != nil {
		cleanup()
		return 0, mapFsError(err, relativePath)
	}

	info, err := os.Stat(abs)
	if err != nil {
		return 0, mapFsError(err, relativePath)
	}
	return info.ModTime().UnixMilli(), nil
}
