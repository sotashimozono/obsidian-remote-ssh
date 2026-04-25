package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsRename returns the handler for `fs.rename`. Both paths must live
// inside the vault root. The destination's parent directory is
// created as needed so the client doesn't have to fs.mkdir separately
// for a move into an archive folder.
func FsRename(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.RenameParams
		if e := decodeParams("fs.rename", params, &p); e != nil {
			return nil, e
		}
		oldAbs, e := resolveOrErr(vaultRoot, p.OldPath)
		if e != nil {
			return nil, e
		}
		newAbs, e := resolveOrErr(vaultRoot, p.NewPath)
		if e != nil {
			return nil, e
		}
		if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
			return nil, mapFsError(err, p.NewPath)
		}
		if err := os.Rename(oldAbs, newAbs); err != nil {
			return nil, mapFsError(err, p.OldPath)
		}
		info, err := os.Stat(newAbs)
		if err != nil {
			return nil, mapFsError(err, p.NewPath)
		}
		return proto.MtimeResult{Mtime: info.ModTime().UnixMilli()}, nil
	}
}
