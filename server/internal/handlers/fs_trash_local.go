package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path"
	"path/filepath"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/vaultfs"
)

// FsTrashLocal returns the handler for `fs.trashLocal`. The target
// is moved under `<vaultRoot>/.trash/<path>`; intermediate directories
// are created as needed. Matches Obsidian's local-trash fallback.
//
// Trashing the vault root is refused because it would collapse the
// whole tree into `.trash/.trash/…`.
func FsTrashLocal(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.PathOnlyParams
		if e := decodeParams("fs.trashLocal", params, &p); e != nil {
			return nil, e
		}
		if p.Path == "" || p.Path == "/" {
			return nil, rpc.ErrInvalidParams("fs.trashLocal: refusing to trash the vault root")
		}
		srcAbs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

		// Destination is <vaultRoot>/.trash/<original path>.
		// path.Join (posix) keeps slashes in the wire-style path
		// before we hand it back to vaultfs.Resolve for safety
		// checking + OS-separator conversion.
		trashRel := path.Join(".trash", p.Path)
		dstAbs, err := vaultfs.Resolve(vaultRoot, trashRel)
		if err != nil {
			return nil, rpc.ErrPathOutsideVault(trashRel)
		}

		if err := os.MkdirAll(filepath.Dir(dstAbs), 0o755); err != nil { // #nosec G301 — vault .trash dir; path validated by vaultfs.Resolve
			return nil, mapFsError(err, trashRel)
		}
		if err := os.Rename(srcAbs, dstAbs); err != nil {
			return nil, mapFsError(err, p.Path)
		}
		return struct{}{}, nil
	}
}
