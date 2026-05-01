package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsReadBinary returns the handler for `fs.readBinary`.
//
// Payload is standard base64 (not URL-safe) — matching what
// encoding/base64 in Node also produces by default. Callers should
// use fs.readText for UTF-8 plain text to avoid the +33% wire overhead.
func FsReadBinary(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.readBinary", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

		info, err := os.Stat(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		if info.IsDir() {
			return nil, rpc.ErrIsADirectory(p.Path)
		}

		data, err := os.ReadFile(abs) // #nosec G304 — abs validated by resolveOrErr → vaultfs.Resolve
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		return proto.ReadBinaryResult{
			ContentBase64: base64.StdEncoding.EncodeToString(data),
			Mtime:         mtimeMillis(info),
			Size:          int64(len(data)),
		}, nil
	}
}

// FsReadBinaryRange returns the handler for `fs.readBinaryRange` —
// the partial-read sibling of fs.readBinary. Backed by os.File.ReadAt
// (pread on POSIX, ReadFile + offset on Windows) so the daemon never
// loads the full file just to return a slice.
//
// Reads past EOF clamp silently: if Offset+Length > on-disk size,
// the response carries however many bytes were actually available
// (which may be zero when Offset >= size). The caller can detect a
// clamp by comparing len(decoded ContentBase64) against the requested
// Length, and Size in the result always reports the total file size.
//
// ExpectedMtime, when non-zero, fails the request with
// PreconditionFailed when the file's current mtime differs — used by
// range-aware callers (e.g. the plugin's ResourceBridge) to detect a
// mid-read edit and restart from offset 0 with a fresh cache.
func FsReadBinaryRange(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.ReadBinaryRangeParams
		if e := decodeParams("fs.readBinaryRange", params, &p); e != nil {
			return nil, e
		}
		if p.Offset < 0 {
			return nil, rpc.ErrInvalidParams(
				fmt.Sprintf("fs.readBinaryRange: offset must be >= 0, got %d", p.Offset),
			)
		}
		if p.Length < 0 {
			return nil, rpc.ErrInvalidParams(
				fmt.Sprintf("fs.readBinaryRange: length must be >= 0, got %d", p.Length),
			)
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

		info, err := os.Stat(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		if info.IsDir() {
			return nil, rpc.ErrIsADirectory(p.Path)
		}
		currentMtime := mtimeMillis(info)
		if p.ExpectedMtime != 0 && p.ExpectedMtime != currentMtime {
			return nil, rpc.ErrPreconditionFailed(
				fmt.Sprintf("%s: expected mtime %d, found %d", p.Path, p.ExpectedMtime, currentMtime),
			)
		}

		size := info.Size()
		// Clamp the read window so we don't allocate beyond the file's
		// on-disk size. A request entirely past EOF returns zero bytes
		// + the real total Size — well-formed enough for HTTP 206
		// responses to surface "the range you asked for is empty".
		readLen := p.Length
		if p.Offset >= size {
			readLen = 0
		} else if p.Offset+p.Length > size {
			readLen = size - p.Offset
		}

		buf := make([]byte, readLen)
		if readLen > 0 {
			f, err := os.Open(abs) // #nosec G304 — abs validated by resolveOrErr → vaultfs.Resolve
			if err != nil {
				return nil, mapFsError(err, p.Path)
			}
			n, rerr := f.ReadAt(buf, p.Offset)
			// io.EOF is expected when the read ends exactly at EOF;
			// it doesn't indicate an error, just that no further bytes
			// were available beyond what we already got.
			if rerr != nil && !errors.Is(rerr, io.EOF) {
				_ = f.Close()
				return nil, mapFsError(rerr, p.Path)
			}
			if cerr := f.Close(); cerr != nil {
				return nil, mapFsError(cerr, p.Path)
			}
			buf = buf[:n]
		}

		return proto.ReadBinaryRangeResult{
			ContentBase64: base64.StdEncoding.EncodeToString(buf),
			Mtime:         currentMtime,
			Size:          size,
		}, nil
	}
}
