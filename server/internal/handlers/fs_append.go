package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsAppend returns the handler for `fs.append`. Appends go through an
// O_APPEND open so the OS serialises concurrent small writes for us;
// we do NOT go through the tmp+rename dance (append is defined as
// "add bytes to the end", not "rewrite the file atomically").
//
// Creating the file on demand matches Obsidian's adapter.append which
// callers treat as "create-or-append".
func FsAppend(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.AppendTextParams
		if e := decodeParams("fs.append", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		mtime, e := appendToFile(abs, p.Path, []byte(p.Content))
		if e != nil {
			return nil, e
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}

// appendToFile is shared by fs.append and fs.appendBinary.
func appendToFile(abs, relativePath string, data []byte) (int64, *rpc.Error) {
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_APPEND|os.O_CREATE, writeFilePerm) // #nosec G304 — abs validated by resolveOrErr → vaultfs.Resolve
	if err != nil {
		// ENOENT on the parent dir surfaces here; let the caller decide
		// whether to create it (we don't, to keep append cheap — the
		// client can mkdir first).
		if errors.Is(err, fs.ErrNotExist) {
			return 0, rpc.ErrFileNotFound(relativePath)
		}
		return 0, mapFsError(err, relativePath)
	}
	defer f.Close()

	if _, err := f.Write(data); err != nil {
		return 0, mapFsError(err, relativePath)
	}
	if err := f.Sync(); err != nil {
		// Sync failures are rare but informative — they mean the OS
		// couldn't fully flush. Surface as Internal; the bytes may or
		// may not have landed.
		return 0, rpc.ErrInternal("fs.append: sync: " + err.Error())
	}
	info, err := f.Stat()
	if err != nil {
		return 0, mapFsError(err, relativePath)
	}
	return info.ModTime().UnixMilli(), nil
}
