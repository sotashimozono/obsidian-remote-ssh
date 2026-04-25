// Command obsidian-remote-server is the remote-side daemon spoken to by the
// obsidian-remote-ssh plugin. The plugin auto-deploys this binary over SSH,
// starts it, and forwards a local port to the unix socket it listens on.
//
// This file is a placeholder during the monorepo restructure (Phase 5-A).
// The real implementation — JSON-RPC over WebSocket, fsnotify watcher,
// HTTP attachment serving — lands in the subsequent phases.
package main

import (
	"flag"
	"fmt"
	"os"
)

// Version is replaced at link time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *versionFlag {
		fmt.Println(Version)
		return
	}

	fmt.Fprintf(os.Stderr, "obsidian-remote-server %s — not implemented yet (Phase 5-B onward)\n", Version)
	os.Exit(1)
}
