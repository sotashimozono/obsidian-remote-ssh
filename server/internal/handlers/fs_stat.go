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

// FsStat returns the handler for `fs.stat`. For a missing path the
// handler resolves to `null` (per the spec — this is the only fs.*
// method that returns null instead of FileNotFound). Every other
// filesystem failure is mapped to the appropriate proto error code.
func FsStat(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.stat", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		info, err := os.Stat(abs)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil, nil
			}
			return nil, mapFsError(err, p.Path)
		}
		return proto.Stat{
			Type:  entryTypeFrom(info.Mode()),
			Mtime: mtimeMillis(info),
			Size:  info.Size(),
			Mode:  uint32(info.Mode()),
		}, nil
	}
}
