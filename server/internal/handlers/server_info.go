package handlers

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
)

// InfoSource is the subset of the dispatcher the server.info handler
// needs in order to advertise capabilities. Injecting an interface
// keeps the handler decoupled from `*rpc.Dispatcher` and makes it
// testable with a fake.
type InfoSource interface {
	// Methods returns the registered method names in any order.
	Methods() []string
}

// ServerInfo returns the handler for the `server.info` method.
// `version` is the daemon's implementation version string; `vaultRoot`
// is echoed to the client as documentation. Capabilities are the
// current dispatcher's registered method names, sorted for stability.
func ServerInfo(src InfoSource, version, vaultRoot string) rpc.Handler {
	return func(_ context.Context, _ json.RawMessage) (interface{}, *rpc.Error) {
		capabilities := src.Methods()
		sort.Strings(capabilities)
		return proto.ServerInfo{
			Version:         version,
			ProtocolVersion: proto.ProtocolVersion,
			Capabilities:    capabilities,
			VaultRoot:       vaultRoot,
		}, nil
	}
}
