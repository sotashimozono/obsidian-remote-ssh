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

// ReadBinaryRangeParams are the inputs to fs.readBinaryRange — the
// partial-read sibling of fs.readBinary. Offset is bytes from the
// start of the file; Length is the number of bytes the caller wants.
// Reads past EOF clamp silently — the caller can detect the clamp
// by comparing len(decoded ContentBase64) against the requested
// Length, and Size in the result always reports the total file size.
//
// ExpectedMtime, when non-zero, fails the request with
// PreconditionFailed if the file's current mtime differs. Range-aware
// callers (e.g. ResourceBridge serving HTTP byte ranges to the
// webview) thread the first response's Mtime back as ExpectedMtime
// on follow-up range requests so a mid-read edit invalidates cleanly
// instead of silently stitching slices from two different file
// generations.
type ReadBinaryRangeParams struct {
	Path          string `json:"path"`
	Offset        int64  `json:"offset"`
	Length        int64  `json:"length"`
	ExpectedMtime int64  `json:"expectedMtime,omitempty"`
}

// ReadBinaryRangeResult mirrors ReadBinaryResult but Size always
// reports the TOTAL on-disk file size, not the returned slice length.
// HTTP Content-Range responses need the total to build
// `bytes start-end/<total>`; the returned slice length can be derived
// from len(decoded ContentBase64).
type ReadBinaryRangeResult struct {
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

// WalkParams are the inputs to fs.walk — a single-RPC alternative to
// recursively calling fs.list. `MaxEntries` caps the response size so
// pathological vaults don't OOM the client; the daemon halts and sets
// `Truncated: true` so the caller can fall back to per-folder listing.
type WalkParams struct {
	Path       string `json:"path"`
	Recursive  bool   `json:"recursive,omitempty"`
	MaxEntries int    `json:"maxEntries,omitempty"`
}

// WalkEntry is one row in fs.walk's flat output. Unlike fs.list's
// Entry, the path is vault-relative (not just a basename) so callers
// don't have to reconstruct it from the request path + entry name.
type WalkEntry struct {
	Path  string    `json:"path"`
	Type  EntryType `json:"type"`
	Mtime int64     `json:"mtime"`
	Size  int64     `json:"size"`
}

// WalkResult is fs.walk's response. `Truncated` is set when the daemon
// stopped early because `MaxEntries` was reached; the entries already
// returned are still authoritative.
type WalkResult struct {
	Entries   []WalkEntry `json:"entries"`
	Truncated bool        `json:"truncated"`
}

// ThumbnailParams are the inputs to fs.thumbnail. The daemon decodes
// the source image, resizes so the longer side is at most MaxDim
// pixels (preserving aspect ratio), and re-encodes. Sources smaller
// than MaxDim are returned re-encoded but not upscaled.
type ThumbnailParams struct {
	Path string `json:"path"`
	// MaxDim is the longer-side cap in pixels. Required (no default
	// here; the plugin picks per-call so the daemon stays stateless).
	MaxDim int `json:"maxDim"`
}

// ThumbnailResult mirrors ReadBinaryResult: base64 payload + the
// SOURCE file's mtime (so client-side caches can invalidate on edit)
// + the SOURCE file's size for diagnostics. The Format field tells
// the caller what to set Content-Type to when serving.
type ThumbnailResult struct {
	ContentBase64 string `json:"contentBase64"`
	Mtime         int64  `json:"mtime"`
	// SourceSize is the on-disk size of the source image in bytes —
	// useful for logging the bandwidth saved versus a raw fs.readBinary.
	SourceSize int64 `json:"sourceSize"`
	// Format is the encoded format of the returned bytes: "jpeg" or
	// "png". JPEG is preferred; PNG is used when the source has alpha
	// so transparency survives.
	Format string `json:"format"`
	// Width / Height of the returned image (post-resize), in pixels.
	Width  int `json:"width"`
	Height int `json:"height"`
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

// Meta is optional out-of-band metadata attached to any RPC envelope.
//
// Cid is a 16-char hex correlation id minted on the writer side
// (typically by the plugin's PerfTracer); the daemon echoes it on the
// fs.changed notification triggered by that write so end-to-end
// latency spans can be reconstructed across processes. The field is
// strictly additive: older clients that don't send it stay valid, and
// older daemons that don't read it (omitempty keeps it off the wire
// when unset, json.Unmarshal skips it on receive) stay valid too.
type Meta struct {
	Cid string `json:"cid,omitempty"`
}

// Request is a client-to-server call.
type Request struct {
	JSONRPC string          `json:"jsonrpc"` // always JSONRPCVersion
	ID      json.RawMessage `json:"id"`      // number or string (raw so we echo it faithfully)
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
	// Meta carries optional cross-process correlation. nil when absent
	// on the wire; handlers retrieve it from the request context via
	// rpc.MetaFromContext rather than reading the field directly.
	Meta *Meta `json:"meta,omitempty"`
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
	// Meta mirrors Request.Meta on the server-push direction. The
	// daemon attaches it (e.g. the cid from the originating write) so
	// the client can stitch this notification back to a writer-side
	// span. Optional; older receivers ignore it.
	Meta *Meta `json:"meta,omitempty"`
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
