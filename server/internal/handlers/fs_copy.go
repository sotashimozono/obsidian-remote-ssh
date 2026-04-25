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
func FsCopy(vaultRoot string) rpc.Handler {
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
		data, err := os.ReadFile(srcAbs)
		if err != nil {
			return nil, mapFsError(err, p.SrcPath)
		}
		mtime, cerr := atomicWriteFile(dstAbs, p.DestPath, data, 0)
		if cerr != nil {
			return nil, cerr
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
