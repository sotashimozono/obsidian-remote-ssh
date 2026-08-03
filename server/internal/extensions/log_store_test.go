package extensions

import (
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

func TestLogStore_HasLog(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	if store.HasLog("inv-missing") {
		t.Fatalf("HasLog should be false for missing invocation")
	}

	ok, err := store.AppendBatch("inv-exists", []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "line1\n", Seq: 1},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}

	if !store.HasLog("inv-exists") {
		t.Fatalf("HasLog should be true after AppendBatch")
	}
}

func TestLogStore_AppendDone(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-done-test"
	ok, err := store.AppendBatch(inv, []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "output\n", Seq: 1},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}

	if err := store.AppendDone(inv, 0, "", ""); err != nil {
		t.Fatalf("AppendDone: %v", err)
	}

	items, done, err := store.ReplayFrom(inv, 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items)=%d, want 1", len(items))
	}
	if done == nil {
		t.Fatalf("done should not be nil")
	}
	if done.ExitCode != 0 {
		t.Fatalf("ExitCode=%d, want 0", done.ExitCode)
	}
}

func TestLogStore_AppendDone_WithSignal(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-signal-test"
	if err := store.AppendDone(inv, 137, "killed", ""); err != nil {
		t.Fatalf("AppendDone: %v", err)
	}

	_, done, err := store.ReplayFrom(inv, 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if done == nil {
		t.Fatalf("done should not be nil")
	}
	if done.ExitCode != 137 || done.Signal != "killed" {
		t.Fatalf("done = %+v, want ExitCode=137 Signal=killed", done)
	}
}

func TestLogStore_AppendDone_WithReason(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}

	inv := "inv-reason-test"
	if err := store.AppendDone(inv, 137, "killed", "reaped"); err != nil {
		t.Fatalf("AppendDone: %v", err)
	}

	_, done, err := store.ReplayFrom(inv, 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if done == nil {
		t.Fatalf("done should not be nil")
	}
	if done.ExitCode != 137 || done.Signal != "killed" || done.Reason != "reaped" {
		t.Fatalf("done = %+v, want ExitCode=137 Signal=killed Reason=reaped", done)
	}
}

func TestLogStore_ReplayFrom(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}
	inv := "inv-test-1"
	ok, err := store.AppendBatch(inv, []proto.CliOutputBatchItem{
		{Stream: "stdout", Data: "line1\n", Seq: 1},
		{Stream: "stdout", Data: "line2\n", Seq: 2},
		{Stream: "stderr", Data: "line3\n", Seq: 3},
	})
	if err != nil || !ok {
		t.Fatalf("AppendBatch: ok=%v err=%v", ok, err)
	}

	items, done, err := store.ReplayFrom(inv, 1)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("len(items)=%d, want 2", len(items))
	}
	if items[0].Seq != 2 || items[1].Seq != 3 {
		t.Fatalf("unexpected seqs: %+v", items)
	}
	if done != nil {
		t.Fatalf("done should be nil for invocation without done record")
	}
}

func TestLogStore_ReplayFrom_NotFound(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}
	items, done, err := store.ReplayFrom("inv-missing", 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("len(items)=%d, want 0", len(items))
	}
	if done != nil {
		t.Fatalf("done should be nil")
	}
}

func TestLogStore_ReplayFrom_CompletedInvocation(t *testing.T) {
	tmp := t.TempDir()
	store, err := NewLogStore(tmp)
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

	items, done, err := store.ReplayFrom(inv, 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items)=%d, want 1", len(items))
	}
	if done == nil {
		t.Fatalf("done should not be nil for completed invocation")
	}
	if done.ExitCode != 0 {
		t.Fatalf("ExitCode=%d, want 0", done.ExitCode)
	}
}
