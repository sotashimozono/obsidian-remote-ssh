package handlers

import (
	"context"
	"encoding/json"
	"os"
	"unicode/utf8"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsReadText returns the handler for `fs.readText`.
//
// The handler reads the whole file into memory and returns it as a
// JSON string. Invalid UTF-8 is rejected as InvalidParams so
// attachment-like payloads don't silently turn into replacement
// characters; clients wanting raw bytes should use fs.readBinary.
//
// On a directory target the handler returns IsADirectory — otherwise
// os.ReadFile would surface a platform-specific error that the
// client can't interpret.
func FsReadText(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.ReadTextParams
		if e := decodeParams("fs.readText", params, &p); e != nil {
			return nil, e
		}
		if p.Encoding != "" && p.Encoding != "utf8" {
			return nil, rpc.ErrInvalidParams("fs.readText: only utf8 encoding is supported")
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

		data, err := os.ReadFile(abs) // #nosec G304 — abs validated by resolveOrErr → vaultfs.Resolve
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}
		if !utf8.Valid(data) {
			return nil, rpc.ErrInvalidParams("fs.readText: file is not valid UTF-8; use fs.readBinary")
		}

		return proto.ReadTextResult{
			Content:  string(data),
			Mtime:    mtimeMillis(info),
			Size:     int64(len(data)),
			Encoding: "utf8",
		}, nil
	}
}
