package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	// Side-effect imports register decoders for image.Decode.
	"image/jpeg"
	"image/png"
	_ "image/gif"
	"io/fs"
	"os"

	"golang.org/x/image/draw"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/handlers/thumbnails"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// thumbnailJpegQuality is the encoder quality for non-alpha sources.
// 80 hits the sweet spot of "indistinguishable from source at thumbnail
// sizes" without paying the bytes for higher.
const thumbnailJpegQuality = 80

// FsThumbnail returns the handler for `fs.thumbnail`.
//
// Decodes the source image, scales so the longer side is at most
// `MaxDim` pixels (preserving aspect ratio; sources already smaller
// than the cap are returned re-encoded but not upscaled), and emits
// JPEG q=80 by default. PNG sources keep their PNG encoding so a
// transparent background survives.
//
// Currently supported source formats: JPEG, PNG, GIF (first frame
// only — animated GIFs collapse to their first frame). HEIC / WebP
// need cgo or external libs and are deferred.
//
// `cache` is optional. When supplied, results are persisted to disk
// keyed by (path, source mtime, maxDim) — a source-file edit
// invalidates the cached entry automatically. Pass nil to bypass
// caching entirely (kept handy for tests).
func FsThumbnail(vaultRoot string, cache *thumbnails.DiskCache) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.ThumbnailParams
		if e := decodeParams("fs.thumbnail", params, &p); e != nil {
			return nil, e
		}
		if p.MaxDim <= 0 {
			return nil, rpc.ErrInvalidParams("fs.thumbnail: maxDim must be > 0")
		}

		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

		// Stat first — we need mtime + size for both the cache key and
		// the response, regardless of cache hit/miss.
		info, err := os.Stat(abs)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil, rpc.ErrFileNotFound(p.Path)
			}
			return nil, mapFsError(err, p.Path)
		}
		if info.IsDir() {
			return nil, rpc.ErrIsADirectory(p.Path)
		}

		srcMtime := mtimeMillis(info)
		srcSize := info.Size()

		// Cache lookup. Image dimensions aren't stored alongside the
		// payload — we recover them via image.DecodeConfig (header-only
		// parse, very fast) so the response shape stays identical to
		// the cache-miss path.
		if cache != nil {
			key := thumbnails.Key(p.Path, srcMtime, p.MaxDim)
			cached, format, cerr := cache.Get(key)
			if cerr == nil && cached != nil {
				cfg, _, derr := image.DecodeConfig(bytes.NewReader(cached))
				if derr == nil {
					return proto.ThumbnailResult{
						ContentBase64: base64.StdEncoding.EncodeToString(cached),
						Mtime:         srcMtime,
						SourceSize:    srcSize,
						Format:        string(format),
						Width:         cfg.Width,
						Height:        cfg.Height,
					}, nil
				}
				// Cached file looked corrupt — silently fall through
				// to the decode+resize path; the Put at the end will
				// overwrite with a fresh entry.
			}
		}

		f, err := os.Open(abs)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil, rpc.ErrFileNotFound(p.Path)
			}
			return nil, mapFsError(err, p.Path)
		}
		defer func() { _ = f.Close() }()

		src, srcFormat, err := image.Decode(f)
		if err != nil {
			return nil, rpc.ErrInvalidParams(
				"fs.thumbnail: cannot decode " + p.Path + " (" + err.Error() + ")",
			)
		}

		dst, dstW, dstH := resizeWithin(src, p.MaxDim)

		// Pick output format. Keep PNG when the source was PNG so
		// alpha doesn't get stomped to a JPEG-baked white background;
		// everything else encodes as JPEG q=80 for size.
		var out bytes.Buffer
		outFormat := thumbnails.FormatJPEG
		if srcFormat == "png" {
			outFormat = thumbnails.FormatPNG
			if err := png.Encode(&out, dst); err != nil {
				return nil, rpc.ErrInternal("fs.thumbnail: png encode: " + err.Error())
			}
		} else {
			if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: thumbnailJpegQuality}); err != nil {
				return nil, rpc.ErrInternal("fs.thumbnail: jpeg encode: " + err.Error())
			}
		}

		// Best-effort cache write. A failure to cache shouldn't fail
		// the request — the user still gets the freshly-encoded bytes.
		if cache != nil {
			key := thumbnails.Key(p.Path, srcMtime, p.MaxDim)
			_ = cache.Put(key, out.Bytes(), outFormat)
		}

		return proto.ThumbnailResult{
			ContentBase64: base64.StdEncoding.EncodeToString(out.Bytes()),
			Mtime:         srcMtime,
			SourceSize:    srcSize,
			Format:        string(outFormat),
			Width:         dstW,
			Height:        dstH,
		}, nil
	}
}

// resizeWithin returns an image scaled so its longer side is at most
// maxDim pixels (preserving aspect ratio). When the source is already
// within the cap the function still copies into a new image so the
// caller can encode without worrying about the source's underlying
// type (some decoders return YCbCr planes that the encoders prefer in
// a re-pixed RGBA).
func resizeWithin(src image.Image, maxDim int) (image.Image, int, int) {
	srcW := src.Bounds().Dx()
	srcH := src.Bounds().Dy()
	dstW, dstH := srcW, srcH
	if srcW > maxDim || srcH > maxDim {
		if srcW >= srcH {
			dstW = maxDim
			dstH = max1(srcH * maxDim / srcW)
		} else {
			dstH = maxDim
			dstW = max1(srcW * maxDim / srcH)
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	// CatmullRom is the best-quality scaler in x/image/draw and the
	// CPU difference vs BiLinear is negligible at thumbnail sizes.
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	return dst, dstW, dstH
}

// max1 keeps a computed dimension from collapsing to zero when the
// source is extreme aspect ratio (e.g. a 1×4000 strip).
func max1(n int) int {
	if n < 1 {
		return 1
	}
	return n
}
