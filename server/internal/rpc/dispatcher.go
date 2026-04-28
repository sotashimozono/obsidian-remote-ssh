package rpc

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// Handler runs one method call. `params` is the raw JSON value of the
// request's params (may be null or absent — handlers decide whether
// that is acceptable). Return a value to wrap in a success envelope,
// or a non-nil *Error to wrap in an error envelope. Returning both
// nil is treated as a `null` result.
type Handler func(ctx context.Context, params json.RawMessage) (interface{}, *Error)

// Dispatcher routes JSON-RPC requests by method name.
//
// Dispatcher is safe for concurrent use: handlers are only looked up,
// never mutated, after construction.
type Dispatcher struct {
	handlers map[string]Handler
}

// NewDispatcher returns an empty dispatcher. Register handlers via Handle.
func NewDispatcher() *Dispatcher {
	return &Dispatcher{handlers: map[string]Handler{}}
}

// Handle installs h under the given method name. Overwriting an
// existing handler is allowed (tests rely on it).
func (d *Dispatcher) Handle(method string, h Handler) {
	d.handlers[method] = h
}

// Methods returns the registered method names in arbitrary order.
// Intended for server.info.
func (d *Dispatcher) Methods() []string {
	out := make([]string, 0, len(d.handlers))
	for k := range d.handlers {
		out = append(out, k)
	}
	return out
}

// Process parses one framed request body and returns the bytes of the
// response envelope to write back, or nil if the message was a
// notification (no reply expected).
//
// Process never returns a Go error; all problems are reported as
// JSON-RPC error envelopes so the caller can just feed the bytes to
// WriteFrame.
func (d *Dispatcher) Process(ctx context.Context, body []byte) []byte {
	var req proto.Request
	if err := json.Unmarshal(body, &req); err != nil {
		return encodeError(nil, ErrParse(fmt.Sprintf("parse: %s", err)))
	}
	// A missing/empty id field means "notification" in JSON-RPC 2.0.
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"

	if req.JSONRPC != proto.JSONRPCVersion {
		if isNotification {
			return nil
		}
		return encodeError(req.ID, ErrInvalidReq("jsonrpc must be \"2.0\""))
	}
	if req.Method == "" {
		if isNotification {
			return nil
		}
		return encodeError(req.ID, ErrInvalidReq("method is required"))
	}

	h, ok := d.handlers[req.Method]
	if !ok {
		if isNotification {
			return nil
		}
		return encodeError(req.ID, ErrMethodMissing(req.Method))
	}

	// Thread per-request metadata (cid for cross-process latency
	// correlation) into ctx so handlers can opt in via MetaFromContext
	// without any signature changes. ContextWithMeta is a no-op when
	// req.Meta is nil — the common path stays free of allocation.
	ctx = ContextWithMeta(ctx, req.Meta)
	result, rpcErr := safeCall(ctx, h, req.Params)
	if isNotification {
		// Client asked for no reply; drop whatever the handler returned.
		return nil
	}
	if rpcErr != nil {
		return encodeError(req.ID, rpcErr)
	}
	return encodeSuccess(req.ID, result)
}

// safeCall runs a handler with a panic-to-InternalError recovery so
// one buggy handler can't take the whole session down.
func safeCall(ctx context.Context, h Handler, params json.RawMessage) (result interface{}, rpcErr *Error) {
	defer func() {
		if r := recover(); r != nil {
			rpcErr = ErrInternal(fmt.Sprintf("handler panicked: %v", r))
		}
	}()
	return h(ctx, params)
}

func encodeSuccess(id json.RawMessage, result interface{}) []byte {
	r, err := encodeResult(result)
	if err != nil {
		// Serialisation of a handler's result should not realistically
		// fail for our types, but handle it gracefully anyway.
		return encodeError(id, ErrInternal(fmt.Sprintf("encode result: %s", err)))
	}
	env := proto.Success{
		JSONRPC: proto.JSONRPCVersion,
		ID:      id,
		Result:  r,
	}
	b, err := json.Marshal(env)
	if err != nil {
		return encodeError(id, ErrInternal(fmt.Sprintf("encode envelope: %s", err)))
	}
	return b
}

func encodeError(id json.RawMessage, e *Error) []byte {
	if id == nil {
		id = json.RawMessage("null")
	}
	env := proto.ErrorEnvelope{
		JSONRPC: proto.JSONRPCVersion,
		ID:      id,
		Error:   *e,
	}
	b, err := json.Marshal(env)
	if err != nil {
		// Last-resort static error envelope so the connection doesn't
		// silently drop messages when something weird happens.
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"envelope encode failure"}}`)
	}
	return b
}
