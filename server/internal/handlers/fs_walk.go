package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// DefaultWalkMaxEntries caps fs.walk responses when the caller does
// not supply MaxEntries. Sized to comfortably fit Obsidian vaults in
// the 10k-50k file range while keeping a hard ceiling on response
// payload (~10 MB at ~150 B/entry) so a misuse never OOMs the client.
const DefaultWalkMaxEntries = 50_000

// errWalkLimitReached is the sentinel filepath.WalkDir returns to
// short-circuit the walk once the entry budget is exhausted. It never
// surfaces to the client; we map it to Truncated: true.
var errWalkLimitReached = errors.New("fs.walk: max entries reached")

// FsWalk returns the handler for `fs.walk`.
//
// One round-trip equivalent of recursively calling fs.list — for the
// shadow-vault cold-open path (`populateVaultFromRemote`) this turns
// O(folders) RPCs into one. Each emitted entry is vault-relative and
// already carries its mtime + size, so the caller doesn't need a
// separate fs.stat round-trip per file.
//
// Non-recursive mode (`Recursive: false`) returns just the immediate
// children, equivalent to fs.list but flatter.
//
// Symlinks are reported but not followed — matches the fs.list policy
// and avoids cycles. Permission errors on a subtree are skipped (so a
// stray protected dir doesn't kill the whole walk) but other errors
// abort and surface to the caller.
func FsWalk(vaultRoot string) rpc.Handler {
	return func(_ context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.WalkParams
		if e := decodeParams("fs.walk", params, &p); e != nil {
			return nil, e
		}
		max := p.MaxEntries
		if max <= 0 {
			max = DefaultWalkMaxEntries
		}

		abs, e := resolveOrErr(vaultRoot, p.Path)
		if e != nil {
			return nil, e
		}

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

		entries := make([]proto.WalkEntry, 0, 256)
		truncated := false

		walkFn := func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				// Permission denied on a subtree is a routine real-world
				// case (e.g. a `.git/objects/pack` with weird perms);
				// skip it instead of aborting the whole walk. Unknown
				// errors propagate so the caller sees a real failure.
				if errors.Is(walkErr, fs.ErrPermission) {
					if d != nil && d.IsDir() {
						return fs.SkipDir
					}
					return nil
				}
				return walkErr
			}
			// The starting path is the vault-relative root; emitting it
			// would surprise callers (fs.list also doesn't list "."
			// itself). Skip but keep descending.
			if path == abs {
				return nil
			}
			if len(entries) >= max {
				truncated = true
				return errWalkLimitReached
			}
			einfo, err := d.Info()
			if err != nil {
				// Concurrent delete between readdir and stat — skip and
				// keep going, matching fs.list's tolerance.
				return nil
			}

			rel, err := filepath.Rel(vaultRoot, path)
			if err != nil {
				// Should be impossible given resolveOrErr success above,
				// but if it ever happens skip the entry rather than
				// kill the walk.
				return nil
			}
			// Normalise to forward slashes so the wire format stays
			// stable across daemon OSes (Windows daemons, if ever, would
			// otherwise emit backslashes).
			rel = filepath.ToSlash(rel)

			entries = append(entries, proto.WalkEntry{
				Path:  rel,
				Type:  entryTypeFrom(d.Type()),
				Mtime: mtimeMillis(einfo),
				Size:  einfo.Size(),
			})

			// Non-recursive: record the directory entry but don't
			// descend further into it.
			if !p.Recursive && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}

		if err := filepath.WalkDir(abs, walkFn); err != nil && !errors.Is(err, errWalkLimitReached) {
			return nil, mapFsError(err, p.Path)
		}

		return proto.WalkResult{Entries: entries, Truncated: truncated}, nil
	}
}
