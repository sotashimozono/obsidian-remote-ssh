package thumbnails

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestCache(t *testing.T, maxBytes int64) (*DiskCache, string) {
	t.Helper()
	dir := t.TempDir()
	c, err := New(dir, maxBytes)
	if err != nil {
		t.Fatal(err)
	}
	return c, dir
}

func TestKey_StableAcrossCalls(t *testing.T) {
	a := Key("photo.jpg", 123, 256)
	b := Key("photo.jpg", 123, 256)
	if a != b {
		t.Errorf("same inputs → different keys: %q vs %q", a, b)
	}
}

func TestKey_DiffersOnAnyInput(t *testing.T) {
	base := Key("photo.jpg", 123, 256)
	cases := []struct {
		name, key string
	}{
		{"different path", Key("other.jpg", 123, 256)},
		{"different mtime", Key("photo.jpg", 124, 256)},
		{"different maxDim", Key("photo.jpg", 123, 257)},
	}
	for _, c := range cases {
		if c.key == base {
			t.Errorf("%s: key should differ from base, got identical %q", c.name, c.key)
		}
	}
}

func TestDiskCache_GetMiss(t *testing.T) {
	c, _ := newTestCache(t, 0)
	data, format, err := c.Get(Key("nope.jpg", 0, 256))
	if err != nil {
		t.Fatal(err)
	}
	if data != nil || format != "" {
		t.Errorf("miss should return (nil, ''), got (%d bytes, %q)", len(data), format)
	}
}

func TestDiskCache_PutThenGetRoundTrips(t *testing.T) {
	c, _ := newTestCache(t, 0)
	key := Key("a.jpg", 1, 128)
	payload := bytes.Repeat([]byte{0xAB}, 1024)
	if err := c.Put(key, payload, FormatJPEG); err != nil {
		t.Fatal(err)
	}
	got, format, err := c.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("payload round-trip mismatch (%d vs %d bytes)", len(got), len(payload))
	}
	if format != FormatJPEG {
		t.Errorf("format = %q, want jpeg", format)
	}
}

func TestDiskCache_PutPngStoredWithPngExtension(t *testing.T) {
	c, dir := newTestCache(t, 0)
	key := Key("logo.png", 1, 128)
	if err := c.Put(key, []byte("png-bytes"), FormatPNG); err != nil {
		t.Fatal(err)
	}
	pngPath := filepath.Join(dir, key+".png")
	if _, err := os.Stat(pngPath); err != nil {
		t.Errorf("expected %s on disk: %v", pngPath, err)
	}
	got, format, err := c.Get(key)
	if err != nil {
		t.Fatal(err)
	}
	if format != FormatPNG {
		t.Errorf("format = %q, want png", format)
	}
	if string(got) != "png-bytes" {
		t.Errorf("payload = %q, want png-bytes", string(got))
	}
}

func TestDiskCache_StatsAccountsForPutAndEvict(t *testing.T) {
	// Cap at 4 KB; each entry is 1 KB → 4 fit, 5th triggers evict.
	c, _ := newTestCache(t, 4*1024)
	for i := 0; i < 4; i++ {
		key := Key("file", int64(i), 128)
		if err := c.Put(key, bytes.Repeat([]byte{byte(i)}, 1024), FormatJPEG); err != nil {
			t.Fatal(err)
		}
	}
	if s := c.Stats(); s.Entries != 4 || s.Bytes != 4*1024 {
		t.Errorf("after 4 puts: stats = %+v, want 4 entries / 4096 bytes", s)
	}
	// Add 1 more — should trigger eviction down to ~90% of cap (~3686 bytes),
	// which means dropping at least one entry.
	keyOverflow := Key("file", 4, 128)
	if err := c.Put(keyOverflow, bytes.Repeat([]byte{0xFF}, 1024), FormatJPEG); err != nil {
		t.Fatal(err)
	}
	s := c.Stats()
	if s.Bytes > c.maxBytes {
		t.Errorf("after overflow put, bytes %d > maxBytes %d", s.Bytes, c.maxBytes)
	}
	// The newest entry must still be present (we just wrote it).
	got, _, _ := c.Get(keyOverflow)
	if got == nil {
		t.Errorf("just-written entry was evicted on the same Put — wrong order")
	}
}

func TestDiskCache_EvictionDropsOldestFirst(t *testing.T) {
	c, _ := newTestCache(t, 3*1024)
	keys := make([]string, 0, 4)
	for i := 0; i < 3; i++ {
		k := Key("file", int64(i), 128)
		keys = append(keys, k)
		if err := c.Put(k, bytes.Repeat([]byte{byte(i)}, 1024), FormatJPEG); err != nil {
			t.Fatal(err)
		}
		// Stagger mtimes so eviction order is deterministic. Without
		// this the three Puts can land in the same millisecond on
		// fast filesystems.
		time.Sleep(20 * time.Millisecond)
	}
	// Touch the FIRST entry so it's now the most-recently-used; the
	// SECOND entry (index 1) should be the one evicted next.
	if got, _, _ := c.Get(keys[0]); got == nil {
		t.Fatal("first entry vanished before access touch")
	}
	time.Sleep(20 * time.Millisecond)

	// Add a 4th entry to push us over the cap.
	overflow := Key("file", 99, 128)
	if err := c.Put(overflow, bytes.Repeat([]byte{0xEE}, 1024), FormatJPEG); err != nil {
		t.Fatal(err)
	}

	if got, _, _ := c.Get(keys[1]); got != nil {
		t.Errorf("entry 1 should have been evicted as least-recently-used, but it's still present")
	}
	if got, _, _ := c.Get(keys[0]); got == nil {
		t.Errorf("entry 0 was touched and should remain, but it's gone")
	}
	if got, _, _ := c.Get(overflow); got == nil {
		t.Errorf("overflow entry just written should remain, but it's gone")
	}
}

func TestDiskCache_RecomputesSizeAcrossInstances(t *testing.T) {
	dir := t.TempDir()
	c1, err := New(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		k := Key("file", int64(i), 128)
		if err := c1.Put(k, bytes.Repeat([]byte{byte(i)}, 1024), FormatJPEG); err != nil {
			t.Fatal(err)
		}
	}
	// Open a second cache pointed at the same dir — emulates daemon
	// restart. Stats should reflect the existing files.
	c2, err := New(dir, 0)
	if err != nil {
		t.Fatal(err)
	}
	s := c2.Stats()
	if s.Entries != 3 || s.Bytes != 3*1024 {
		t.Errorf("re-opened cache stats = %+v, want 3 entries / 3072 bytes", s)
	}
}

func TestDiskCache_PutOverwritesSiblingFormat(t *testing.T) {
	// If the source flips between PNG-with-alpha and JPEG (e.g. the
	// user re-saved), we should drop the stale-format file rather
	// than leave both on disk.
	c, dir := newTestCache(t, 0)
	key := Key("img", 1, 128)
	if err := c.Put(key, []byte("first as png"), FormatPNG); err != nil {
		t.Fatal(err)
	}
	if err := c.Put(key, []byte("now as jpeg"), FormatJPEG); err != nil {
		t.Fatal(err)
	}

	pngPath := filepath.Join(dir, key+".png")
	if _, err := os.Stat(pngPath); err == nil {
		t.Errorf("stale PNG sibling should have been removed: %s still present", pngPath)
	}
	got, format, _ := c.Get(key)
	if format != FormatJPEG || string(got) != "now as jpeg" {
		t.Errorf("after format flip: got format=%q payload=%q, want jpeg / 'now as jpeg'", format, string(got))
	}
}

func TestDiskCache_PutEmptyKeyRejected(t *testing.T) {
	c, _ := newTestCache(t, 0)
	err := c.Put("", []byte("x"), FormatJPEG)
	if err == nil || !strings.Contains(err.Error(), "empty key") {
		t.Errorf("expected empty-key rejection, got %v", err)
	}
}

func TestNew_DefaultMaxBytesWhenZero(t *testing.T) {
	c, err := New(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if c.maxBytes != DefaultMaxBytes {
		t.Errorf("maxBytes = %d, want default %d", c.maxBytes, DefaultMaxBytes)
	}
}
