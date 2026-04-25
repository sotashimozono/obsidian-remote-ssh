// Package handlers implements the method handlers registered with the
// JSON-RPC dispatcher. One file per method keeps the blast radius of
// changes small.
package handlers

import (
	"context"
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/auth"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

// Auth returns the handler for the `auth` method. The caller passes
// in the expected token (read from disk at startup); this keeps the
// handler stateless and trivially testable.
func Auth(expected auth.Token) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		var p proto.AuthParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, rpc.ErrInvalidParams("auth: " + err.Error())
		}
		if !expected.Equals(p.Token) {
			return nil, rpc.ErrAuthInvalid()
		}
		server.SessionFromContext(ctx).MarkAuthenticated()
		return proto.AuthResult{OK: true}, nil
	}
}

// RequireAuth wraps h so that a non-auth method fails with AuthRequired
// until the session has accepted a valid auth call.
func RequireAuth(h rpc.Handler) rpc.Handler {
	return func(ctx context.Context, params json.RawMessage) (interface{}, *rpc.Error) {
		if !server.SessionFromContext(ctx).IsAuthenticated() {
			return nil, rpc.ErrAuthRequired()
		}
		return h(ctx, params)
	}
}
