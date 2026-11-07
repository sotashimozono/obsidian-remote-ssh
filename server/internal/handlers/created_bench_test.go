package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// What the creation-time lookups (getxattr, plus statx on Linux) add to
// fs.walk, fs.list and a single createdMillis:
//
//	go test -run '^$' -bench Created -benchmem -count 10 ./internal/handlers/ | tee bench.txt
//	benchstat -col /lookups bench.txt
//
// lookups=off stubs both lookups out, so the difference from lookups=on
// is their cost; lookups=xattr and lookups=birth keep only one of them. xattr=all stamps every file, as after a save through
// the daemon; xattr=none is a vault the daemon hasn't written yet.
//
// OBSIDIAN_REMOTE_BENCH_DIR runs them in a directory on another
// filesystem, such as an NFS mount. The trees are kept there between
// runs, since writing 10k files over NFS is slow; the default is a temp
// dir, removed afterwards. Off local disks the xattr isn't used (see
// onLocalDisk), so xattr=all skips there; OBSIDIAN_REMOTE_BENCH_FORCE_XATTRS=1
// uses it anyway, to measure what it would cost.

const (
	benchDirEnv         = "OBSIDIAN_REMOTE_BENCH_DIR"
	benchForceXattrsEnv = "OBSIDIAN_REMOTE_BENCH_FORCE_XATTRS"
)

// forceXattrs makes the xattr usable on any filesystem, if asked to.
func forceXattrs(b *testing.B) {
	if os.Getenv(benchForceXattrsEnv) != "1" {
		return
	}
	orig := xattrsUsable
	b.Cleanup(func() { xattrsUsable = orig })
	xattrsUsable = func(string, os.FileInfo) bool { return true }
}

// benchTree returns a vault of n notes, 100 per folder, stamped or not.
func benchTree(b *testing.B, n int, stamped bool) string {
	b.Helper()
	forceXattrs(b)
	base := os.Getenv(benchDirEnv)
	if base == "" {
		base = b.TempDir()
	}
	root := filepath.Join(base, fmt.Sprintf("obsidian-remote-bench-%d-stamped=%t", n, stamped))
	done := filepath.Join(root, ".complete")
	if _, err := os.Stat(done); err == nil {
		return root
	}
	if err := os.RemoveAll(root); err != nil {
		b.Fatal(err)
	}
	for i := range n {
		abs := filepath.Join(root, fmt.Sprintf("d%03d", i/100), fmt.Sprintf("note-%05d.md", i))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			b.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("# note\n"), 0o644); err != nil {
			b.Fatal(err)
		}
		if stamped {
			if err := writeCreatedXattr(abs, seededCreated); err != nil {
				b.Skipf("xattr unavailable here (%v)", err)
			}
		}
	}
	if err := os.WriteFile(done, nil, 0o644); err != nil {
		b.Fatal(err)
	}
	return root
}

// lookupModes are the values of the lookups= sub-benchmark.
var lookupModes = []string{"off", "xattr", "birth", "on"}

// withLookups runs fn with the creation-time lookups in mode: all of them
// ("on"), none ("off"), or just the xattr read or the birth time.
func withLookups(b *testing.B, mode string, fn func(b *testing.B)) {
	b.Run("lookups="+mode, func(b *testing.B) {
		origGet, origBirth := getXattr, birthTime
		b.Cleanup(func() { getXattr, birthTime = origGet, origBirth })
		if mode == "off" || mode == "birth" {
			getXattr = func(string, string, []byte) (int, error) { return 0, errors.ErrUnsupported }
		}
		if mode == "off" || mode == "xattr" {
			birthTime = func(string, os.FileInfo) (int64, bool) { return 0, false }
		}
		fn(b)
	})
}

func reportPerFile(b *testing.B, files int) {
	b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N)/float64(files), "ns/file")
}

func BenchmarkCreated_FsWalk(b *testing.B) {
	for _, n := range []int{1_000, 10_000} {
		for _, stamped := range []bool{false, true} {
			b.Run(fmt.Sprintf("files=%d/xattr=%s", n, xattrLabel(stamped)), func(b *testing.B) {
				root := benchTree(b, n, stamped)
				walk := FsWalk(root)
				raw, _ := json.Marshal(proto.WalkParams{Path: "", Recursive: true})
				for _, mode := range lookupModes {
					withLookups(b, mode, func(b *testing.B) {
						for b.Loop() {
							res, rerr := walk(context.Background(), raw)
							if rerr != nil {
								b.Fatalf("fs.walk: %+v", rerr)
							}
							if got := len(res.(proto.WalkResult).Entries); got < n {
								b.Fatalf("fs.walk returned %d entries, want >= %d", got, n)
							}
						}
						reportPerFile(b, n)
					})
				}
			})
		}
	}
}

func BenchmarkCreated_FsList(b *testing.B) {
	for _, stamped := range []bool{false, true} {
		b.Run("xattr="+xattrLabel(stamped), func(b *testing.B) {
			// One folder of 100 notes: the first one of the tree.
			root := benchTree(b, 1_000, stamped)
			list := FsList(root)
			raw, _ := json.Marshal(proto.PathOnlyParams{Path: "d000"})
			for _, mode := range lookupModes {
				withLookups(b, mode, func(b *testing.B) {
					for b.Loop() {
						if _, rerr := list(context.Background(), raw); rerr != nil {
							b.Fatalf("fs.list: %+v", rerr)
						}
					}
					reportPerFile(b, 100)
				})
			}
		})
	}
}

func BenchmarkCreated_CreatedMillis(b *testing.B) {
	for _, stamped := range []bool{false, true} {
		b.Run("xattr="+xattrLabel(stamped), func(b *testing.B) {
			abs := filepath.Join(benchTree(b, 1_000, stamped), "d000", "note-00000.md")
			info, err := os.Stat(abs)
			if err != nil {
				b.Fatal(err)
			}
			for _, mode := range lookupModes {
				withLookups(b, mode, func(b *testing.B) {
					for b.Loop() {
						createdMillis(abs, info)
					}
				})
			}
		})
	}
}

func xattrLabel(stamped bool) string {
	if stamped {
		return "all"
	}
	return "none"
}
