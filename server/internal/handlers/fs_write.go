package handlers

import (
	"context"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/correlator"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsWrite returns the handler for `fs.write`. Writes go through a tmp
// file + rename so a crash midway never leaves a half-written note
// on disk. Optional `expectedMtime` rejects the call with
// PreconditionFailed when the remote copy has drifted; clients can
// use this to avoid clobbering concurrent edits.
//
// `cor` is optional — pass nil to disable cid threading; when non-nil
// the handler reads the request envelope's `meta.cid` (via
// rpc.MetaFromContext) and registers it against the path so the
// fs.watch handler can stamp the matching `fs.changed` notification
// with the same cid.
func FsWrite(vaultRoot string, cor *correlator.Correlator) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.WriteTextParams
		if e := decodeParams("fs.write", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}
		registerCidIfPresent(ctx, cor, p.Path)
		mtime, e := atomicWriteFile(abs, p.Path, []byte(p.Content), p.ExpectedMtime)
		if e != nil {
			return nil, e
		}
		return proto.MtimeResult{Mtime: mtime}, nil
	}
}
