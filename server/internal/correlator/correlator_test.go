package correlator

import (
	"sync"
	"testing"
	"time"
)

// fakeClock returns a controllable time source for TTL tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock(start time.Time) *fakeClock { return &fakeClock{t: start} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func TestCorrelator_RegisterTake_RoundTrip(t *testing.T) {
	c := New(time.Second, time.Now)
	c.Register("notes/a.md", "feedfacedeadbeef")
	got := c.Take("notes/a.md")
	if got != "feedfacedeadbeef" {
		t.Fatalf("Take = %q, want feedfacedeadbeef", got)
	}
	if l := c.Len(); l != 0 {
		t.Errorf("Take should clear the entry; Len = %d, want 0", l)
	}
}

func TestCorrelator_TakeReturnsEmptyForUnregistered(t *testing.T) {
	c := New(time.Second, time.Now)
	if got := c.Take("never-set.md"); got != "" {
		t.Errorf("Take = %q, want empty", got)
	}
}

func TestCorrelator_TakeIsOneShot(t *testing.T) {
	// Two consecutive Takes for the same path: first returns the cid,
	// second returns empty. Models the "one notification per write"
	// expectation; if the watcher ever fires twice, only the first
	// notification gets the cid.
	c := New(time.Second, time.Now)
	c.Register("a.md", "abc")
	if got := c.Take("a.md"); got != "abc" {
		t.Fatalf("first Take = %q, want abc", got)
	}
	if got := c.Take("a.md"); got != "" {
		t.Errorf("second Take = %q, want empty", got)
	}
}

func TestCorrelator_LastWriterWins(t *testing.T) {
	// Two clients writing the same path within the TTL: the latest
	// cid attaches to the next notification. Acceptable because cid
	// is a perf-attribution signal, not semantic.
	c := New(time.Second, time.Now)
	c.Register("contested.md", "client-A")
	c.Register("contested.md", "client-B")
	if got := c.Take("contested.md"); got != "client-B" {
		t.Errorf("Take = %q, want client-B (last writer)", got)
	}
}

func TestCorrelator_ExpiredEntryReturnsEmpty(t *testing.T) {
	clock := newClock(time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC))
	c := New(500*time.Millisecond, clock.Now)

	c.Register("slow.md", "abc")
	clock.Advance(time.Second) // past TTL
	if got := c.Take("slow.md"); got != "" {
		t.Errorf("Take after TTL = %q, want empty (entry should be considered expired)", got)
	}
	// Entry should be cleared even though it expired (Take deletes
	// before the expiry check), so a second Take is also empty:
	if got := c.Take("slow.md"); got != "" {
		t.Errorf("second Take = %q, want empty", got)
	}
}

func TestCorrelator_RegisterResetsTTL(t *testing.T) {
	clock := newClock(time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC))
	c := New(500*time.Millisecond, clock.Now)

	c.Register("a.md", "abc")
	clock.Advance(400 * time.Millisecond)
	c.Register("a.md", "def") // resets TTL → expires at +900ms
	clock.Advance(300 * time.Millisecond)
	if got := c.Take("a.md"); got != "def" {
		t.Errorf("Take = %q, want def (TTL reset by re-Register)", got)
	}
}

func TestCorrelator_EmptyArgsAreNoOp(t *testing.T) {
	c := New(time.Second, time.Now)
	c.Register("", "cid-without-path")
	c.Register("path-without-cid.md", "")
	if l := c.Len(); l != 0 {
		t.Errorf("empty cid or empty path must not register; Len = %d", l)
	}
	if got := c.Take(""); got != "" {
		t.Errorf("Take on empty path = %q", got)
	}
}

func TestCorrelator_AmortisedSweep(t *testing.T) {
	clock := newClock(time.Date(2026, 4, 28, 0, 0, 0, 0, time.UTC))
	c := New(100*time.Millisecond, clock.Now)

	// Stuff a bunch of entries, then advance past their TTL, then
	// trigger a Register that crosses the sweep high-water-mark.
	for i := 0; i < 20; i++ {
		c.Register(stalePath(i), "cid")
	}
	if l := c.Len(); l != 20 {
		t.Fatalf("setup: Len = %d, want 20", l)
	}
	clock.Advance(time.Second)

	// One more Register with len > sweepHwm (16) triggers sweepLocked,
	// which deletes the 20 expired entries before inserting the new one.
	c.Register("fresh.md", "cid")
	if l := c.Len(); l != 1 {
		t.Errorf("after sweep + 1 fresh insert, Len = %d, want 1", l)
	}
}

func stalePath(i int) string {
	return "stale/" + string(rune('a'+(i%26))) + string(rune('0'+(i/26)))
}

func TestCorrelator_ConcurrentSafe(t *testing.T) {
	c := New(time.Second, time.Now)
	const goroutines = 16
	const opsPerG = 200
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < opsPerG; i++ {
				path := "shared.md"
				c.Register(path, "g")
				_ = c.Take(path)
			}
		}(g)
	}
	wg.Wait()
	// After all goroutines drain, no live entries should remain (every
	// Register is paired with a Take).
	if l := c.Len(); l != 0 {
		t.Errorf("post-race Len = %d, want 0", l)
	}
}

func TestCorrelator_DefaultTTLApplied(t *testing.T) {
	c := New(0, time.Now)
	c.Register("a.md", "cid")
	// No good way to assert the exact TTL without injecting a clock;
	// we just confirm the entry is live and the constructor didn't
	// panic on the zero ttl.
	if got := c.Take("a.md"); got != "cid" {
		t.Errorf("Take = %q, want cid (default TTL should keep entry live)", got)
	}
}
