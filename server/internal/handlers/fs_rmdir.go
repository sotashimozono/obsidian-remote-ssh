package handlers

import (
	"context"
	"encoding/json"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsRmdir returns the handler for `fs.rmdir`.
//
// Guards:
//   - Refuses to remove a file with NotADirectory.
//   - Refuses to remove the vault root itself with InvalidParams —
//     otherwise a single `fs.rmdir ""` wipes the whole vault.
//
// `recursive=false` uses os.Remove (which fails on non-empty dirs);
// `recursive=true` uses os.RemoveAll.
func FsRmdir(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.RmdirParams
		if e := decodeParams("fs.rmdir", params, &p); e != nil {
			return nil, e
		}
		if p.Path == "" || p.Path == "/" {
			return nil, rpc.ErrInvalidParams("fs.rmdir: refusing to remove the vault root")
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		if !info.IsDir() {
			return nil, rpc.ErrNotADirectory(p.Path)
		}
		if p.Recursive {
			if err := os.RemoveAll(abs); err != nil {
				return nil, mapFsError(err, p.Path)
			}
		} else {
			if err := os.Remove(abs); err != nil {
				return nil, mapFsError(err, p.Path)
			}
		}
		return struct{}{}, nil
	}
}
