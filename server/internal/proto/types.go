// Package proto defines the JSON-RPC protocol shared with the
// obsidian-remote-ssh plugin.
//
// This file is a hand-maintained mirror of
// plugin/src/proto/types.ts. When the spec changes, both sides move
// in the same PR. See proto/README.md for the normative description.
package proto

import "encoding/json"

// ProtocolVersion is the integer version negotiated at handshake.
// Bump it for any breaking change on the wire.
const ProtocolVersion = 1

// ─── core shapes ────────────────────────────────────────────────────────────

// ServerInfo is returned by the server.info method.
type ServerInfo struct {
	// Version is the daemon's implementation version, e.g. "0.1.0".
	Version string `json:"version"`
	// ProtocolVersion is the wire version; compare against ProtocolVersion.
	ProtocolVersion int `json:"protocolVersion"`
	// Capabilities lists the methods this daemon implements,
	// e.g. ["fs.stat", "fs.list", ...].
	Capabilities []string `json:"capabilities"`
	// VaultRoot is the absolute path of the vault on the remote host
	// (informational; every `path` in other methods is vault-relative).
	VaultRoot string `json:"vaultRoot"`
}

// EntryType distinguishes files from directories.
type EntryType string

const (
	EntryTypeFile    EntryType = "file"
	EntryTypeFolder  EntryType = "folder"
	EntryTypeSymlink EntryType = "symlink"
)

// Stat describes a single filesystem entry.
type Stat struct {
	Type EntryType `json:"type"`
	// Mtime is the modification time in unix milliseconds.
	Mtime int64 `json:"mtime"`
	// Size in bytes; 0 for directories.
	Size int64 `json:"size"`
	// Mode is POSIX mode bits (informational).
	Mode uint32 `json:"mode"`
}

// Entry is a directory listing row.
type Entry struct {
	// Name is the basename only (no slashes).
	Name  string    `json:"name"`
	Type  EntryType `json:"type"`
	Mtime int64     `json:"mtime"`
	Size  int64     `json:"size"`
}

// ─── method param / result shapes ───────────────────────────────────────────

type AuthParams struct {
	Token string `json:"token"`
}
type AuthResult struct {
	OK bool `json:"ok"`
}

type PathOnlyParams struct {
	Path string `json:"path"`
}
type ExistsResult struct {
	Exists bool `json:"exists"`
}
type ListResult struct {
	Entries []Entry `json:"entries"`
}

type ReadTextParams struct {
	Path     string `json:"path"`
	Encoding string `json:"encoding,omitempty"` // "utf8" when set
}
type ReadTextResult struct {
	Content  string `json:"content"`
	Mtime    int64  `json:"mtime"`
	Size     int64  `json:"size"`
	Encoding string `json:"encoding"` // always "utf8" for now
}
type ReadBinaryResult struct {
	ContentBase64 string `json:"contentBase64"`
	Mtime         int64  `json:"mtime"`
	Size          int64  `json:"size"`
}

type WriteTextParams struct {
	Path          string `json:"path"`
	Content       string `json:"content"`
	// ExpectedMtime, when non-zero, causes the write to fail with
	// PreconditionFailed if the remote file's mtime differs.
	ExpectedMtime int64 `json:"expectedMtime,omitempty"`
}
type WriteBinaryParams struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	ExpectedMtime int64  `json:"expectedMtime,omitempty"`
}
type AppendTextParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type AppendBinaryParams struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
}
type MtimeResult struct {
	Mtime int64 `json:"mtime"`
}

type MkdirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}
type RmdirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}
type RenameParams struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}
type CopyParams struct {
	SrcPath  string `json:"srcPath"`
	DestPath string `json:"destPath"`
}

type WatchParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}
type WatchResult struct {
	SubscriptionID string `json:"subscriptionId"`
}
type UnwatchParams struct {
	SubscriptionID string `json:"subscriptionId"`
}

// ─── server-push notifications ──────────────────────────────────────────────

// FsChangeEvent is the kind of change the server observed on a watched path.
type FsChangeEvent string

const (
	FsChangeEventCreated  FsChangeEvent = "created"
	FsChangeEventModified FsChangeEvent = "modified"
	FsChangeEventDeleted  FsChangeEvent = "deleted"
	FsChangeEventRenamed  FsChangeEvent = "renamed"
)

type FsChangedParams struct {
	SubscriptionID string        `json:"subscriptionId"`
	Path           string        `json:"path"`
	Event          FsChangeEvent `json:"event"`
	// Mtime is set for created/modified/renamed.
	Mtime int64 `json:"mtime,omitempty"`
	// NewPath is set iff Event == FsChangeEventRenamed.
	NewPath string `json:"newPath,omitempty"`
}

// ─── JSON-RPC envelopes ─────────────────────────────────────────────────────

// JSONRPCVersion is the fixed protocol label on every envelope.
const JSONRPCVersion = "2.0"

// Request is a client-to-server call.
type Request struct {
	JSONRPC string          `json:"jsonrpc"` // always JSONRPCVersion
	ID      json.RawMessage `json:"id"`      // number or string (raw so we echo it faithfully)
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// Success is a server-to-client successful response.
type Success struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
}

// ErrorEnvelope is a server-to-client error response. `ID` is null when
// the server couldn't parse the request's id.
type ErrorEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   ErrorObject     `json:"error"`
}

// ErrorObject is the payload of ErrorEnvelope.Error.
type ErrorObject struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// Notification is a server-to-client message with no id (no reply expected).
type Notification struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// ─── error codes ────────────────────────────────────────────────────────────

// Error codes shared with the client. The JSON-RPC 2.0 reserved range is
// -32768..-32000; our custom codes live in the -32000..-32099 block.
const (
	ErrorParseError     = -32700
	ErrorInvalidRequest = -32600
	ErrorMethodNotFound = -32601
	ErrorInvalidParams  = -32602
	ErrorInternalError  = -32603

	ErrorAuthRequired          = -32000
	ErrorAuthInvalid           = -32001
	ErrorFileNotFound          = -32010
	ErrorNotADirectory         = -32011
	ErrorIsADirectory          = -32012
	ErrorExists                = -32013
	ErrorPermissionDenied      = -32014
	ErrorPathOutsideVault      = -32015
	ErrorPreconditionFailed    = -32020
	ErrorProtocolVersionTooOld = -32021
)
