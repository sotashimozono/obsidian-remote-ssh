package handlers

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/extensions"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

func TestValidateAndBuildArgs_RejectsLeadingDash(t *testing.T) {
	cap := proto.ExtensionCapability{
		Tool: "tool",
		Args: []proto.ExtensionArgRule{{
			Name:      "prompt",
			Required:  true,
			MaxLength: 1024,
		}},
	}
	_, err := validateAndBuildArgs(cap, map[string]string{"prompt": "--config /tmp/evil.yaml"})
	if err == nil {
		t.Fatalf("expected error for leading dash")
	}
	if !strings.Contains(err.Error(), "must not start") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateAndBuildArgs_AllowsLeadingDashWhenConfigured(t *testing.T) {
	cap := proto.ExtensionCapability{
		Tool: "tool",
		Args: []proto.ExtensionArgRule{{
			Name:       "flag",
			Required:   true,
			AllowFlags: true,
		}},
	}
	args, err := validateAndBuildArgs(cap, map[string]string{"flag": "--help"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(args) != 1 || args[0] != "--help" {
		t.Fatalf("args = %v, want [--help]", args)
	}
}

func TestExtensionKill_NotFound_ReturnsKilledFalse(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	h := r.Kill()

	ctx := server.WithSession(context.Background(), server.NewSession())
	res, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-missing"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	out, ok := res.(proto.ExtensionKillResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if out.Killed {
		t.Fatalf("Killed = true, want false")
	}
}

func TestExtensionKill_ExistingInvocationCanBeKilled(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	owner := server.NewSession()
	called := false
	r.registerInvocation("inv-2", owner, "batch", func() error {
		called = true
		return nil
	})

	h := r.Kill()
	ownerCtx := server.WithSession(context.Background(), owner)
	res, rpcErr := h(ownerCtx, json.RawMessage(`{"invocationId":"inv-2"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	out, ok := res.(proto.ExtensionKillResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if !out.Killed {
		t.Fatalf("Killed = false, want true")
	}
	if !called {
		t.Fatalf("stop should be called for owner session")
	}
}

func TestExtensionKill_CompatAlias(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	r.registerInvocation("inv-3", server.NewSession(), "batch", func() error {
		return nil
	})

	h := r.KillCompat()
	ctx := server.WithSession(context.Background(), server.NewSession())
	res, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-3"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	out, ok := res.(proto.ExtensionKillResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if !out.Killed {
		t.Fatalf("Killed = false, want true")
	}
}

func TestExtensionInvoke_ResumeFromCompletedInvocation(t *testing.T) {
	tmp := t.TempDir()
	store, err := extensions.NewLogStore(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-completed"
	ok, err := store.AppendBatch(inv, []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "output\n", Seq: 1},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}
	if err := store.AppendDone(inv, 0, "", ""); err != nil {
		t.Fatalf("AppendDone: %v", err)
	}

	r := NewExtensionRunner(nil, store, "")

	receiver := server.NewSession()
	notified := false
	doneNotified := false
	receiver.SetNotifier(func(method string, params interface{}, _ *proto.Meta) error {
		switch method {
		case "cli.output.batch":
			notified = true
		case "cli.done":
			doneNotified = true
		}
		return nil
	})

	h := r.Invoke()
	ctx := server.WithSession(context.Background(), receiver)
	res, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-completed","resumeFrom":0}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	out, ok := res.(proto.ExtensionInvokeResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if out.InvocationID != "inv-completed" || !out.Accepted {
		t.Fatalf("unexpected result: %+v", out)
	}
	if !notified {
		t.Fatalf("expected replay notification")
	}
	if !doneNotified {
		t.Fatalf("expected cli.done notification for completed invocation")
	}
}

func TestExtensionInvoke_ResumeFromMissingInvocation(t *testing.T) {
	tmp := t.TempDir()
	store, err := extensions.NewLogStore(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	r := NewExtensionRunner(nil, store, "")

	h := r.Invoke()
	ctx := server.WithSession(context.Background(), server.NewSession())
	_, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-missing","resumeFrom":0}`))
	if rpcErr == nil {
		t.Fatalf("expected rpc error for missing invocation")
	}
}

func TestExtensionInvoke_ResumeFromRunningInvocation(t *testing.T) {
	tmp := t.TempDir()
	store, err := extensions.NewLogStore(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-running"
	ok, err := store.AppendBatch(inv, []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "line1\n", Seq: 1},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}

	r := NewExtensionRunner(nil, store, "")
	owner := server.NewSession()
	r.registerInvocation(inv, owner, "batch", func() error { return nil })

	receiver := server.NewSession()
	notified := false
	receiver.SetNotifier(func(method string, params interface{}, _ *proto.Meta) error {
		if method == "cli.output.batch" {
			notified = true
		}
		return nil
	})

	h := r.Invoke()
	ctx := server.WithSession(context.Background(), receiver)
	res, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-running","resumeFrom":0}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	out, ok := res.(proto.ExtensionInvokeResult)
	if !ok {
		t.Fatalf("unexpected result type: %T", res)
	}
	if out.InvocationID != "inv-running" || !out.Accepted {
		t.Fatalf("unexpected result: %+v", out)
	}
	if !notified {
		t.Fatalf("expected replay notification")
	}

	// Verify session was rebound
	s := r.currentInvocationSession(inv)
	if s != receiver {
		t.Fatalf("session should be rebound to receiver")
	}
}

func TestExtensionInvoke_ResumeFromWithDoneAtEnd(t *testing.T) {
	tmp := t.TempDir()
	store, err := extensions.NewLogStore(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-done-at-end"
	ok, err := store.AppendBatch(inv, []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "line1\n", Seq: 1},
		{Stream: "stdout", Data: "line2\n", Seq: 2},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}
	if err := store.AppendDone(inv, 0, "", ""); err != nil {
		t.Fatalf("AppendDone: %v", err)
	}

	r := NewExtensionRunner(nil, store, "")

	receiver := server.NewSession()
	itemsReceived := 0
	doneReceived := false
	receiver.SetNotifier(func(method string, params interface{}, _ *proto.Meta) error {
		switch method {
		case "cli.output.batch":
			itemsReceived++
		case "cli.done":
			doneReceived = true
		}
		return nil
	})

	h := r.Invoke()
	ctx := server.WithSession(context.Background(), receiver)
	_, rpcErr := h(ctx, json.RawMessage(`{"invocationId":"inv-done-at-end","resumeFrom":0}`))
	if rpcErr != nil {
		t.Fatalf("unexpected rpc error: %v", rpcErr)
	}
	if itemsReceived != 1 {
		t.Fatalf("expected 1 batch notification, got %d", itemsReceived)
	}
	if !doneReceived {
		t.Fatalf("expected cli.done notification")
	}
}

func TestReapOldestOrphan_PicksOldestOrphanOnly(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	var killed []string
	record := func(id string) func() error {
		return func() error {
			killed = append(killed, id)
			return nil
		}
	}

	r.registerInvocation("inv-old", nil, "batch", record("inv-old"))
	time.Sleep(time.Millisecond) // separate startedAt ticks
	r.registerInvocation("inv-new", nil, "batch", record("inv-new"))

	live := server.NewSession()
	r.registerInvocation("inv-live", live, "batch", record("inv-live"))

	if !r.reapOldestOrphan() {
		t.Fatalf("reapOldestOrphan = false, want true for an orphan")
	}
	if len(killed) != 1 || killed[0] != "inv-old" {
		t.Fatalf("killed = %v, want [inv-old] (oldest orphan, live untouched)", killed)
	}
	if inv, ok := r.lookupInvocation("inv-old"); !ok || inv.doneReason != "reaped" {
		t.Fatalf("inv-old doneReason = %q, want reaped", inv.doneReason)
	}
	if inv, ok := r.lookupInvocation("inv-live"); !ok || inv.doneReason != "" {
		t.Fatalf("inv-live doneReason = %q, want empty", inv.doneReason)
	}

	if !r.reapOldestOrphan() {
		t.Fatalf("reapOldestOrphan = false, want true for remaining orphan")
	}
	if len(killed) != 2 || killed[1] != "inv-new" {
		t.Fatalf("killed = %v, want second kill inv-new", killed)
	}

	if r.reapOldestOrphan() {
		t.Fatalf("reapOldestOrphan = true, want false when only live sessions remain")
	}
}

func TestSessionOnClose_DetachesInvocation(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	sess := server.NewSession()
	r.registerInvocation("inv-close", sess, "batch", func() error { return nil })

	if got := r.currentInvocationSession("inv-close"); got != sess {
		t.Fatalf("session = %v, want registered session", got)
	}

	sess.Close()

	if got := r.currentInvocationSession("inv-close"); got != nil {
		t.Fatalf("session = %v, want nil after Close", got)
	}
}

func TestSessionOnClose_StaleCallbackDoesNotDetachReboundSession(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	oldSess := server.NewSession()
	newSess := server.NewSession()
	r.registerInvocation("inv-rebind", oldSess, "batch", func() error { return nil })
	r.rebindInvocation("inv-rebind", newSess)

	// The old connection dies after a resume rebinds the invocation: the
	// stale OnClose callback must not detach the fresh session.
	oldSess.Close()

	if got := r.currentInvocationSession("inv-rebind"); got != newSess {
		t.Fatalf("session = %v, want rebound session preserved", got)
	}
}

func TestMarkDoneReason_FirstWriteWins(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	r.registerInvocation("inv-reason", nil, "batch", func() error { return nil })

	r.markDoneReason("inv-reason", "reaped")
	r.markDoneReason("inv-reason", "killed")

	if inv, ok := r.lookupInvocation("inv-reason"); !ok || inv.doneReason != "reaped" {
		t.Fatalf("doneReason = %q, want reaped (first write wins)", inv.doneReason)
	}
}

func TestClearInvocationSessionIf_PreservesReboundSession(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	oldSess := server.NewSession()
	newSess := server.NewSession()
	r.registerInvocation("inv-rebind", oldSess, "batch", func() error { return nil })

	// A resumeInvoke rebinds a fresh session…
	r.rebindInvocation("inv-rebind", newSess)
	// …then a stale send failure from the old session must not detach it.
	r.clearInvocationSessionIf("inv-rebind", oldSess)

	if got := r.currentInvocationSession("inv-rebind"); got != newSess {
		t.Fatalf("session = %v, want rebound session preserved", got)
	}
}

func TestClearInvocationSessionIf_ClearsMatchingSession(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")
	sess := server.NewSession()
	r.registerInvocation("inv-clear", sess, "batch", func() error { return nil })

	r.clearInvocationSessionIf("inv-clear", sess)

	if got := r.currentInvocationSession("inv-clear"); got != nil {
		t.Fatalf("session = %v, want nil", got)
	}
}
