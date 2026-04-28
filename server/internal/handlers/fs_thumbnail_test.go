package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// makeJpeg writes a solid-colour JPEG of the given dimensions to
// `<root>/<rel>` and returns the absolute path so individual tests
// can stat / re-decode.
func makeJpeg(t *testing.T, root, rel string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 50, B: 100, A: 255})
		}
	}
	abs := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(abs)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := jpeg.Encode(f, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatal(err)
	}
	return abs
}

// makePng — same idea, PNG output with semi-transparent pixel so the
// "preserve alpha → return PNG" branch has something to bite into.
func makePng(t *testing.T, root, rel string, w, h int, withAlpha bool) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	a := uint8(255)
	if withAlpha {
		a = 128
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{R: 50, G: 200, B: 100, A: a})
		}
	}
	abs := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(abs)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return abs
}

// callThumbnail is the shared invocation harness — keeps individual
// tests focussed on assertions.
func callThumbnail(t *testing.T, vaultRoot, path string, maxDim int) proto.ThumbnailResult {
	t.Helper()
	h := FsThumbnail(vaultRoot)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: path, MaxDim: maxDim})
	result, rerr := h(context.Background(), raw)
	if rerr != nil {
		t.Fatalf("fs.thumbnail(%q, %d) returned RPC error: %+v", path, maxDim, rerr)
	}
	return result.(proto.ThumbnailResult)
}

// ─── fs.thumbnail ────────────────────────────────────────────────────────

func TestFsThumbnail_JpegResizesToFitMaxDim(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "photo.jpg", 800, 600)

	got := callThumbnail(t, root, "photo.jpg", 256)
	if got.Format != "jpeg" {
		t.Errorf("Format = %q, want jpeg", got.Format)
	}
	if got.Width != 256 || got.Height != 192 {
		// 800:600 = 4:3, capped at longer side 256 → height 192.
		t.Errorf("dims = %dx%d, want 256x192", got.Width, got.Height)
	}

	bytes, err := base64.StdEncoding.DecodeString(got.ContentBase64)
	if err != nil {
		t.Fatalf("base64 decode: %v", err)
	}
	if len(bytes) == 0 {
		t.Fatal("empty thumbnail bytes")
	}
	// Re-decode as a sanity check that the bytes are a valid JPEG of
	// the advertised dimensions.
	img, _, err := image.Decode(buf(bytes))
	if err != nil {
		t.Fatalf("re-decode: %v", err)
	}
	if img.Bounds().Dx() != 256 || img.Bounds().Dy() != 192 {
		t.Errorf("re-decoded dims = %dx%d, want 256x192", img.Bounds().Dx(), img.Bounds().Dy())
	}
}

func TestFsThumbnail_TallImageScalesByHeight(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "tall.jpg", 200, 1000)
	got := callThumbnail(t, root, "tall.jpg", 100)
	// 200:1000 = 1:5, longer side capped at 100 → width 20.
	if got.Width != 20 || got.Height != 100 {
		t.Errorf("dims = %dx%d, want 20x100", got.Width, got.Height)
	}
}

func TestFsThumbnail_SmallerThanCapNotUpscaled(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "small.jpg", 64, 48)
	got := callThumbnail(t, root, "small.jpg", 1024)
	if got.Width != 64 || got.Height != 48 {
		t.Errorf("dims = %dx%d, want 64x48 (no upscale)", got.Width, got.Height)
	}
}

func TestFsThumbnail_PngSourceReturnsPng(t *testing.T) {
	root := t.TempDir()
	makePng(t, root, "logo.png", 600, 600, true)
	got := callThumbnail(t, root, "logo.png", 200)
	if got.Format != "png" {
		t.Errorf("Format = %q, want png (alpha preservation)", got.Format)
	}
	bytes, _ := base64.StdEncoding.DecodeString(got.ContentBase64)
	if _, err := png.Decode(buf(bytes)); err != nil {
		t.Errorf("re-decode as PNG: %v", err)
	}
}

func TestFsThumbnail_SourceMtimeIsEchoed(t *testing.T) {
	root := t.TempDir()
	abs := makeJpeg(t, root, "stamped.jpg", 128, 128)
	info, _ := os.Stat(abs)
	want := info.ModTime().UnixMilli()

	got := callThumbnail(t, root, "stamped.jpg", 64)
	if got.Mtime != want {
		t.Errorf("Mtime = %d, want %d", got.Mtime, want)
	}
	if got.SourceSize != info.Size() {
		t.Errorf("SourceSize = %d, want %d", got.SourceSize, info.Size())
	}
}

func TestFsThumbnail_SizeShrinksForLargeJpeg(t *testing.T) {
	root := t.TempDir()
	abs := makeJpeg(t, root, "big.jpg", 2000, 2000)
	srcInfo, _ := os.Stat(abs)

	got := callThumbnail(t, root, "big.jpg", 256)
	thumbBytes, _ := base64.StdEncoding.DecodeString(got.ContentBase64)
	if int64(len(thumbBytes)) >= srcInfo.Size() {
		t.Errorf("thumbnail size %d should be smaller than source %d", len(thumbBytes), srcInfo.Size())
	}
}

func TestFsThumbnail_MissingReturnsFileNotFound(t *testing.T) {
	root := t.TempDir()
	h := FsThumbnail(root)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "nope.jpg", MaxDim: 128})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorFileNotFound {
		t.Fatalf("want FileNotFound, got %+v", rerr)
	}
}

func TestFsThumbnail_DirectoryReturnsIsADirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "img"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "img", MaxDim: 128})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorIsADirectory {
		t.Fatalf("want IsADirectory, got %+v", rerr)
	}
}

func TestFsThumbnail_NonImageReturnsInvalidParams(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "notes.md"), []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := FsThumbnail(root)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "notes.md", MaxDim: 128})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams, got %+v", rerr)
	}
}

func TestFsThumbnail_MaxDimMustBePositive(t *testing.T) {
	root := t.TempDir()
	makeJpeg(t, root, "x.jpg", 64, 64)
	h := FsThumbnail(root)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "x.jpg", MaxDim: 0})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for MaxDim=0, got %+v", rerr)
	}
}

func TestFsThumbnail_PathOutsideVault(t *testing.T) {
	root := t.TempDir()
	h := FsThumbnail(root)
	raw, _ := json.Marshal(proto.ThumbnailParams{Path: "../escape.jpg", MaxDim: 128})
	_, rerr := h(context.Background(), raw)
	if rerr == nil || rerr.Code != proto.ErrorPathOutsideVault {
		t.Fatalf("want PathOutsideVault, got %+v", rerr)
	}
}

// ─── helpers ────────────────────────────────────────────────────────────

// buf wraps a []byte in something image.Decode / png.Decode accept.
func buf(b []byte) *bytesReader { return &bytesReader{Reader: bytes.NewReader(b)} }

type bytesReader struct{ *bytes.Reader }
