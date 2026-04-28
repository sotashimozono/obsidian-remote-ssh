// Package correlator threads a writer-side correlation id (cid) from
// an inbound RPC mutation through to the outbound fs.changed
// notification triggered by that mutation. Used by Phase C's
// cross-process sync-latency telemetry: the plugin's PerfTracer mints
// a cid before fs.write, wraps it in the request envelope's
// `meta.cid`, and the daemon registers it here keyed by the file path
// it's about to mutate. When the watcher fires for that path, the
// fs.watch handler Takes the cid back out and stamps it on the
// outgoing notification's envelope `meta`. The client then joins its
// reader-side spans (T4a / S.app / T5a) to the same cid as the
// writer-side spans (S.adp / S.rpc).
//
// Correctness model: last-writer-wins. Two clients writing the same
// path within the TTL window will see the second cid attached to both
// notifications — acceptable, because cid is a *perf attribution*
// signal, not a semantic one. A missed correlation degrades to
// per-event cid (the same fallback the plugin already uses when meta
// is absent), never to incorrect data.
package correlator

import (
	"sync"
	"time"
)

// DefaultTTL is how long a registered cid stays live waiting for its
// matching fs.changed event. fsnotify normally fires within
// milliseconds of the inode change, but we leave a healthy margin so
// a slow client / loaded daemon doesn't drop the correlation.
const DefaultTTL = 5 * time.Second

// Correlator is a path-keyed table of live cids. Safe for concurrent
// use; designed for hot-path Register on every write and Take on
// every watcher event.
type Correlator struct {
	mu       sync.Mutex
	now      func() time.Time // injectable for tests
	ttl      time.Duration
	entries  map[string]entry
	sweepHwm int // amortise sweep: only when len > sweepHwm
}

type entry struct {
	cid       string
	expiresAt time.Time
}

// New returns a Correlator with the given TTL. ttl <= 0 falls back to
// DefaultTTL. Pass time.Now (or a test fake) for the clock.
func New(ttl time.Duration, now func() time.Time) *Correlator {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if now == nil {
		now = time.Now
	}
	return &Correlator{
		ttl:      ttl,
		now:      now,
		entries:  map[string]entry{},
		sweepHwm: 16,
	}
}

// Register associates cid with path. Empty cid or empty path is a
// no-op (handlers can blindly call Register without a guard for the
// "no meta on the wire" case).
//
// If the same path was already registered with a different cid (e.g.
// two clients writing concurrently), the latest write wins. The TTL
// resets on every Register call.
func (c *Correlator) Register(path, cid string) {
	if cid == "" || path == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) > c.sweepHwm {
		c.sweepLocked()
	}
	c.entries[path] = entry{cid: cid, expiresAt: c.now().Add(c.ttl)}
}

// Take returns the cid registered for path and removes the entry.
// Returns "" when no live cid is registered (never registered, or
// expired). Safe to call from the watcher's dispatch goroutine.
func (c *Correlator) Take(path string) string {
	if path == "" {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[path]
	if !ok {
		return ""
	}
	delete(c.entries, path)
	if c.now().After(e.expiresAt) {
		return ""
	}
	return e.cid
}

// Len reports the number of live entries (intended for tests / metrics,
// not a hot-path call).
func (c *Correlator) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// sweepLocked drops expired entries. Called amortised from Register
// so the table doesn't grow unbounded when clients write paths the
// watcher never reports on (e.g. a write into a directory that's not
// being watched).
func (c *Correlator) sweepLocked() {
	now := c.now()
	for k, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, k)
		}
	}
}
