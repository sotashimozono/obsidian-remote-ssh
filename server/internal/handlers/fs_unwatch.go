package handlers

import (
	"context"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

// FsUnwatch returns the handler for `fs.unwatch`. The id is dropped
// from the watcher and from the session's subscription set.
//
// An unknown id is not an error — the client may have raced a
// connection close, and re-issuing the unwatch is safe. The handler
// returns an empty success in that case so the client can proceed.
func FsUnwatch(w WatcherCore) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.UnwatchParams
		if e := decodeParams("fs.unwatch", params, &p); e != nil {
			return nil, e
		}
		session := server.SessionFromContext(ctx)
		w.Unsubscribe(p.SubscriptionID)
		session.RemoveSubscription(p.SubscriptionID)
		return struct{}{}, nil
	}
}
