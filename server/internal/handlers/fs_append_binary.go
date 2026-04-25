package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsAppendBinary returns the handler for `fs.appendBinary`.
// Payload is std base64; decoding failures map to InvalidParams.
func FsAppendBinary(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.AppendBinaryParams
		if e := decodeParams("fs.appendBinary", params, &p); e != nil {
			return nil, e
		}
		data, err := base64.StdEncoding.DecodeString(p.ContentBase64)
		if err != nil {
			return nil, rpc.ErrInvalidParams("fs.appendBinary: base64 decode: " + err.Error())
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		mtime, e := appendToFile(abs, p.Path, data)
		if e != nil {
			return nil, e
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
