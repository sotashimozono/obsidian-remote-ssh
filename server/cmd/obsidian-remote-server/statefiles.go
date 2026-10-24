package main

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The socket and token paths are not private to one daemon: a redeploy
// starts a new daemon on the same paths while the old one may still be
// draining connections, and two profiles can be configured with the same
// paths. So the daemon must never delete a file at either path that
// another daemon owns (#614).
//
// Ownership is decided by an exclusive lock on "<path>.lock" for each of
// the two paths, held for the daemon's whole life. Whoever holds it owns
// the path: it can clear what a crashed run left there at startup, and
// remove its own file at shutdown, without having to tell whose file it
// is. Looking at the files themselves cannot decide that: filesystems
// such as ext4 hand a deleted file's inode number straight to the next
// file created, and a socket that does not answer a dial may still
// belong to a live daemon.

// errDaemonRunning is returned when another daemon on this host holds the
// lock for the socket or token path.
var errDaemonRunning = errors.New("another daemon on this host is using this path")

// errLocked is what tryLock returns when another process holds the lock.
var errLocked = errors.New("lock held by another process")

// lockWait bounds how long startup waits for a lock. A redeploy sends
// SIGTERM and starts the new daemon right after; the old one releases its
// locks as soon as it handles the signal. Kept well below the plugin's
// 5 s wait for the token. A var so tests can shorten it.
var lockWait = 2 * time.Second

const lockRetry = 50 * time.Millisecond

// stateFiles is this daemon's claim on its socket and token paths.
type stateFiles struct {
	socket, token string
	locks         []*os.File
	once          sync.Once
}

// claimStateFiles locks the socket and token paths, then clears a socket
// left behind by a crashed run. On errDaemonRunning nothing at either
// path was touched.
func claimStateFiles(socket, token string, log *slog.Logger) (*stateFiles, error) {
	s := &stateFiles{socket: socket, token: token}
	for _, p := range []string{socket, token} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			s.unlock()
			return nil, fmt.Errorf("mkdir %q: %w", filepath.Dir(p), err)
		}
		f, err := lockPath(p, log)
		if err != nil {
			s.unlock()
			return nil, err
		}
		if f != nil {
			s.locks = append(s.locks, f)
		}
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, fs.ErrNotExist) {
		s.unlock()
		return nil, fmt.Errorf("remove stale socket %q: %w", socket, err)
	}
	return s, nil
}

// lockPath takes the lock for path, waiting up to lockWait for a daemon
// that is shutting down. When the lock cannot protect the path, it logs a
// warning and returns a nil file, and the daemon runs as it did before the
// lock existed. That is the case when the filesystem has no working
// flock, or when the holder is a daemon on another host: on a home shared
// over NFS the lock reaches every host, but the unix socket does not.
func lockPath(path string, log *slog.Logger) (*os.File, error) {
	name := path + ".lock"
	f, err := os.OpenFile(name, os.O_RDWR|os.O_CREATE, 0o600) // #nosec G304 — daemon-controlled path, not user input
	if err != nil {
		return nil, fmt.Errorf("open lock %q: %w", name, err)
	}
	host, _ := os.Hostname()
	deadline := time.Now().Add(lockWait)
	for {
		err := tryLock(f)
		if err == nil {
			_ = f.Truncate(0)
			_, _ = f.WriteAt([]byte(host+"\n"), 0)
			return f, nil
		}
		if !errors.Is(err, errLocked) {
			_ = f.Close()
			log.Warn("cannot lock; another daemon on these paths could delete this one's files", "lock", name, "err", err.Error())
			return nil, nil
		}
		if holder := lockHolder(name); host != "" && holder != "" && holder != host {
			_ = f.Close()
			log.Warn("lock is held by a daemon on another host; running without it", "lock", name, "holder", holder)
			return nil, nil
		}
		if time.Now().After(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("%w: %s", errDaemonRunning, path)
		}
		time.Sleep(lockRetry)
	}
}

// lockHolder returns the host the holder of lock name wrote, or "" if it
// has not written one yet.
func lockHolder(name string) string {
	b, err := os.ReadFile(name) // #nosec G304 — daemon-controlled path, not user input
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// release removes the socket and token, then gives up the locks. Call it
// as soon as the daemon stops accepting, before it drains its
// connections, so a new daemon can take over at once. Safe to call more
// than once.
func (s *stateFiles) release() {
	s.once.Do(func() {
		_ = os.Remove(s.socket)
		_ = os.Remove(s.token)
		s.closeLocks()
	})
}

// unlock gives up the locks without removing anything, for a claim that
// failed part-way.
func (s *stateFiles) unlock() {
	s.once.Do(s.closeLocks)
}

func (s *stateFiles) closeLocks() {
	// Closing a file drops its lock. The lock files themselves stay:
	// deleting one would let two daemons lock two different files.
	for _, f := range s.locks {
		_ = f.Close()
	}
	s.locks = nil
}
