package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsWriteBinary returns the handler for `fs.writeBinary`.
//
// Payload is std base64 (matches what fs.readBinary emits and what
// Node's Buffer.toString("base64") produces). Decoding errors are
// surfaced as InvalidParams so the client doesn't end up with a
// zero-length file when the wire was garbled.
func FsWriteBinary(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.WriteBinaryParams
		if e := decodeParams("fs.writeBinary", params, &p); e != nil {
			return nil, e
		}
		data, err := base64.StdEncoding.DecodeString(p.ContentBase64)
		if err != nil {
			return nil, rpc.ErrInvalidParams("fs.writeBinary: base64 decode: " + err.Error())
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		mtime, e := atomicWriteFile(abs, p.Path, data, p.ExpectedMtime)
		if e != nil {
			return nil, e
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
