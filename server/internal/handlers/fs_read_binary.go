package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsReadBinary returns the handler for `fs.readBinary`.
//
// Payload is standard base64 (not URL-safe) — matching what
// encoding/base64 in Node also produces by default. Callers should
// use fs.readText for UTF-8 plain text to avoid the +33% wire overhead.
func FsReadBinary(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.readBinary", params, &p); e != nil {
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

		data, err := os.ReadFile(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		return proto.ReadBinaryResult{
			ContentBase64: base64.StdEncoding.EncodeToString(data),
			Mtime:         mtimeMillis(info),
			Size:          int64(len(data)),
		}, nil
	}
}
