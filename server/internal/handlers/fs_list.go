package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// FsList returns the handler for `fs.list`.
//
// Implementation notes:
//   - Non-directory targets resolve to NotADirectory so callers can
//     distinguish "this is a file, use fs.stat" from "does not exist".
//   - Symlinks in the listing are reported as EntryTypeSymlink; we
//     don't follow them, matching the Node adapter's behaviour.
//   - Per-entry Info() failures are logged into the InternalError
//     channel but skipped from the listing so one flaky entry does
//     not kill the whole call.
func FsList(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.list", params, &p); e != nil {
			return nil, e
		}
		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

		// Disambiguate "target is a file" from "target does not
		// exist" up front — os.ReadDir collapses both into a
		// PathError that the client can't tell apart otherwise.
		info, err := os.Stat(abs)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil, rpc.ErrFileNotFound(p.Path)
			}
			return nil, mapFsError(err, p.Path)
		}
		if !info.IsDir() {
			return nil, rpc.ErrNotADirectory(p.Path)
		}

		entries, err := os.ReadDir(abs)
		if err != nil {
			return nil, mapFsError(err, p.Path)
		}

		out := make([]proto.Entry, 0, len(entries))
		for _, e := range entries {
			einfo, err := e.Info()
			if err != nil {
				// Skip entries we can't stat (concurrent delete, etc.)
				continue
			}
			out = append(out, proto.Entry{
				Name:  e.Name(),
				Type:  entryTypeFrom(e.Type()),
				Mtime: mtimeMillis(einfo),
				Size:  einfo.Size(),
			})
		}
		return proto.ListResult{Entries: out}, nil
	}
}
