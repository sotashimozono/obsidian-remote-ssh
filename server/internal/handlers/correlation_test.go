package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/correlator"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/watcher"
)

// End-to-end Phase C cid correlation: an fs.write whose request
// envelope carries `meta.cid` should produce an fs.changed
// notification whose envelope `meta.cid` matches. Without this, the
// plugin's reader-side spans (T4a / S.app / T5a) can't be joined to
// its writer-side spans (S.adp / S.rpc) for cross-process latency
// measurement.

type capturedPush struct {
	method string
	params interface{}
	meta   *proto.Meta
}

func TestCidCorrelation_WriteToFsChanged(t *testing.T) {
	root := t.TempDir()
	cor := correlator.New(time.Second, time.Now)

	// Stand up the writer: fs.write registers cid against the path
	// before performing the disk write.
	writeH := FsWrite(root, cor)

	// Stand up the watcher: fs.watch's subscriber callback Takes the
	// cid by path and stamps it on the outgoing notification.
	fake := &fakeWatcher{}
	watchH := FsWatch(fake, cor)

	// One session captures every push so we can inspect the meta on
	// the notification fs.watch produces.
	var pushes []capturedPush
	sess := server.NewSession()
	sess.SetNotifier(func(method string, params interface{}, meta *proto.Meta) error {
		pushes = append(pushes, capturedPush{method, params, meta})
		return nil
	})
	ctx := server.WithSession(context.Background(), sess)

	// 1. Subscribe.
	subParams, _ := json.Marshal(proto.WatchParams{Path: "", Recursive: true})
	subResult, rerr := watchH(ctx, subParams)
	if rerr != nil {
		t.Fatalf("fs.watch: %+v", rerr)
	}
	subID := subResult.(proto.WatchResult).SubscriptionID

	// 2. Write with meta.cid on the request envelope. The dispatcher
	//    is what attaches Meta to ctx in production; we simulate that
	//    directly with rpc.ContextWithMeta so the test stays focused
	//    on the handler ↔ correlator wiring.
	writeCtx := rpc.ContextWithMeta(ctx, &proto.Meta{Cid: "feedfacedeadbeef"})
	writeParams, _ := json.Marshal(proto.WriteTextParams{
		Path:    "note.md",
		Content: "hi",
	})
	if _, rerr := writeH(writeCtx, writeParams); rerr != nil {
		t.Fatalf("fs.write: %+v", rerr)
	}

	// 3. The watcher hasn't fired yet — drive the callback manually
	//    with the same path the writer registered.
	cb := fake.subs[subID]
	if cb == nil {
		t.Fatalf("subscriber for %q not registered", subID)
	}
	cb(watcherEvent("note.md", "modified"))

	// 4. The pushed notification should carry the cid.
	if len(pushes) != 1 {
		t.Fatalf("expected exactly one fs.changed push, got %d: %+v", len(pushes), pushes)
	}
	if pushes[0].method != "fs.changed" {
		t.Errorf("method = %q, want fs.changed", pushes[0].method)
	}
	if pushes[0].meta == nil {
		t.Fatalf("notification meta is nil — cid was not threaded through")
	}
	if got := pushes[0].meta.Cid; got != "feedfacedeadbeef" {
		t.Errorf("notification meta.cid = %q, want feedfacedeadbeef", got)
	}

	// And the correlator should be drained — Take is one-shot.
	if l := cor.Len(); l != 0 {
		t.Errorf("correlator should be empty after Take; Len = %d", l)
	}
}

func TestCidCorrelation_NoMetaPreservesPreviousWireShape(t *testing.T) {
	// When the request envelope has no meta, the resulting fs.changed
	// notification must go out with meta=nil (not {} or any other
	// distinguishable shape) so older plugins that don't read meta
	// see exactly the wire bytes they used to.
	root := t.TempDir()
	cor := correlator.New(time.Second, time.Now)
	writeH := FsWrite(root, cor)
	fake := &fakeWatcher{}
	watchH := FsWatch(fake, cor)

	var pushes []capturedPush
	sess := server.NewSession()
	sess.SetNotifier(func(method string, params interface{}, meta *proto.Meta) error {
		pushes = append(pushes, capturedPush{method, params, meta})
		return nil
	})
	ctx := server.WithSession(context.Background(), sess)

	subParams, _ := json.Marshal(proto.WatchParams{Path: "", Recursive: true})
	subResult, _ := watchH(ctx, subParams)
	subID := subResult.(proto.WatchResult).SubscriptionID

	// Write WITHOUT attaching meta to ctx.
	writeParams, _ := json.Marshal(proto.WriteTextParams{Path: "note.md", Content: "hi"})
	if _, rerr := writeH(ctx, writeParams); rerr != nil {
		t.Fatalf("fs.write: %+v", rerr)
	}
	fake.subs[subID](watcherEvent("note.md", "modified"))

	if len(pushes) != 1 {
		t.Fatalf("expected one push, got %d", len(pushes))
	}
	if pushes[0].meta != nil {
		t.Errorf("notification meta = %+v, want nil (pre-meta wire shape)", pushes[0].meta)
	}
}

func TestCidCorrelation_NilCorrelatorIsTransparent(t *testing.T) {
	// Daemons built with a nil correlator (cid threading disabled at
	// startup) must keep working: write succeeds, notification fires,
	// no meta on the wire.
	root := t.TempDir()
	writeH := FsWrite(root, nil)
	fake := &fakeWatcher{}
	watchH := FsWatch(fake, nil)

	var pushes []capturedPush
	sess := server.NewSession()
	sess.SetNotifier(func(method string, params interface{}, meta *proto.Meta) error {
		pushes = append(pushes, capturedPush{method, params, meta})
		return nil
	})
	ctx := server.WithSession(context.Background(), sess)

	subParams, _ := json.Marshal(proto.WatchParams{Path: "", Recursive: true})
	subResult, _ := watchH(ctx, subParams)
	subID := subResult.(proto.WatchResult).SubscriptionID

	// Even with meta on ctx, a nil correlator means no registration → no echo.
	writeCtx := rpc.ContextWithMeta(ctx, &proto.Meta{Cid: "abcdef0123456789"})
	writeParams, _ := json.Marshal(proto.WriteTextParams{Path: "note.md", Content: "hi"})
	if _, rerr := writeH(writeCtx, writeParams); rerr != nil {
		t.Fatalf("fs.write: %+v", rerr)
	}
	fake.subs[subID](watcherEvent("note.md", "modified"))

	if len(pushes) != 1 || pushes[0].meta != nil {
		t.Errorf("nil correlator should produce notifications with no meta; got %+v", pushes)
	}
}

func TestCidCorrelation_RenameRegistersBothPaths(t *testing.T) {
	// fsnotify reports rename as "deleted" on the source AND
	// "created" on the destination. The handler registers cid for
	// both paths so whichever event fires first carries the cid back.
	root := t.TempDir()
	// Pre-create the source so rename succeeds.
	if err := writeStringTo(root, "old.md", "hi"); err != nil {
		t.Fatal(err)
	}

	cor := correlator.New(time.Second, time.Now)
	renameH := FsRename(root, cor)
	fake := &fakeWatcher{}
	watchH := FsWatch(fake, cor)

	var pushes []capturedPush
	sess := server.NewSession()
	sess.SetNotifier(func(method string, params interface{}, meta *proto.Meta) error {
		pushes = append(pushes, capturedPush{method, params, meta})
		return nil
	})
	ctx := server.WithSession(context.Background(), sess)
	subParams, _ := json.Marshal(proto.WatchParams{Path: "", Recursive: true})
	subResult, _ := watchH(ctx, subParams)
	subID := subResult.(proto.WatchResult).SubscriptionID

	cidV := "abcdef0011223344"
	rCtx := rpc.ContextWithMeta(ctx, &proto.Meta{Cid: cidV})
	rParams, _ := json.Marshal(proto.RenameParams{OldPath: "old.md", NewPath: "new.md"})
	if _, rerr := renameH(rCtx, rParams); rerr != nil {
		t.Fatalf("fs.rename: %+v", rerr)
	}
	// Drive the deleted-on-source event.
	fake.subs[subID](watcherEvent("old.md", "deleted"))
	// And the created-on-dest event.
	fake.subs[subID](watcherEvent("new.md", "created"))

	if len(pushes) != 2 {
		t.Fatalf("expected 2 pushes, got %d", len(pushes))
	}
	for i, p := range pushes {
		if p.meta == nil || p.meta.Cid != cidV {
			t.Errorf("push[%d] meta = %+v, want cid=%q on both paths", i, p.meta, cidV)
		}
	}
}

// ── tiny helpers ──────────────────────────────────────────────────────

func watcherEvent(path, kind string) watcher.Event {
	var t watcher.EventType
	switch kind {
	case "created":
		t = watcher.EventCreated
	case "modified":
		t = watcher.EventModified
	case "deleted":
		t = watcher.EventDeleted
	}
	return watcher.Event{Path: path, Type: t}
}

func writeStringTo(root, vaultRel, content string) error {
	abs := filepath.Join(root, vaultRel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	return os.WriteFile(abs, []byte(content), 0o644)
}
