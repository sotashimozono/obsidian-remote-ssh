package handlers

import (
	"context"
	"encoding/json"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsRemove returns the handler for `fs.remove` (file-only delete).
// Directories are rejected with IsADirectory — callers should use
// fs.rmdir. Missing files return FileNotFound instead of "success by
// coincidence" so clients can tell the difference from a success.
func FsRemove(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.remove", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		if info.IsDir() {
			return nil, rpc.ErrIsADirectory(p.Path)
		}
		if err := os.Remove(abs); err != nil {
			return nil, mapFsError(err, p.Path)
		}
		return struct{}{}, nil
	}
}
