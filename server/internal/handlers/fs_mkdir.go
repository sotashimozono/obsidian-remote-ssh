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

// FsMkdir returns the handler for `fs.mkdir`.
//
// `recursive` = true (Obsidian's default) uses os.MkdirAll, which is
// idempotent when the target already exists as a directory. With the
// flag false we call os.Mkdir and return Exists if the path is
// already there as a dir (non-dir collisions bubble up as
// PermissionDenied or Internal depending on the OS).
func FsMkdir(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.MkdirParams
		if e := decodeParams("fs.mkdir", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		if p.Recursive {
			if err := os.MkdirAll(abs, 0o755); err != nil { // #nosec G301 — vault dir; 0755 matches Obsidian defaults
				return nil, mapFsError(err, p.Path)
			}
		} else {
			if err := os.Mkdir(abs, 0o755); err != nil { // #nosec G301 — vault dir; 0755 matches Obsidian defaults
				// An existing directory is fine; a regular file at the
				// same path is a conflict (Exists).
				if errors.Is(err, fs.ErrExist) {
					if info, statErr := os.Stat(abs); statErr == nil && info.IsDir() {
						return struct{}{}, nil
					}
					return nil, rpc.ErrExists(p.Path)
				}
				return nil, mapFsError(err, p.Path)
			}
		}
		return struct{}{}, nil
	}
}
