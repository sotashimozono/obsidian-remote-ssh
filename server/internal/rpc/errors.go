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

// ErrNotADirectory signals that the target of a dir-only op (list,
// rmdir, …) points to a regular file.
func ErrNotADirectory(p string) *Error {
	return Err(proto.ErrorNotADirectory, "not a directory: "+p, nil)
}

// ErrIsADirectory signals that the target of a file-only op (read,
// remove) points to a directory.
func ErrIsADirectory(p string) *Error {
	return Err(proto.ErrorIsADirectory, "is a directory: "+p, nil)
}

// ErrExists signals that a create-like op found the path already present.
func ErrExists(p string) *Error {
	return Err(proto.ErrorExists, "already exists: "+p, nil)
}

// ErrPermissionDenied signals that the OS refused the operation.
func ErrPermissionDenied(p string) *Error {
	return Err(proto.ErrorPermissionDenied, "permission denied: "+p, nil)
}

// ErrPathOutsideVault signals that the resolved path escapes the vault.
func ErrPathOutsideVault(p string) *Error {
	return Err(proto.ErrorPathOutsideVault, "path outside vault: "+p, nil)
}

// ErrPreconditionFailed signals that an expectedMtime did not match.
func ErrPreconditionFailed(msg string) *Error {
	return Err(proto.ErrorPreconditionFailed, msg, nil)
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
