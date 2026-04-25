package rpc

import (
	"encoding/json"

	"github.com/sotashimozono/obsidian-remote-ssh/server/internal/proto"
)

// Error is a convenience wrapper around proto.ErrorObject used in
// dispatch paths so handlers can `return nil, rpc.Err(...)` without
// rebuilding the struct literal each time.
type Error = proto.ErrorObject

// Err builds an Error with the given code and message. `data` is
// optional; pass nil when there's nothing structured to include.
func Err(code int, message string, data interface{}) *Error {
	return &Error{Code: code, Message: message, Data: data}
}

// ErrParse       returns a -32700 ParseError.
func ErrParse(msg string) *Error { return Err(proto.ErrorParseError, msg, nil) }

// ErrInvalidReq  returns a -32600 InvalidRequest.
func ErrInvalidReq(msg string) *Error { return Err(proto.ErrorInvalidRequest, msg, nil) }

// ErrMethodMissing returns a -32601 MethodNotFound.
func ErrMethodMissing(method string) *Error {
	return Err(proto.ErrorMethodNotFound, "method not found: "+method, nil)
}

// ErrInvalidParams returns a -32602 InvalidParams.
func ErrInvalidParams(msg string) *Error { return Err(proto.ErrorInvalidParams, msg, nil) }

// ErrInternal    returns a -32603 InternalError.
func ErrInternal(msg string) *Error { return Err(proto.ErrorInternalError, msg, nil) }

// ErrAuthRequired and friends are convenience builders for the custom
// error codes defined in proto/types.go.

func ErrAuthRequired() *Error    { return Err(proto.ErrorAuthRequired, "auth required", nil) }
func ErrAuthInvalid() *Error     { return Err(proto.ErrorAuthInvalid, "invalid token", nil) }
func ErrFileNotFound(p string) *Error {
	return Err(proto.ErrorFileNotFound, "no such file: "+p, nil)
}

// encodeResult marshals a result value for WriteSuccess. Centralised
// here so the dispatcher and tests agree on JSON shape (omit null,
// preserve zero values, etc).
func encodeResult(v interface{}) (json.RawMessage, error) {
	if v == nil {
		return json.RawMessage("null"), nil
	}
	return json.Marshal(v)
}
