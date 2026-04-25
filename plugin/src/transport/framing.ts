import { EventEmitter } from 'events';
import type { Duplex } from 'stream';

/**
 * Wraps a Node Duplex (e.g., a TCP socket or the openssh_forwardOutStreamLocal
 * stream) with LSP-style message framing:
 *
 *     Content-Length: <N>\r\n
 *     \r\n
 *     <N bytes of UTF-8 JSON body>
 *
 * Matches what `server/internal/rpc/frame.go` produces on the daemon side.
 *
 * Emits:
 *   'message' (body: Buffer)  — one fully-assembled message
 *   'close'                    — the underlying stream ended
 *   'error' (err: Error)      — framing violation or stream-level error
 */
export class FramedDuplex extends EventEmitter {
  /** Accumulates inbound bytes until enough have arrived to emit a message. */
  private buffer: Buffer = Buffer.alloc(0);
  /** Once headers are parsed, holds the declared body length until we have that many bytes. */
  private pendingBodyLength: number | null = null;
  private readonly maxMessageBytes: number;
  private closed = false;

  constructor(
    private readonly stream: Duplex,
    options: { maxMessageBytes?: number } = {},
  ) {
    super();
    this.maxMessageBytes = options.maxMessageBytes ?? 16 * 1024 * 1024;

    stream.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.on('end',  () => this.onEnd());
    stream.on('close',() => this.onEnd());
    stream.on('error', err => this.emit('error', err));
  }

  /** Write one framed message. Returns false if the downstream buffer is full (standard backpressure hint). */
  writeMessage(body: Buffer): boolean {
    if (this.closed) throw new Error('FramedDuplex: closed');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    const ok1 = this.stream.write(header);
    const ok2 = this.stream.write(body);
    return ok1 && ok2;
  }

  /** Shut the wire down. Subsequent writeMessage calls throw. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.end(); } catch { /* ignore */ }
  }

  // ─── parser ──────────────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Drain as many complete frames as we can; each iteration either peels one
    // frame off the front of `buffer` or stops waiting for more bytes.
    while (this.tryConsumeFrame()) { /* loop */ }
  }

  /** Returns true if it peeled a frame and there may be more; false to wait for more bytes. */
  private tryConsumeFrame(): boolean {
    if (this.pendingBodyLength === null) {
      const bodyStart = findHeaderEnd(this.buffer);
      if (bodyStart < 0) return false;
      const headersText = this.buffer.subarray(0, bodyStart).toString('ascii');
      const length = parseContentLength(headersText);
      if (length === null) {
        this.emit('error', new Error('FramedDuplex: missing Content-Length header'));
        this.close();
        return false;
      }
      if (length > this.maxMessageBytes) {
        this.emit('error', new Error(`FramedDuplex: message too large (${length} > ${this.maxMessageBytes})`));
        this.close();
        return false;
      }
      this.buffer = this.buffer.subarray(bodyStart);
      this.pendingBodyLength = length;
    }

    if (this.buffer.length < this.pendingBodyLength) return false;

    const body = this.buffer.subarray(0, this.pendingBodyLength);
    this.buffer = this.buffer.subarray(this.pendingBodyLength);
    this.pendingBodyLength = null;
    this.emit('message', Buffer.from(body)); // copy so later buffer shrinks don't mutate it
    return this.buffer.length > 0;
  }

  private onEnd(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/**
 * Returns the byte index in `buf` where the body starts (one past the
 * terminator that closes the header block), or -1 when no terminator
 * has arrived yet. Prefers the spec-compliant `\r\n\r\n`; also accepts
 * bare `\n\n` from lenient senders.
 */
function findHeaderEnd(buf: Buffer): number {
  for (let i = 3; i < buf.length; i++) {
    if (
      buf[i - 3] === 0x0d && buf[i - 2] === 0x0a &&
      buf[i - 1] === 0x0d && buf[i] === 0x0a
    ) {
      return i + 1;
    }
  }
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] === 0x0a && buf[i] === 0x0a) {
      return i + 1;
    }
  }
  return -1;
}

function parseContentLength(headers: string): number | null {
  const lines = headers.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'content-length') {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}
