// Package watcher reports filesystem changes inside a vault root.
//
// One Watcher is created per daemon. Sessions register interest in
// vault-relative paths via Subscribe(...) and supply a callback; when
// fsnotify reports a change inside a subscribed range the callback is
// invoked synchronously on the watcher's dispatch goroutine.
//
// fsnotify itself is not recursive on Linux/Windows, so the Watcher
// walks the vault tree once at start to add every existing directory
// and adds new directories on the fly when it sees a Create event for
// one. Subscriptions can still be recursive — the matching is done
// lexically on event paths.
package watcher

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

// EventType describes the change observed on disk. Maps directly to
// the wire-level proto.FsChangeEvent values.
type EventType string

const (
	EventCreated  EventType = "created"
	EventModified EventType = "modified"
	EventDeleted  EventType = "deleted"
)

// Event is the high-level observation reported to subscribers. Paths
// are vault-relative with forward slashes — matching the rest of the
// proto.
type Event struct {
	Path string
	Type EventType
}

// Subscriber is the callback fired when an event matches a
// subscription. It runs on the watcher's dispatch goroutine, so it
// must not block — typical implementations enqueue and return.
type Subscriber func(event Event)

type subscription struct {
	id        string
	path      string // vault-relative; "" means the vault root
	recursive bool
	callback  Subscriber
}

// Watcher wraps an fsnotify watcher with a vault-relative subscription
// model. Construct one per daemon via New.
type Watcher struct {
	root    string
	notify  *fsnotify.Watcher
	stop    chan struct{}
	stopped chan struct{}

	mu   sync.Mutex
	subs map[string]*subscription
}

// New creates a Watcher rooted at vaultRoot (an absolute path). It
// walks the existing tree, adds every directory to the underlying
// fsnotify watcher, then starts dispatching events on its own
// goroutine. Close() must be called to release OS resources.
func New(vaultRoot string) (*Watcher, error) {
	abs, err := filepath.Abs(vaultRoot)
	if err != nil {
		return nil, err
	}
	notify, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &Watcher{
		root:    abs,
		notify:  notify,
		stop:    make(chan struct{}),
		stopped: make(chan struct{}),
		subs:    map[string]*subscription{},
	}

	if err := w.addTree(abs); err != nil {
		_ = notify.Close()
		return nil, err
	}

	go w.run()
	return w, nil
}

// addTree adds `root` and every existing subdirectory to the
// fsnotify watcher. fsnotify is not recursive on Linux/Windows; this
// walk closes that gap up front. New subdirectories are picked up
// lazily in the event loop when their parent fires a Create event.
func (w *Watcher) addTree(root string) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Best-effort: dropped directories or permission errors don't
			// stop the rest of the walk.
			return nil
		}
		if d.IsDir() {
			_ = w.notify.Add(path)
		}
		return nil
	})
}

// Subscribe registers an interest in `vaultPath` (recursive controls
// whether descendants are included). Returns a subscription id used
// later to Unsubscribe. The callback runs synchronously on the
// dispatch goroutine.
func (w *Watcher) Subscribe(vaultPath string, recursive bool, cb Subscriber) (string, error) {
	if cb == nil {
		return "", errors.New("watcher: callback is nil")
	}
	id, err := newSubID()
	if err != nil {
		return "", err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.subs[id] = &subscription{
		id:        id,
		path:      cleanVaultPath(vaultPath),
		recursive: recursive,
		callback:  cb,
	}
	return id, nil
}

// Unsubscribe drops the subscription created by Subscribe. Returns
// true if the id was known, false otherwise (callers can ignore the
// result for a "best-effort" cancel).
func (w *Watcher) Unsubscribe(id string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.subs[id]; !ok {
		return false
	}
	delete(w.subs, id)
	return true
}

// Close stops the dispatch goroutine and releases the underlying
// fsnotify watcher. Idempotent.
func (w *Watcher) Close() error {
	select {
	case <-w.stop:
		// Already stopped.
		return nil
	default:
		close(w.stop)
	}
	err := w.notify.Close()
	<-w.stopped
	return err
}

// run is the dispatch goroutine. It exits when Close is called.
func (w *Watcher) run() {
	defer close(w.stopped)
	for {
		select {
		case <-w.stop:
			return
		case ev, ok := <-w.notify.Events:
			if !ok {
				return
			}
			w.handleFsEvent(ev)
		case _, ok := <-w.notify.Errors:
			if !ok {
				return
			}
			// Errors from fsnotify are typically transient (a temporarily
			// unreadable directory). Drop them; the next event will still
			// arrive correctly.
		}
	}
}

func (w *Watcher) handleFsEvent(ev fsnotify.Event) {
	relative, err := filepath.Rel(w.root, ev.Name)
	if err != nil {
		return
	}
	relative = filepath.ToSlash(relative)
	// Walking up out of the root would produce a leading "..". Skip
	// such events — they shouldn't happen in practice but a
	// misbehaving fsnotify backend shouldn't crash the daemon.
	if strings.HasPrefix(relative, "..") {
		return
	}

	// Auto-watch directories created inside the tree so we keep
	// receiving events for files born inside them. Best-effort:
	// failures are ignored (we just won't see grandchild events).
	if ev.Has(fsnotify.Create) {
		if info, err := lstat(ev.Name); err == nil && info.IsDir() {
			_ = w.notify.Add(ev.Name)
			// #107: close the os.MkdirAll race. fsnotify is not
			// recursive — by the time the dispatch goroutine reaches
			// this Add, the kernel may have created descendants of
			// `ev.Name` whose IN_CREATE events were silently dropped
			// (their parent wasn't on the watch list yet). Walk the
			// new sub-tree, add any descendant directories to the
			// watcher, and emit a synthetic `created` event for every
			// path discovered so subscribers see them.
			w.catchUpAfterRace(ev.Name)
		}
	}

	out, ok := classify(ev.Op)
	if !ok {
		return // chmod and friends — not interesting
	}
	w.emit(Event{Path: relative, Type: out})
}

// emit dispatches an event to all matching subscribers under a snapshot
// of the subscription map. Callbacks run synchronously, but they hold
// no locks; an unsubscribe during dispatch is safe (we're operating on
// the snapshot).
func (w *Watcher) emit(event Event) {
	w.mu.Lock()
	subs := make([]*subscription, 0, len(w.subs))
	for _, s := range w.subs {
		if matches(s, event.Path) {
			subs = append(subs, s)
		}
	}
	w.mu.Unlock()

	for _, s := range subs {
		s.callback(event)
	}
}

// catchUpAfterRace is invoked after we Add()'d a freshly-created
// directory to the watcher. fsnotify isn't recursive, so any
// descendants the kernel created during the race window between
// IN_CREATE arriving on the events channel and our Add() call were
// never reported to us. Walk the sub-tree, add descendant
// directories to the watcher, and synthesise `created` events for
// every discovered descendant path so subscribers see them.
//
// Idempotency note: a path discovered here may also surface via a
// real fsnotify event (the kernel emitted it after our Add ran).
// Subscribers must treat duplicate `created` events as a no-op
// (the plugin-side VaultModelBuilder does — insertOne is idempotent
// against an already-present path). The race window is sub-millisecond
// in practice so duplicates are rare.
func (w *Watcher) catchUpAfterRace(absDir string) {
	_ = filepath.WalkDir(absDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // best-effort; permission errors don't stop the walk
		}
		if path == absDir {
			return nil // the dir itself was already reported by fsnotify
		}
		if d.IsDir() {
			_ = w.notify.Add(path)
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "..") {
			return nil
		}
		w.emit(Event{Path: rel, Type: EventCreated})
		return nil
	})
}

// classify maps an fsnotify op flag set to one of our high-level
// event types. Returns false when the op is one we ignore (chmod).
func classify(op fsnotify.Op) (EventType, bool) {
	switch {
	case op.Has(fsnotify.Remove), op.Has(fsnotify.Rename):
		return EventDeleted, true
	case op.Has(fsnotify.Create):
		return EventCreated, true
	case op.Has(fsnotify.Write):
		return EventModified, true
	}
	return "", false
}

// matches reports whether `relativePath` falls under subscription `s`.
//
// - empty path is the vault root; recursive subs match everything.
// - non-recursive subs match exactly the path itself, and immediate
//   children when the subscription path is a directory.
// - recursive subs match the path itself and any descendant.
func matches(s *subscription, relativePath string) bool {
	if s.path == "" || s.path == "." {
		return true // root-recursive (or root non-recursive) sees everything
	}
	if relativePath == s.path {
		return true
	}
	if s.recursive {
		return strings.HasPrefix(relativePath, s.path+"/")
	}
	// Non-recursive: an event is "in this dir" when relativePath has
	// the subscription path as its parent.
	parent := relativePath
	if i := strings.LastIndex(relativePath, "/"); i >= 0 {
		parent = relativePath[:i]
	} else {
		parent = ""
	}
	return parent == s.path
}

// cleanVaultPath normalises a vault-relative input. Strips a leading
// slash, collapses `.` and `./`, leaves paths empty for root.
func cleanVaultPath(p string) string {
	p = strings.TrimPrefix(p, "/")
	if p == "" || p == "." {
		return ""
	}
	return p
}

func newSubID() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// lstat is split out so tests can pretend a created path is a dir
// without touching disk.
var lstat = func(path string) (fs.FileInfo, error) {
	return os.Lstat(path)
}
