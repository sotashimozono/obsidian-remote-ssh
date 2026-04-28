package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/handlers/thumbnails"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// Tests that exercise the cache-wired path of FsThumbnail. The
// cache-bypass branch (cache=nil) is covered by fs_thumbnail_test.go;
// these focus on the cache hit / miss / invalidation interactions
// the on-disk LRU adds to the handler.

func TestFsThumbnail_CachedHitSkipsResizeAndKeepsResultShape(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "photo.jpg", 800, 600)

	cache, err := thumbnails.New(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root, cache)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "photo.jpg", MaxDim: 256})

	first, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	second, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}

	r1 := first.(proto.ThumbnailResult)
	r2 := second.(proto.ThumbnailResult)

	if r1.ContentBase64 != r2.ContentBase64 {
		t.Errorf("cache hit returned different bytes than original encode")
	}
	// Width / Height / Format / mtime / sourceSize must be identical
	// — the cache hit shouldn't degrade the response shape.
	if r1.Width != r2.Width || r1.Height != r2.Height {
		t.Errorf("dims diverge between miss and hit: %dx%d vs %dx%d",
			r1.Width, r1.Height, r2.Width, r2.Height)
	}
	if r1.Format != r2.Format {
		t.Errorf("format diverges: %q vs %q", r1.Format, r2.Format)
	}
	if r1.Mtime != r2.Mtime || r1.SourceSize != r2.SourceSize {
		t.Errorf("mtime/sourceSize diverge: (%d, %d) vs (%d, %d)",
			r1.Mtime, r1.SourceSize, r2.Mtime, r2.SourceSize)
	}

	// Cache should hold exactly one entry now.
	if s := cache.Stats(); s.Entries != 1 {
		t.Errorf("expected 1 cache entry, got %d", s.Entries)
	}
}

func TestFsThumbnail_SourceMtimeChangeInvalidatesCache(t *testing.T) {
	root := t.TempDir()
	abs := makeJpegColor(t, root, "photo.jpg", 800, 600, 200, 50, 100) // magenta-ish
	cache, err := thumbnails.New(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root, cache)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "photo.jpg", MaxDim: 256})

	first, _ := h(context.Background(), raw)
	r1 := first.(proto.ThumbnailResult)

	// Re-save the source as a visually distinct image (different colour
	// so the resize result has different bytes), then bump mtime so the
	// cache key shifts and the handler must take the miss branch.
	makeJpegColor(t, root, "photo.jpg", 800, 600, 50, 200, 100) // green-ish
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(abs, future, future); err != nil {
		t.Fatal(err)
	}

	second, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatal(rerr)
	}
	r2 := second.(proto.ThumbnailResult)

	if r1.Mtime == r2.Mtime {
		t.Fatalf("test setup didn't actually change source mtime: %d", r1.Mtime)
	}
	if r1.ContentBase64 == r2.ContentBase64 {
		t.Errorf("cache should have been invalidated by mtime change but identical bytes returned")
	}
}

func TestFsThumbnail_DifferentMaxDimDoesNotCollide(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "photo.jpg", 800, 600)

	cache, err := thumbnails.New(t.TempDir(), 0)
	if err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root, cache)

	rawSmall, _ := json.Marshal(proto.ThumbnailParams{Path: "photo.jpg", MaxDim: 128})
	rawLarge, _ := json.Marshal(proto.ThumbnailParams{Path: "photo.jpg", MaxDim: 512})

	small, _ := h(context.Background(), rawSmall)
	large, _ := h(context.Background(), rawLarge)
	rs := small.(proto.ThumbnailResult)
	rl := large.(proto.ThumbnailResult)

	if rs.Width >= rl.Width {
		t.Errorf("small thumbnail (%dpx) should be smaller than large (%dpx)", rs.Width, rl.Width)
	}
	if rs.ContentBase64 == rl.ContentBase64 {
		t.Errorf("different MaxDim must produce different cache entries / different bytes")
	}
	if s := cache.Stats(); s.Entries != 2 {
		t.Errorf("expected 2 cache entries (one per MaxDim), got %d", s.Entries)
	}
}

func TestFsThumbnail_CorruptCachedFileFallsThroughToFreshEncode(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "photo.jpg", 400, 400)

	cacheDir := t.TempDir()
	cache, err := thumbnails.New(cacheDir, 0)
	if err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root, cache)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "photo.jpg", MaxDim: 200})

	// Prime the cache with a corrupt entry under the known key.
	info, _ := os.Stat(filepath.Join(root, "photo.jpg"))
	key := thumbnails.Key("photo.jpg", info.ModTime().UnixMilli(), 200)
	corruptPath := filepath.Join(cacheDir, key+".jpeg")
	if err := os.WriteFile(corruptPath, []byte("not actually a jpeg"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Still expect a usable thumbnail back — the handler should silently
	// re-encode rather than 500.
	got, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("expected fall-through to fresh encode, got RPC error %+v", rerr)
	}
	r := got.(proto.ThumbnailResult)
	if r.Width != 200 {
		t.Errorf("re-encode dims = %dx%d, want 200x200", r.Width, r.Height)
	}
	bytes, _ := base64.StdEncoding.DecodeString(r.ContentBase64)
	if len(bytes) < 100 {
		t.Errorf("fresh-encoded bytes suspiciously short: %d", len(bytes))
	}
}
