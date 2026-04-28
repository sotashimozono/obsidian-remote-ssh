package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/correlator"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsWriteBinary returns the handler for `fs.writeBinary`.
//
// Payload is std base64 (matches what fs.readBinary emits and what
// Node's Buffer.toString("base64") produces). Decoding errors are
// surfaced as InvalidParams so the client doesn't end up with a
// zero-length file when the wire was garbled.
//
// `cor` (optional) threads the request's `meta.cid` into the
// path-keyed Correlator so the resulting fs.changed notification
// carries the same cid back to the client.
func FsWriteBinary(vaultRoot string, cor *correlator.Correlator) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
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
		registerCidIfPresent(ctx, cor, p.Path)
		mtime, e := atomicWriteFile(abs, p.Path, data, p.ExpectedMtime)
		if e != nil {
			return nil, e
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
