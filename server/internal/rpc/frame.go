// Package rpc implements the wire-framing and dispatch of JSON-RPC 2.0
// messages between the plugin and the daemon.
//
// The framing convention matches the Language Server Protocol:
//
//	Content-Length: <N>\r\n
//	\r\n
//	<N bytes of UTF-8 JSON body>
//
// No other headers are recognised; a missing or malformed
// Content-Length closes the connection.
package rpc

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// DefaultMaxMessageBytes caps a single inbound message. Messages
// larger than this close the connection with a framing error rather
// than risk unbounded memory use.
const DefaultMaxMessageBytes = 16 * 1024 * 1024 // 16 MiB

// ErrMessageTooLarge is returned by ReadFrame when Content-Length
// exceeds the configured limit.
var ErrMessageTooLarge = errors.New("rpc: message exceeds maximum size")

// ReadFrame reads one framed message off r and returns the JSON body
// (without the headers). `max` bounds the declared Content-Length; a
// value of 0 means "use DefaultMaxMessageBytes".
//
// An io.EOF at a clean frame boundary is returned as-is so callers can
// treat it as "peer closed cleanly" rather than as an error.
func ReadFrame(r *bufio.Reader, max int) ([]byte, error) {
	if max <= 0 {
		max = DefaultMaxMessageBytes
	}

	contentLength := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			// An EOF before we've seen any header is a clean close.
			if errors.Is(err, io.EOF) && line == "" && contentLength < 0 {
				return nil, io.EOF
			}
			return nil, fmt.Errorf("rpc: read header: %w", err)
		}
		// LSP requires \r\n; tolerate bare \n from lenient clients.
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			// Blank line terminates the header block.
			break
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("rpc: malformed header %q", line)
		}
		name = strings.TrimSpace(name)
		value = strings.TrimSpace(value)
		if strings.EqualFold(name, "Content-Length") {
			n, err := strconv.Atoi(value)
			if err != nil || n < 0 {
				return nil, fmt.Errorf("rpc: invalid Content-Length %q", value)
			}
			contentLength = n
		}
		// Any other header is ignored for forward-compat.
	}

	if contentLength < 0 {
		return nil, errors.New("rpc: missing Content-Length header")
	}
	if contentLength > max {
		return nil, fmt.Errorf("%w: %d > %d", ErrMessageTooLarge, contentLength, max)
	}

	body := make([]byte, contentLength)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("rpc: read body: %w", err)
	}
	return body, nil
}

// WriteFrame writes body as one framed message to w.
func WriteFrame(w io.Writer, body []byte) error {
	header := fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))
	if _, err := io.WriteString(w, header); err != nil {
		return fmt.Errorf("rpc: write header: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("rpc: write body: %w", err)
	}
	if flusher, ok := w.(interface{ Flush() error }); ok {
		if err := flusher.Flush(); err != nil {
			return fmt.Errorf("rpc: flush: %w", err)
		}
	}
	return nil
}
