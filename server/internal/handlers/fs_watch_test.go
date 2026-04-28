package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/watcher"
)

type fakeWatcher struct {
	subs           map[string]watcher.Subscriber
	subscribeErr   error
	unsubscribed   []string
}

func (f *fakeWatcher) Subscribe(_ string, _ bool, cb watcher.Subscriber) (string, error) {
	if f.subscribeErr != nil {
		return "", f.subscribeErr
	}
	id := "sub-" + jsonNumber(len(f.subs))
	if f.subs == nil {
		f.subs = map[string]watcher.Subscriber{}
	}
	f.subs[id] = cb
	return id, nil
}

func (f *fakeWatcher) Unsubscribe(id string) bool {
	f.unsubscribed = append(f.unsubscribed, id)
	if _, ok := f.subs[id]; !ok {
		return false
	}
	delete(f.subs, id)
	return true
}

func jsonNumber(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestFsWatch_RegistersSubscriptionAndTracksItOnSession(t *testing.T) {
	fake := &fakeWatcher{}
	h := FsWatch(fake, nil)
	sess := server.NewSession()

	// Capture push notifications via the session's notifier.
	type push struct{ method string; params interface{} }
	pushes := []push{}
	sess.SetNotifier(func(method string, params interface{}, _ *proto.Meta) error {
		pushes = append(pushes, push{method, params})
		return nil
	})
	ctx := server.WithSession(context.Background(), sess)

	raw, _ := json.Marshal(proto.WatchParams{Path: "Notes", Recursive: true})
	result, rerr := h(ctx, raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}

	got, ok := result.(proto.WatchResult)
	if !ok {
		t.Fatalf("result type = %T, want WatchResult", result)
	}
	if got.SubscriptionID == "" {
		t.Error("SubscriptionID should be set")
	}

	// Session should have tracked the id so the connection-close
	// cleanup can drop it later.
	if ids := sess.SubscriptionIDs(); len(ids) != 1 || ids[0] != got.SubscriptionID {
		t.Errorf("session subscriptions = %v, want [%q]", ids, got.SubscriptionID)
	}

	// Drive an event through the registered callback and confirm
	// it surfaces as an fs.changed notification.
	cb := fake.subs[got.SubscriptionID]
	cb(watcher.Event{Path: "Notes/a.md", Type: watcher.EventModified})
	if len(pushes) != 1 || pushes[0].method != "fs.changed" {
		t.Fatalf("expected one fs.changed push, got %+v", pushes)
	}
	pp := pushes[0].params.(proto.FsChangedParams)
	if pp.SubscriptionID != got.SubscriptionID {
		t.Errorf("notification subscriptionId = %q, want %q", pp.SubscriptionID, got.SubscriptionID)
	}
	if pp.Path != "Notes/a.md" || pp.Event != proto.FsChangeEventModified {
		t.Errorf("notification params = %+v", pp)
	}
}

func TestFsWatch_SurfacesSubscribeError(t *testing.T) {
	fake := &fakeWatcher{subscribeErr: errors.New("boom")}
	h := FsWatch(fake, nil)
	ctx := server.WithSession(context.Background(), server.NewSession())
	raw, _ := json.Marshal(proto.WatchParams{Path: "x"})
	_, rerr := h(ctx, raw)
	if rerr == nil || rerr.Code != proto.ErrorInternalError {
		t.Fatalf("want InternalError, got %+v", rerr)
	}
}

func TestFsUnwatch_DropsSubscription(t *testing.T) {
	fake := &fakeWatcher{subs: map[string]watcher.Subscriber{
		"sub-x": func(_ watcher.Event) { /* unused */ },
	}}
	sess := server.NewSession()
	sess.AddSubscription("sub-x")
	ctx := server.WithSession(context.Background(), sess)

	h := FsUnwatch(fake)
	raw, _ := json.Marshal(proto.UnwatchParams{SubscriptionID: "sub-x"})
	_, rerr := h(ctx, raw)
	if rerr != nil {
		t.Fatalf("unexpected error: %+v", rerr)
	}
	if len(fake.unsubscribed) != 1 || fake.unsubscribed[0] != "sub-x" {
		t.Errorf("watcher.Unsubscribe was not called: %v", fake.unsubscribed)
	}
	if ids := sess.SubscriptionIDs(); len(ids) != 0 {
		t.Errorf("session should have no subscriptions left, got %v", ids)
	}
}

func TestFsUnwatch_UnknownIdSucceeds(t *testing.T) {
	fake := &fakeWatcher{}
	sess := server.NewSession()
	ctx := server.WithSession(context.Background(), sess)
	h := FsUnwatch(fake)
	raw, _ := json.Marshal(proto.UnwatchParams{SubscriptionID: "ghost"})
	if _, rerr := h(ctx, raw); rerr != nil {
		t.Fatalf("unwatching an unknown id should be a no-op success, got %+v", rerr)
	}
}
