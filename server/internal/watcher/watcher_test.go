package watcher

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// waitForEvent polls a "received" slot for up to 2 s. fsnotify
// usually fires within a few ms but can take longer on Windows.
func waitForEvent(t *testing.T, get func() (Event, bool)) Event {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if e, ok := get(); ok {
			return e
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for filesystem event")
	return Event{}
}

func TestWatcher_NotifiesOnFileWrite(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	var (
		mu    sync.Mutex
		seen  []Event
	)
	if _, err := w.Subscribe("", true, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, ev)
	}); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := waitForEvent(t, func() (Event, bool) {
		mu.Lock()
		defer mu.Unlock()
		// We tolerate either Created or Modified for the first arrival
		// since some platforms emit both back-to-back.
		for _, e := range seen {
			if e.Path == "a.md" && (e.Type == EventCreated || e.Type == EventModified) {
				return e, true
			}
		}
		return Event{}, false
	})
	_ = got // assertion is implicit in waitForEvent's success
}

func TestWatcher_NonRecursiveOnlySeesOwnDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "outer", "inner"), 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	var (
		mu     sync.Mutex
		seen   []Event
	)
	// Subscribe to "outer" only, non-recursive.
	if _, err := w.Subscribe("outer", false, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, ev)
	}); err != nil {
		t.Fatal(err)
	}

	// Touch a file in outer/ — should fire.
	if err := os.WriteFile(filepath.Join(root, "outer", "x.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Touch a file in outer/inner/ — should NOT fire.
	if err := os.WriteFile(filepath.Join(root, "outer", "inner", "y.md"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Wait a bit, then check what we got.
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	sawX := false
	for _, e := range seen {
		if e.Path == "outer/x.md" {
			sawX = true
		}
		if e.Path == "outer/inner/y.md" {
			t.Errorf("non-recursive sub should not see deep file, got %+v", e)
		}
	}
	if !sawX {
		t.Errorf("expected event for outer/x.md, got %v", seen)
	}
}

func TestWatcher_RecursiveSeesNestedFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "a", "b", "c"), 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	got := make(chan Event, 8)
	if _, err := w.Subscribe("a", true, func(ev Event) { got <- ev }); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(root, "a", "b", "c", "leaf.md"), []byte("leaf"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-got:
			if ev.Path == "a/b/c/leaf.md" {
				return // pass
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a/b/c/leaf.md event")
		}
	}
}

func TestWatcher_UnsubscribeStopsCallbacks(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	var fired bool
	id, err := w.Subscribe("", true, func(_ Event) { fired = true })
	if err != nil {
		t.Fatal(err)
	}
	if !w.Unsubscribe(id) {
		t.Fatal("Unsubscribe returned false on a known id")
	}

	if err := os.WriteFile(filepath.Join(root, "x.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if fired {
		t.Error("callback ran after Unsubscribe")
	}
}

func TestWatcher_PicksUpNewSubdirs(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	got := make(chan Event, 8)
	if _, err := w.Subscribe("", true, func(ev Event) { got <- ev }); err != nil {
		t.Fatal(err)
	}

	// Create a brand-new subdir, then a file in it.
	if err := os.MkdirAll(filepath.Join(root, "fresh"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Wait for the dir event to flush so the auto-add logic runs.
	time.Sleep(200 * time.Millisecond)
	if err := os.WriteFile(filepath.Join(root, "fresh", "new.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-got:
			if ev.Path == "fresh/new.md" {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for fresh/new.md event (auto-watch of new dir failed?)")
		}
	}
}

// #107: a single os.MkdirAll for a multi-level path used to drop the
// IN_CREATE events for everything below the first new directory,
// because the dispatch goroutine adds the new dir to the watcher
// AFTER the kernel has already created the children. catchUpAfterRace
// closes that gap by walking the new sub-tree and emitting synthetic
// `created` events for descendants the watcher would otherwise miss.
func TestWatcher_AutoWatchRaceForMkdirAll(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	got := make(chan Event, 16)
	if _, err := w.Subscribe("", true, func(ev Event) { got <- ev }); err != nil {
		t.Fatal(err)
	}

	// Single MkdirAll for a 3-level deep tree — the kernel creates
	// level1, level2, level3 in fast succession. Without the race
	// fix only level1 would surface to the subscriber.
	if err := os.MkdirAll(filepath.Join(root, "level1", "level2", "level3"), 0o755); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(2 * time.Second)
	seen := map[string]bool{}
	for {
		select {
		case ev := <-got:
			if ev.Type == EventCreated {
				seen[ev.Path] = true
			}
			// Stop early once we have all three.
			if seen["level1"] && seen["level1/level2"] && seen["level1/level2/level3"] {
				return // pass
			}
		case <-deadline:
			t.Fatalf("timed out waiting for nested-create events; saw=%v", seen)
		}
	}
}

// Companion to the race test above: after the catch-up walk added
// `a/b` to the watcher, a brand-new file inside `b` must surface as
// a normal fsnotify event (proving the watcher is actually wired
// into the descendants, not just emitting one-shot synthetic events).
func TestWatcher_AfterRaceCatchUp_DescendantWritesStillFire(t *testing.T) {
	root := t.TempDir()
	w, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	got := make(chan Event, 16)
	if _, err := w.Subscribe("", true, func(ev Event) { got <- ev }); err != nil {
		t.Fatal(err)
	}

	// Trigger the race (creates the deep tree in one syscall).
	if err := os.MkdirAll(filepath.Join(root, "a", "b"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Give the catch-up walk a beat to add `a/b` to the watcher.
	time.Sleep(200 * time.Millisecond)

	// Now write a file inside the freshly-discovered descendant. If
	// catch-up properly added `a/b` to the inotify watch list, this
	// fires a real fsnotify event (not a synthesised one).
	if err := os.WriteFile(filepath.Join(root, "a", "b", "leaf.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-got:
			if ev.Path == "a/b/leaf.md" {
				return // pass
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a/b/leaf.md event after race catch-up")
		}
	}
}

func TestWatcher_UnsubscribeUnknownIdReturnsFalse(t *testing.T) {
	w, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if w.Unsubscribe("nope") {
		t.Error("Unsubscribe should return false for an unknown id")
	}
}

func TestWatcher_CloseIsIdempotent(t *testing.T) {
	w, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Errorf("second close should be a no-op, got %v", err)
	}
}

// matches() unit tests run without filesystem to keep them fast.
func TestMatches(t *testing.T) {
	cases := []struct {
		name      string
		sub       *subscription
		path      string
		want      bool
	}{
		{"root-recursive sees everything",      &subscription{path: "", recursive: true},   "a/b/c.md", true},
		{"root-recursive sees a top-level file", &subscription{path: "", recursive: true},   "a.md",     true},
		{"recursive matches descendant",         &subscription{path: "docs", recursive: true}, "docs/a.md", true},
		{"recursive matches deep descendant",    &subscription{path: "docs", recursive: true}, "docs/sub/b.md", true},
		{"recursive does not match sibling prefix", &subscription{path: "docs", recursive: true}, "docs2/a.md", false},
		{"non-recursive matches direct child",   &subscription{path: "docs", recursive: false}, "docs/a.md", true},
		{"non-recursive misses grandchild",      &subscription{path: "docs", recursive: false}, "docs/sub/a.md", false},
		{"matches the subscription path itself", &subscription{path: "note.md", recursive: false}, "note.md", true},
		{"unrelated path",                       &subscription{path: "docs", recursive: true}, "Notes/a.md", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := matches(tc.sub, tc.path); got != tc.want {
				t.Errorf("matches(%+v, %q) = %v, want %v", tc.sub, tc.path, got, tc.want)
			}
		})
	}
}
