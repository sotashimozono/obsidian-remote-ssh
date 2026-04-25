// Command obsidian-remote-server is the remote-side daemon spoken to
// by the obsidian-remote-ssh plugin. The plugin auto-deploys the
// binary over SSH and forwards a local TCP port to the unix socket
// this process listens on.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/auth"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/handlers"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

// Version is replaced at link time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

func main() {
	code, err := run(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	os.Exit(code)
}

// run is the unit-testable entry point: argv without the program name
// in, exit code + optional error out.
func run(args []string) (int, error) {
	fs := flag.NewFlagSet("obsidian-remote-server", flag.ContinueOnError)
	var (
		vaultRoot   = fs.String("vault-root", "", "absolute path of the vault on this host (required)")
		socketPath  = fs.String("socket", "", "unix socket to listen on (default ~/.obsidian-remote/server.sock)")
		tokenPath   = fs.String("token-file", "", "file to write the session token to (default ~/.obsidian-remote/token)")
		versionFlag = fs.Bool("version", false, "print version and exit")
		verbose     = fs.Bool("verbose", false, "log connection and dispatch events to stderr")
	)
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	if *versionFlag {
		fmt.Println(Version)
		return 0, nil
	}

	if *vaultRoot == "" {
		return 2, errors.New("--vault-root is required")
	}
	absRoot, err := filepath.Abs(*vaultRoot)
	if err != nil {
		return 2, fmt.Errorf("resolve --vault-root: %w", err)
	}
	if info, err := os.Stat(absRoot); err != nil || !info.IsDir() {
		return 2, fmt.Errorf("--vault-root %q is not a directory", absRoot)
	}

	defaultDir, err := defaultStateDir()
	if err != nil {
		return 1, err
	}
	if *socketPath == "" {
		*socketPath = filepath.Join(defaultDir, "server.sock")
	}
	if *tokenPath == "" {
		*tokenPath = filepath.Join(defaultDir, "token")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if *verbose {
		logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}

	token, err := auth.Generate()
	if err != nil {
		return 1, err
	}
	if err := auth.WriteFile(*tokenPath, token); err != nil {
		return 1, err
	}
	defer func() { _ = os.Remove(*tokenPath) }()

	// Clean up any dangling socket from a prior crashed run.
	_ = os.Remove(*socketPath)
	if err := os.MkdirAll(filepath.Dir(*socketPath), 0o700); err != nil {
		return 1, fmt.Errorf("mkdir socket dir: %w", err)
	}
	listener, err := net.Listen("unix", *socketPath)
	if err != nil {
		return 1, fmt.Errorf("listen %q: %w", *socketPath, err)
	}
	defer func() { _ = os.Remove(*socketPath) }()
	// Restrict socket to the current user.
	if err := os.Chmod(*socketPath, 0o600); err != nil {
		logger.Warn("chmod socket", "err", err.Error())
	}

	srv := server.New(server.Options{
		Token:     token,
		VaultRoot: absRoot,
		Version:   Version,
		Logger:    logger,
	})
	disp := srv.Dispatcher()
	disp.Handle("auth", handlers.Auth(token))
	disp.Handle("server.info", handlers.ServerInfo(disp, Version, absRoot))
	// fs.* handlers are gated behind session auth.
	// Read side.
	disp.Handle("fs.stat", handlers.RequireAuth(handlers.FsStat(absRoot)))
	disp.Handle("fs.exists", handlers.RequireAuth(handlers.FsExists(absRoot)))
	disp.Handle("fs.list", handlers.RequireAuth(handlers.FsList(absRoot)))
	disp.Handle("fs.readText", handlers.RequireAuth(handlers.FsReadText(absRoot)))
	disp.Handle("fs.readBinary", handlers.RequireAuth(handlers.FsReadBinary(absRoot)))
	// Write side.
	disp.Handle("fs.write", handlers.RequireAuth(handlers.FsWrite(absRoot)))
	disp.Handle("fs.writeBinary", handlers.RequireAuth(handlers.FsWriteBinary(absRoot)))
	disp.Handle("fs.append", handlers.RequireAuth(handlers.FsAppend(absRoot)))
	disp.Handle("fs.appendBinary", handlers.RequireAuth(handlers.FsAppendBinary(absRoot)))
	disp.Handle("fs.mkdir", handlers.RequireAuth(handlers.FsMkdir(absRoot)))
	disp.Handle("fs.remove", handlers.RequireAuth(handlers.FsRemove(absRoot)))
	disp.Handle("fs.rmdir", handlers.RequireAuth(handlers.FsRmdir(absRoot)))
	disp.Handle("fs.rename", handlers.RequireAuth(handlers.FsRename(absRoot)))
	disp.Handle("fs.copy", handlers.RequireAuth(handlers.FsCopy(absRoot)))
	disp.Handle("fs.trashLocal", handlers.RequireAuth(handlers.FsTrashLocal(absRoot)))

	// Wire signal-driven shutdown: closing the listener unwinds Serve.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		logger.Info("shutdown signal received")
		_ = listener.Close()
	}()

	fmt.Fprintf(os.Stderr, "obsidian-remote-server %s\n", Version)
	fmt.Fprintf(os.Stderr, "  vault:  %s\n", absRoot)
	fmt.Fprintf(os.Stderr, "  socket: %s\n", *socketPath)
	fmt.Fprintf(os.Stderr, "  token:  %s\n", *tokenPath)

	if err := srv.Serve(ctx, listener); err != nil && !errors.Is(err, net.ErrClosed) {
		return 1, err
	}
	return 0, nil
}

func defaultStateDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	return filepath.Join(home, ".obsidian-remote"), nil
}
