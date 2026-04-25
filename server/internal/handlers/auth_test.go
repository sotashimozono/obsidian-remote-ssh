package handlers

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/auth"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/rpc"
	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/server"
)

const token = "correct-horse-battery-staple"

func TestAuth_AcceptsMatchingToken(t *testing.T) {
	h := Auth(auth.Token(token))
	sess := server.NewSession()
	ctx := server.WithSession(context.Background(), sess)

	result, rpcErr := h(ctx, json.RawMessage(`{"token":"correct-horse-battery-staple"}`))
	if rpcErr != nil {
		t.Fatalf("unexpected error: %+v", rpcErr)
	}
	if !sess.IsAuthenticated() {
		t.Error("session should be marked authenticated after a successful auth call")
	}
	got, ok := result.(proto.AuthResult)
	if !ok {
		t.Fatalf("result type = %T, want proto.AuthResult", result)
	}
	if !got.OK {
		t.Error("AuthResult.OK should be true")
	}
}

func TestAuth_RejectsMismatchedToken(t *testing.T) {
	h := Auth(auth.Token(token))
	sess := server.NewSession()
	ctx := server.WithSession(context.Background(), sess)

	_, rpcErr := h(ctx, json.RawMessage(`{"token":"wrong"}`))
	if rpcErr == nil || rpcErr.Code != proto.ErrorAuthInvalid {
		t.Fatalf("want AuthInvalid, got %+v", rpcErr)
	}
	if sess.IsAuthenticated() {
		t.Error("session must not be authenticated after a failed auth")
	}
}

func TestAuth_InvalidParams(t *testing.T) {
	h := Auth(auth.Token(token))
	ctx := server.WithSession(context.Background(), server.NewSession())

	_, rpcErr := h(ctx, json.RawMessage(`{"not json`))
	if rpcErr == nil || rpcErr.Code != proto.ErrorInvalidParams {
		t.Fatalf("want InvalidParams for garbage params, got %+v", rpcErr)
	}
}

func TestRequireAuth_BlocksUntilAuthenticated(t *testing.T) {
	innerCalled := false
	inner := func(_ context.Context, _ json.RawMessage) (interface{}, *rpc.Error) {
		innerCalled = true
		return "ok", nil
	}
	gated := RequireAuth(inner)

	sess := server.NewSession()
	ctx := server.WithSession(context.Background(), sess)

	// Before auth: should reject with AuthRequired and never call inner.
	_, rpcErr := gated(ctx, nil)
	if rpcErr == nil || rpcErr.Code != proto.ErrorAuthRequired {
		t.Fatalf("want AuthRequired before auth, got %+v", rpcErr)
	}
	if innerCalled {
		t.Error("inner handler must not be invoked before auth")
	}

	// After marking the session authenticated, the gate opens.
	sess.MarkAuthenticated()
	if _, err := gated(ctx, nil); err != nil {
		t.Errorf("gated call after auth failed: %+v", err)
	}
	if !innerCalled {
		t.Error("inner handler should be invoked once authenticated")
	}
}
