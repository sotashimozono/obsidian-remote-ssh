// Package thumbnails implements the on-disk LRU cache the
// `fs.thumbnail` handler uses to avoid re-decoding the same image
// on every request.
//
// Layout: a flat directory of files named `<key>.{jpeg,png}` where
// `<key>` is `sha256(path|mtime|maxDim)`. Mixing key derivation with
// the source file's mtime means an edit on the source automatically
// invalidates its cached thumbnails — no explicit purge needed.
//
// LRU ordering uses each cache file's own mtime as a "last accessed"
// signal. Get touches the file to "now"; Put writes it. When total
// size exceeds the configured cap, the cache evicts oldest-first
// down to ~90 % of the cap so a steady-state workload doesn't loop
// through evict-on-every-Put.
package thumbnails

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// DefaultMaxBytes is the cache size cap when none is supplied.
// At ~100 KB per typical 1024 px JPEG that's room for ~2000 thumbs,
// which comfortably covers a photo-heavy vault while staying small
// enough not to surprise the daemon's host disk usage.
const DefaultMaxBytes int64 = 200 * 1024 * 1024

// evictionTarget is the fraction of MaxBytes the cache shrinks to
// after an eviction pass. Keeping headroom (10 %) means an immediate
// follow-up Put usually doesn't re-trigger eviction.
const evictionTarget = 0.9

// Format is one of "jpeg" or "png" — the encoding the cache holds
// the image in. Used to choose the file extension and (on read) the
// returned format.
type Format string

const (
	FormatJPEG Format = "jpeg"
	FormatPNG  Format = "png"
)

// extFor returns the on-disk file extension for a cache entry.
func extFor(f Format) string {
	if f == FormatPNG {
		return ".png"
	}
	return ".jpeg"
}

// Key builds the cache filename stem (no extension) for a source
// file + dimension cap. Stable across processes; mtime in the key
// means a source edit is automatically invalidated.
func Key(path string, mtime int64, maxDim int) string {
	h := sha256.New()
	h.Write([]byte(path))
	_ = binary.Write(h, binary.BigEndian, mtime)
	_ = binary.Write(h, binary.BigEndian, int32(maxDim))
	return hex.EncodeToString(h.Sum(nil))
}

// DiskCache is the on-disk LRU thumbnail cache.
type DiskCache struct {
	dir      string
	maxBytes int64

	mu        sync.Mutex
	sizeBytes int64 // tracked incrementally; refreshed at New time
}

// Stats is a point-in-time snapshot of the cache.
type Stats struct {
	Entries  int
	Bytes    int64
	MaxBytes int64
}

// New opens or initialises a cache rooted at dir. The directory is
// created if missing; existing files (e.g. from a previous run) are
// scanned to seed the size accounting and stay reusable.
//
// `maxBytes <= 0` selects DefaultMaxBytes.
func New(dir string, maxBytes int64) (*DiskCache, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("thumbnails: mkdir %q: %w", dir, err)
	}
	c := &DiskCache{dir: dir, maxBytes: maxBytes}
	if err := c.recomputeSize(); err != nil {
		return nil, err
	}
	return c, nil
}

// Get returns the cached payload + format if present. (nil, "", nil)
// on miss; an error only on I/O trouble that's not "missing file".
//
// Side effect on hit: the cached file's mtime is bumped to now so
// subsequent eviction passes treat it as recently-used.
func (c *DiskCache) Get(key string) ([]byte, Format, error) {
	for _, f := range []Format{FormatJPEG, FormatPNG} {
		path := filepath.Join(c.dir, key+extFor(f))
		data, err := os.ReadFile(path)
		if err == nil {
			// Touch mtime so this entry slides to the back of the LRU
			// queue. Failure here is non-fatal — a stale mtime just
			// means the entry might be evicted slightly sooner; the
			// payload is still good.
			now := time.Now()
			_ = os.Chtimes(path, now, now)
			return data, f, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, "", fmt.Errorf("thumbnails: read %q: %w", path, err)
		}
	}
	return nil, "", nil
}

// Put writes a new cache entry. After the write, if the total cache
// size has crossed maxBytes, an eviction pass runs to bring it back
// under evictionTarget × maxBytes (oldest mtime first).
//
// An empty key is rejected. Concurrent Puts serialize on the
// internal mutex; concurrent Gets are not blocked.
func (c *DiskCache) Put(key string, data []byte, format Format) error {
	if key == "" {
		return errors.New("thumbnails: empty key")
	}
	dst := filepath.Join(c.dir, key+extFor(format))

	// Atomic write so a half-finished file never poisons the cache.
	tmp, err := os.CreateTemp(c.dir, "thumb-*.tmp")
	if err != nil {
		return fmt.Errorf("thumbnails: create temp: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("thumbnails: write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("thumbnails: close temp: %w", err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// If a sibling with the OTHER format already exists for the same
	// key (e.g. cache invalidation crossed a JPEG ↔ PNG boundary),
	// drop it before renaming so accounting stays correct.
	otherFormat := FormatPNG
	if format == FormatPNG {
		otherFormat = FormatJPEG
	}
	otherPath := filepath.Join(c.dir, key+extFor(otherFormat))
	if info, err := os.Stat(otherPath); err == nil {
		_ = os.Remove(otherPath)
		c.sizeBytes -= info.Size()
	}

	// If the destination already exists (idempotent re-Put with the
	// same key+format), subtract its old size before overwriting.
	if info, err := os.Stat(dst); err == nil {
		c.sizeBytes -= info.Size()
	}

	if err := os.Rename(tmpPath, dst); err != nil {
		cleanup()
		return fmt.Errorf("thumbnails: rename: %w", err)
	}
	c.sizeBytes += int64(len(data))

	if c.sizeBytes > c.maxBytes {
		if err := c.evictLocked(); err != nil {
			// Eviction failure is non-fatal — log via returned error
			// for observability but the entry was successfully written.
			return fmt.Errorf("thumbnails: eviction after Put: %w", err)
		}
	}
	return nil
}

// Stats returns a point-in-time snapshot. Useful for diagnostics
// (advertised via a future server.info field if needed).
func (c *DiskCache) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, _ := c.countEntriesLocked()
	return Stats{Entries: entries, Bytes: c.sizeBytes, MaxBytes: c.maxBytes}
}

// ─── internals ─────────────────────────────────────────────────────────

// recomputeSize walks the cache dir and seeds c.sizeBytes. Called
// from New; cheap because thumbnail dirs are small (hundreds to a
// few thousand files) and we only stat, don't read.
func (c *DiskCache) recomputeSize() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return fmt.Errorf("thumbnails: scan %q: %w", c.dir, err)
	}
	var total int64
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		total += info.Size()
	}
	c.sizeBytes = total
	return nil
}

func (c *DiskCache) countEntriesLocked() (int, error) {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			n++
		}
	}
	return n, nil
}

// evictLocked drops oldest-first until the cache is at or below
// evictionTarget × maxBytes. Caller MUST hold c.mu.
func (c *DiskCache) evictLocked() error {
	target := int64(float64(c.maxBytes) * evictionTarget)

	type fileInfoWithName struct {
		name  string
		size  int64
		mtime time.Time
	}
	dirEntries, err := os.ReadDir(c.dir)
	if err != nil {
		return err
	}
	all := make([]fileInfoWithName, 0, len(dirEntries))
	for _, e := range dirEntries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		all = append(all, fileInfoWithName{
			name:  e.Name(),
			size:  info.Size(),
			mtime: info.ModTime(),
		})
	}
	// Oldest first.
	sort.Slice(all, func(i, j int) bool { return all[i].mtime.Before(all[j].mtime) })

	for _, e := range all {
		if c.sizeBytes <= target {
			break
		}
		path := filepath.Join(c.dir, e.name)
		if err := os.Remove(path); err != nil {
			// Concurrent delete or weird permission — keep going so
			// one bad entry doesn't stall eviction forever.
			continue
		}
		c.sizeBytes -= e.size
	}
	return nil
}
