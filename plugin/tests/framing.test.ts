import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { FramedDuplex } from '../src/transport/framing';

/**
 * A pair of PassThrough streams wired crossways gives us an in-process
 * Duplex — writes to `local` read from `remote.peer`, and vice versa.
 * Matches the semantics of a TCP socket pair with zero OS overhead.
 */
function duplexPair() {
  const a = new PassThrough();
  const b = new PassThrough();
  // Each side's writes should appear as the other side's reads.
  // A `PassThrough` is a single-channel stream; to get a true duplex
  // we expose one PassThrough per direction.
  return {
    a: combine(a, b),
    b: combine(b, a),
  };
}

/** Cobbled-together Duplex: reads from `inStream`, writes to `outStream`. */
function combine(inStream: PassThrough, outStream: PassThrough) {
  return {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data' || event === 'end' || event === 'close' || event === 'error') {
        inStream.on(event, listener);
      }
      return this;
    },
    write: (chunk: Buffer) => outStream.write(chunk),
    end: () => { outStream.end(); inStream.end(); },
  } as unknown as import('stream').Duplex;
}

function collectMessages(framed: FramedDuplex): { messages: Buffer[]; closed: boolean; errors: Error[] } {
  const messages: Buffer[] = [];
  const errors: Error[] = [];
  let closed = false;
  framed.on('message', (m: Buffer) => messages.push(m));
  framed.on('close', () => { closed = true; });
  framed.on('error', (e: Error) => errors.push(e));
  return { messages, closed, errors } as { messages: Buffer[]; closed: boolean; errors: Error[] };
}

describe('FramedDuplex', () => {
  it('round-trips a single message across a duplex pair', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const client = new FramedDuplex(pair.b);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    client.writeMessage(Buffer.from('{"hello":"world"}', 'utf8'));
    await new Promise(r => setImmediate(r));

    expect(received.length).toBe(1);
    expect(received[0].toString('utf8')).toBe('{"hello":"world"}');
  });

  it('parses multiple back-to-back messages off the same stream', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const client = new FramedDuplex(pair.b);
    const received: string[] = [];
    server.on('message', (m: Buffer) => received.push(m.toString('utf8')));

    client.writeMessage(Buffer.from('A', 'utf8'));
    client.writeMessage(Buffer.from('BB', 'utf8'));
    client.writeMessage(Buffer.from('CCC', 'utf8'));
    await new Promise(r => setImmediate(r));

    expect(received).toEqual(['A', 'BB', 'CCC']);
  });

  it('reassembles a message delivered in several small chunks', async () => {
    // Mock a stream where bytes arrive one at a time to hammer the
    // parser's "not enough bytes yet" path.
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    const body = Buffer.from('{"a":1,"b":2}', 'utf8');
    const wire = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
      body,
    ]);
    // Hand-feed the server's input stream one byte at a time.
    const rawIn = (pair.a as unknown as { peer?: never });
    void rawIn;
    for (const byte of wire) {
      (pair.b as unknown as { write(b: Buffer): void }).write(Buffer.from([byte]));
      await new Promise(r => setImmediate(r));
    }
    expect(received.length).toBe(1);
    expect(received[0].equals(body)).toBe(true);
  });

  it('emits an error when Content-Length is missing', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const errors: Error[] = [];
    server.on('error', (e: Error) => errors.push(e));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('X-Foo: bar\r\n\r\nhi', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/Content-Length/);
  });

  it('emits an error when the message exceeds maxMessageBytes', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a, { maxMessageBytes: 10 });
    const errors: Error[] = [];
    server.on('error', (e: Error) => errors.push(e));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 500\r\n\r\n', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/too large/);
  });

  it('tolerates bare-LF framing (for lenient senders)', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));
    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 2\n\nok', 'ascii'),
    );
    await new Promise(r => setImmediate(r));
    expect(received.length).toBe(1);
    expect(received[0].toString('utf8')).toBe('ok');
  });

  it('close() refuses subsequent writes', () => {
    const pair = duplexPair();
    const client = new FramedDuplex(pair.b);
    client.close();
    expect(() => client.writeMessage(Buffer.from('x'))).toThrow(/closed/);
  });

  it('emits close when stream ends mid-message (partial frame)', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const messages: Buffer[] = [];
    let closed = false;
    const errors: Error[] = [];
    server.on('message', (m: Buffer) => messages.push(m));
    server.on('close', () => { closed = true; });
    server.on('error', (e: Error) => errors.push(e));

    (pair.b as unknown as { write(b: Buffer): void; end(): void }).write(
      Buffer.from('Content-Length: 100\r\n\r\nABC', 'ascii'),
    );
    (pair.b as unknown as { end(): void }).end();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(messages).toHaveLength(0);
    expect(closed).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('handles a zero-length body correctly', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    const received: Buffer[] = [];
    server.on('message', (m: Buffer) => received.push(m));

    (pair.b as unknown as { write(b: Buffer): void }).write(
      Buffer.from('Content-Length: 0\r\n\r\n', 'ascii'),
    );
    await new Promise(r => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0].length).toBe(0);
  });

  it('does not emit close twice when stream fires both end and close', async () => {
    const pair = duplexPair();
    const server = new FramedDuplex(pair.a);
    let closeCount = 0;
    server.on('close', () => { closeCount++; });

    (pair.b as unknown as { end(): void }).end();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(closeCount).toBe(1);
  });
});
