// Package server wires the dispatcher, framing, and per-session state
// to a net.Listener. It is the only place in the tree that touches
// network I/O directly, so tests that want to exercise the whole stack
// can pass a pipe or a TCP loopback listener instead of a unix socket.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/auth"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// Options configure a Server.
type Options struct {
	// Token is the shared secret a client must present before any
	// non-auth method succeeds. Must not be empty.
	Token auth.Token

	// VaultRoot is the absolute path of the vault on disk. Method
	// handlers that touch the filesystem use this to resolve
	// vault-relative paths. server.info echoes it to the client.
	VaultRoot string

	// Version is the daemon's implementation version string used by
	// server.info. Defaults to "0.0.0-dev" when empty.
	Version string

	// Logger is used for connection-level events. Defaults to a no-op
	// logger when nil.
	Logger *slog.Logger
}

// Server accepts one connection at a time on an external listener and
// runs the dispatch loop against each. Multiple concurrent
// connections are allowed; each gets its own Session.
type Server struct {
	opts       Options
	dispatcher *rpc.Dispatcher
	log        *slog.Logger

	// Per-connection bookkeeping.
	connCount atomic.Int64
}

// New returns a Server with the given options and a pre-populated
// dispatcher. The caller may mutate the dispatcher via Dispatcher()
// before the first Serve() call.
func New(opts Options) *Server {
	if opts.Version == "" {
		opts.Version = "0.0.0-dev"
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Server{
		opts:       opts,
		dispatcher: rpc.NewDispatcher(),
		log:        opts.Logger,
	}
}

// Dispatcher exposes the inner dispatcher so command handlers can be
// registered before serving.
func (s *Server) Dispatcher() *rpc.Dispatcher { return s.dispatcher }

// Options returns a copy of the server's options (for handlers that
// need the vault root, version string, etc.)
func (s *Server) Options() Options { return s.opts }

// Serve accepts connections until l returns an error. Each accepted
// conn runs its own read/dispatch/write loop in a goroutine. Serve
// blocks until the listener closes; it does NOT close individual
// connections on return — the listener's Close is the signal.
func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	var wg sync.WaitGroup
	defer wg.Wait()

	for {
		conn, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("server: accept: %w", err)
		}
		wg.Add(1)
		go func(c net.Conn) {
			defer wg.Done()
			s.handleConn(ctx, c)
		}(conn)
	}
}

func (s *Server) handleConn(ctx context.Context, conn net.Conn) {
	connID := s.connCount.Add(1)
	log := s.log.With("conn", connID, "peer", conn.RemoteAddr().String())
	log.Info("connection opened")
	defer func() {
		_ = conn.Close()
		log.Info("connection closed")
	}()

	session := NewSession()
	reader := bufio.NewReader(conn)
	// Protect concurrent writes to the connection (currently only the
	// reply path writes, but fs.watch push events will write from
	// other goroutines in a later phase).
	var writeMu sync.Mutex

	for {
		body, err := rpc.ReadFrame(reader, 0)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			log.Warn("framing error", "err", err.Error())
			return
		}

		callCtx := WithSession(ctx, session)
		reply := s.dispatcher.Process(callCtx, body)
		if reply == nil {
			continue
		}

		writeMu.Lock()
		err = rpc.WriteFrame(conn, reply)
		writeMu.Unlock()
		if err != nil {
			log.Warn("write error", "err", err.Error())
			return
		}
	}
}

// --- context plumbing for handler access ---------------------------------

type sessionCtxKey struct{}

// WithSession returns a context that carries the given session so
// handlers can fetch it via SessionFromContext. Exported so handler
// tests can plant a Session of their own without routing through the
// full network stack.
func WithSession(parent context.Context, s *Session) context.Context {
	return context.WithValue(parent, sessionCtxKey{}, s)
}

// SessionFromContext recovers the per-connection Session from a
// handler's context. Handlers that receive a context without a
// session get a fresh unauthenticated one; this keeps unit tests of
// individual handlers simple (no need to thread a Session through
// every rpc.Process call).
func SessionFromContext(ctx context.Context) *Session {
	if s, ok := ctx.Value(sessionCtxKey{}).(*Session); ok && s != nil {
		return s
	}
	return NewSession()
}

// --- tiny helper so handlers don't have to import "encoding/json" just
//     to shape their return values. -----------------------------------

// RawJSON converts any JSON-marshalable value to json.RawMessage,
// panicking on failure (reserved for test fixtures / static data).
func RawJSON(v interface{}) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Errorf("server: marshal fixture: %w", err))
	}
	return b
}
