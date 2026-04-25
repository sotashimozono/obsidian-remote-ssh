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

// FsExists returns the handler for `fs.exists`. It's a thin wrapper
// around os.Stat: a missing file yields exists=false, any other
// stat-level failure is mapped through mapFsError so PermissionDenied
// (etc.) still surface correctly instead of being masked as
// exists=false.
func FsExists(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.exists", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		if _, err := os.Stat(abs); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return proto.ExistsResult{Exists: false}, nil
			}
			return nil, mapFsError(err, p.Path)
		}
		return proto.ExistsResult{Exists: true}, nil
	}
}
