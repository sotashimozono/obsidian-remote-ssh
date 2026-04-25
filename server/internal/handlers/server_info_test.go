package handlers

import (
	"context"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

type fakeInfoSource struct{ methods []string }

func (f fakeInfoSource) Methods() []string { return f.methods }

func TestServerInfo_EchosVersionAndRoot(t *testing.T) {
	src := fakeInfoSource{methods: []string{"fs.stat", "auth", "fs.list"}}
	h := ServerInfo(src, "0.1.2", "/home/me/vault")

	raw, rpcErr := h(context.Background(), nil)
	if rpcErr != nil {
		t.Fatalf("unexpected error: %+v", rpcErr)
	}
	info, ok := raw.(proto.ServerInfo)
	if !ok {
		t.Fatalf("result type = %T, want proto.ServerInfo", raw)
	}

	if info.Version != "0.1.2" {
		t.Errorf("Version = %q, want 0.1.2", info.Version)
	}
	if info.ProtocolVersion != proto.ProtocolVersion {
		t.Errorf("ProtocolVersion = %d, want %d", info.ProtocolVersion, proto.ProtocolVersion)
	}
	if info.VaultRoot != "/home/me/vault" {
		t.Errorf("VaultRoot = %q, want /home/me/vault", info.VaultRoot)
	}

	// Capabilities must be sorted so callers can diff across runs.
	want := []string{"auth", "fs.list", "fs.stat"}
	if len(info.Capabilities) != len(want) {
		t.Fatalf("Capabilities length = %d, want %d", len(info.Capabilities), len(want))
	}
	for i := range want {
		if info.Capabilities[i] != want[i] {
			t.Errorf("Capabilities[%d] = %q, want %q", i, info.Capabilities[i], want[i])
		}
	}
}
