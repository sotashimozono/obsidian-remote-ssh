import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import type { Duplex } from 'stream';
import { establishRpcConnection } from '../src/transport/RpcConnection';
import { FramedDuplex } from '../src/transport/framing';
import { RpcError } from '../src/transport/RpcError';
import { ErrorCode, PROTOCOL_VERSION } from '../src/proto/types';

/**
 * Builds a duplex pair where writes to `clientSide` show up as reads
 * on `serverSide`, and vice versa. The "server" mocks the daemon by
 * watching incoming framed JSON-RPC requests and responding directly.
 */
function duplexPair(): { clientSide: Duplex; serverSide: Duplex } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const clientSide = combine(serverToClient, clientToServer);
  const serverSide = combine(clientToServer, serverToClient);
  return { clientSide, serverSide };
}

function combine(reads: PassThrough, writes: PassThrough): Duplex {
  return {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data' || event === 'end' || event === 'close' || event === 'error') {
        reads.on(event, listener);
      }
      return this;
    },
    write: (chunk: Buffer) => writes.write(chunk),
    end: () => { writes.end(); reads.end(); },
  } as unknown as Duplex;
}

interface ServerScript {
  /** Optional override for server.info; defaults to the protocol's version. */
  info?: { protocolVersion: number };
  /** Make `auth` reject with a custom error envelope. */
  authReject?: { code: number; message: string };
}

/**
 * Wires a FramedDuplex on the "server" side of a duplex pair and
 * answers `auth` + `server.info` according to a tiny script. Returns
 * a disposer to release event listeners after the test.
 */
function startFakeDaemon(serverSide: Duplex, script: ServerScript = {}): () => void {
  const framed = new FramedDuplex(serverSide);
  framed.on('message', (body: Buffer) => {
    const req = JSON.parse(body.toString('utf8')) as { id: number; method: string };
    if (req.method === 'auth') {
      if (script.authReject) {
        framed.writeMessage(Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: req.id, error: script.authReject,
        }), 'utf8'));
      } else {
        framed.writeMessage(Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: req.id, result: { ok: true },
        }), 'utf8'));
      }
      return;
    }
    if (req.method === 'server.info') {
      const info = script.info ?? { protocolVersion: PROTOCOL_VERSION };
      framed.writeMessage(Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: {
          version: 'test-1.0', protocolVersion: info.protocolVersion,
          capabilities: ['auth', 'server.info'], vaultRoot: '/v',
        },
      }), 'utf8'));
      return;
    }
    framed.writeMessage(Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` },
    }), 'utf8'));
  });
  return () => framed.close();
}

describe('establishRpcConnection', () => {
  it('completes auth → server.info and returns the daemon info', async () => {
    const pair = duplexPair();
    const stop = startFakeDaemon(pair.serverSide);
    const conn = await establishRpcConnection({ stream: pair.clientSide, token: 'good' });
    expect(conn.info.version).toBe('test-1.0');
    expect(conn.info.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(conn.info.capabilities).toContain('auth');
    conn.close();
    stop();
  });

  it('rejects with the daemon-supplied error code when auth fails', async () => {
    const pair = duplexPair();
    const stop = startFakeDaemon(pair.serverSide, {
      authReject: { code: ErrorCode.AuthInvalid, message: 'wrong token' },
    });
    await expect(
      establishRpcConnection({ stream: pair.clientSide, token: 'bad' }),
    ).rejects.toMatchObject({ code: ErrorCode.AuthInvalid });
    stop();
  });

  it('rejects with ProtocolVersionTooOld when versions disagree', async () => {
    const pair = duplexPair();
    const stop = startFakeDaemon(pair.serverSide, { info: { protocolVersion: 999 } });
    try {
      await establishRpcConnection({ stream: pair.clientSide, token: 'good' });
      expect.fail('expected handshake to reject for protocol mismatch');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe(ErrorCode.ProtocolVersionTooOld);
    }
    stop();
  });
});
