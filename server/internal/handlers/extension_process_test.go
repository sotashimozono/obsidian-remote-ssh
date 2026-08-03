//go:build unix

package handlers

import (
	"errors"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/extensions"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

func TestStreamProcess_ReapsOrphanedInvocation(t *testing.T) {
	tmp := t.TempDir()
	store, err := extensions.NewLogStore(filepath.Join(tmp, "state"))
	if err != nil {
		t.Fatalf("NewLogStore: %v", err)
	}
	r := NewExtensionRunner(nil, store, "")

	// exec (not a child sleep) so that killing the process closes the
	// pipes immediately — a leftover child would keep the write end open
	// and the scanStream goroutine would never see EOF.
	cmd := exec.Command("sh", "-c", "echo hello; exec sleep 30")
	setProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("StderrPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer killProcessGroup(cmd)

	// Client whose notifier always fails: simulate a dropped connection.
	sess := server.NewSession()
	sess.SetNotifier(func(_ string, _ interface{}, _ *proto.Meta) error {
		return errors.New("client gone")
	})
	inv := "inv-orphan"
	r.registerInvocation(inv, sess, "batch", func() error { return killProcessGroup(cmd) })

	released := make(chan struct{})
	go r.streamProcess(inv, cmd, stdout, stderr, true, "batch", func() { close(released) })

	// Send-failure detection clears the session (orphan), then the lazy
	// reaper reclaims the slot when a new invoke needs it.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if r.currentInvocationSession(inv) == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if r.currentInvocationSession(inv) != nil {
		t.Fatalf("session was not cleared after send failure")
	}
	if !r.reapOldestOrphan() {
		t.Fatalf("reapOldestOrphan should find the orphan")
	}

	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatalf("orphaned invocation was not reaped within 5s")
	}

	if _, ok := r.lookupInvocation(inv); ok {
		t.Fatalf("invocation %q should be unregistered after reap", inv)
	}

	// The reaped invocation's done record must carry the reap reason.
	_, done, err := store.ReplayFrom(inv, 0)
	if err != nil {
		t.Fatalf("ReplayFrom: %v", err)
	}
	if done == nil || done.Reason != "reaped" {
		t.Fatalf("done = %+v, want Reason=reaped", done)
	}
}

func TestStreamProcess_KeepsProcessAliveWithLiveSession(t *testing.T) {
	r := NewExtensionRunner(nil, nil, "")

	cmd := exec.Command("sh", "-c", "echo hello; exec sleep 30")
	setProcessGroup(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("StderrPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer killProcessGroup(cmd)

	sess := server.NewSession()
	sess.SetNotifier(func(_ string, _ interface{}, _ *proto.Meta) error { return nil })
	inv := "inv-live"
	r.registerInvocation(inv, sess, "batch", func() error { return killProcessGroup(cmd) })

	released := make(chan struct{})
	go r.streamProcess(inv, cmd, stdout, stderr, false, "batch", func() { close(released) })

	// A live session must never be reaped, even under pool pressure.
	if r.reapOldestOrphan() {
		t.Fatalf("reapOldestOrphan should not reap a live invocation")
	}
	time.Sleep(100 * time.Millisecond)
	select {
	case <-released:
		t.Fatalf("live invocation was reaped")
	default:
	}

	// Cleanup: kill and expect the natural teardown path.
	_ = killProcessGroup(cmd)
	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatalf("streamProcess did not exit after kill")
	}
}
