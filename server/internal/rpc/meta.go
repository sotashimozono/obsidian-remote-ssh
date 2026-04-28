package rpc

import (
	"context"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// metaCtxKey is the unexported context key used by ContextWithMeta /
// MetaFromContext. Using a distinct unexported type avoids collisions
// with any other package that stashes values in the same context.
type metaCtxKey struct{}

// ContextWithMeta returns a copy of ctx that carries m. nil is allowed
// and is a no-op (returns the original ctx) so callers don't have to
// branch on whether the request had meta on the wire.
func ContextWithMeta(ctx context.Context, m *proto.Meta) context.Context {
	if m == nil {
		return ctx
	}
	return context.WithValue(ctx, metaCtxKey{}, m)
}

// MetaFromContext extracts the *proto.Meta attached by ContextWithMeta.
// The second return is false when no meta was attached — callers should
// treat that as "wire payload had no meta", not as an error.
//
// The returned pointer aliases the value stored in ctx; handlers must
// not mutate it. (proto.Meta is a tiny value type; copy by value if
// you need to modify.)
func MetaFromContext(ctx context.Context) (*proto.Meta, bool) {
	v, ok := ctx.Value(metaCtxKey{}).(*proto.Meta)
	if !ok {
		return nil, false
	}
	return v, true
}
