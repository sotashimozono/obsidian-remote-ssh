package handlers

import (
	"context"
	"encoding/json"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsCopy returns the handler for `fs.copy`. Copies are file-only
// (source must be a regular file) and go through the same atomic
// tmp+rename at the destination that fs.write uses, so a crash
// midway never exposes a half-copied file.
//
// `onModify` is optional — when non-nil and the copy replaced an
// existing destination file, the callback fires with the
// vault-relative destination path so the caller can inject a
// synthetic Modified event into the watcher. Bypasses the Linux
// fsnotify race that drops the IN_MOVED_TO event for atomic-rename
// writes when the watcher has been alive across an earlier write to
// the same parent directory (#108).
func FsCopy(vaultRoot string, onModify func(relPath string)) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.CopyParams
		if e := decodeParams("fs.copy", params, &p); e != nil {
			return nil, e
		}
		srcAbs, e := resolveOrErr(vaultRoot, p.SrcPath)
		if e != nil {
			return nil, e
		}
		dstAbs, e := resolveOrErr(vaultRoot, p.DestPath)
		if e != nil {
			return nil, e
		}

		info, err := os.Stat(srcAbs)
		if err != nil {
			return nil, mapFsError(err, p.SrcPath)
		}
		if info.IsDir() {
			return nil, rpc.ErrIsADirectory(p.SrcPath)
		}
		data, err := os.ReadFile(srcAbs) // #nosec G304 — srcAbs validated by resolveOrErr → vaultfs.Resolve
		if err != nil {
			return nil, mapFsError(err, p.SrcPath)
		}
		mtime, wasModify, cerr := atomicWriteFile(dstAbs, p.DestPath, data, 0)
		if cerr != nil {
			return nil, cerr
		}
		if wasModify && onModify != nil {
			onModify(p.DestPath)
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
