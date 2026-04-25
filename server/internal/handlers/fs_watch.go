package handlers

import (
	"context"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/watcher"
)

// WatcherCore is the slice of watcher.Watcher this handler relies on.
// Defining it as an interface keeps the handler isolated from
// fsnotify in tests — a tiny in-memory fake satisfies it.
type WatcherCore interface {
	Subscribe(vaultPath string, recursive bool, cb watcher.Subscriber) (string, error)
	Unsubscribe(id string) bool
}

// FsWatch returns the handler for `fs.watch`. Sessions register
// interest in a vault-relative path; events bubble back via the
// session's notifier as `fs.changed` push frames.
//
// Resolved subscription ids are tracked on the Session so the server
// can drop them via SubscriptionCleaner when the connection closes
// — the watcher must not keep firing callbacks against a dead writer.
func FsWatch(w WatcherCore) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.WatchParams
		if e := decodeParams("fs.watch", params, &p); e != nil {
			return nil, e
		}
		session := server.SessionFromContext(ctx)

		var subID string
		var setupErr error
		subID, setupErr = w.Subscribe(p.Path, p.Recursive, func(ev watcher.Event) {
			notifyParams := proto.FsChangedParams{
				SubscriptionID: subID,
				Path:           ev.Path,
				Event:          mapEventType(ev.Type),
			}
			// We deliberately ignore SendNotification errors: the
			// connection has likely gone away, in which case the
			// watcher will be unsubscribed shortly anyway.
			_ = session.SendNotification("fs.changed", notifyParams)
		})
		if setupErr != nil {
			return nil, rpc.ErrInternal("fs.watch: " + setupErr.Error())
		}
		session.AddSubscription(subID)
		return proto.WatchResult{SubscriptionID: subID}, nil
	}
}

func mapEventType(t watcher.EventType) proto.FsChangeEvent {
	switch t {
	case watcher.EventCreated:
		return proto.FsChangeEventCreated
	case watcher.EventDeleted:
		return proto.FsChangeEventDeleted
	case watcher.EventModified:
		return proto.FsChangeEventModified
	}
	return proto.FsChangeEventModified
}
