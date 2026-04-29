import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import type { Duplex } from 'stream';
import { tryReuseExistingDaemon, type ProbeSshClient } from '../src/transport/DaemonProbe';
import { FramedDuplex } from '../src/transport/framing';
import { PROTOCOL_VERSION } from '../src/proto/types';

/**
 * In-memory duplex pair: writes on one side surface as reads on the
 * other. Identical pattern to the one in RpcConnection.test.ts so the
 * fake-daemon helpers below stay drop-in compatible.
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
    destroy: () => { writes.end(); reads.end(); },
  } as unknown as Duplex;
}

interface FakeScript {
  protocolVersion?: number;
  authReject?: boolean;
}

function startFakeDaemon(serverSide: Duplex, script: FakeScript = {}): () => void {
  const framed = new FramedDuplex(serverSide);
  framed.on('message', (body: Buffer) => {
    const req = JSON.parse(body.toString('utf8')) as { id: number; method: string };
    if (req.method === 'auth') {
      if (script.authReject) {
        framed.writeMessage(Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: req.id, error: { code: -32001, message: 'bad token' },
        }), 'utf8'));
      } else {
        framed.writeMessage(Buffer.from(JSON.stringify({
          jsonrpc: '2.0', id: req.id, result: { ok: true },
        }), 'utf8'));
      }
      return;
    }
    if (req.method === 'server.info') {
      framed.writeMessage(Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: {
          version: 'test-1.0',
          protocolVersion: script.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: ['auth', 'server.info'],
          vaultRoot: '/v',
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

interface MockOpts {
  /** Stdout returned by `test -S socket && echo OK || echo NO`. Default `'OK\n'`. */
  socketCheck?: string;
  /** If set, exec rejects with this error. */
  execThrows?: Error;
  /** Token contents returned by readRemoteFile. Default `'tok-abc123'`. */
  token?: string;
  /** If set, readRemoteFile rejects with this error. */
  readThrows?: Error;
  /** If set, openUnixStream rejects with this error. */
  streamThrows?: Error;
  /** Daemon script (protocol version, auth rejection). */
  daemon?: FakeScript;
}

interface MockResult {
  client: ProbeSshClient;
  /** Disposer for the fake daemon (no-op when streamThrows is set). */
  dispose: () => void;
}

function makeMock(opts: MockOpts = {}): MockResult {
  let dispose = () => { /* no daemon spun up */ };
  const client: ProbeSshClient = {
    exec: async () => {
      if (opts.execThrows) throw opts.execThrows;
      return { stdout: opts.socketCheck ?? 'OK\n', stderr: '', exitCode: 0 };
    },
    readRemoteFile: async () => {
      if (opts.readThrows) throw opts.readThrows;
      return Buffer.from(opts.token ?? 'tok-abc123', 'utf8');
    },
    openUnixStream: async () => {
      if (opts.streamThrows) throw opts.streamThrows;
      const { clientSide, serverSide } = duplexPair();
      dispose = startFakeDaemon(serverSide, opts.daemon ?? {});
      return clientSide;
    },
  };
  return { client, dispose: () => dispose() };
}

describe('tryReuseExistingDaemon', () => {
  it('returns null when the socket file is missing', async () => {
    const { client } = makeMock({ socketCheck: 'NO\n' });
    const result = await tryReuseExistingDaemon(client, '/h/.obsidian-remote/server.sock', '/h/.obsidian-remote/token');
    expect(result).toBeNull();
  });

  it('returns null when the socket-check exec rejects', async () => {
    const { client } = makeMock({ execThrows: new Error('ssh exec failed') });
    const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
    expect(result).toBeNull();
  });

  it('returns null when the token file cannot be read', async () => {
    const { client } = makeMock({ readThrows: new Error('No such file') });
    const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
    expect(result).toBeNull();
  });

  it('returns null when the token file is empty', async () => {
    const { client } = makeMock({ token: '   \n' });
    const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
    expect(result).toBeNull();
  });

  it('returns null when openUnixStream rejects', async () => {
    const { client } = makeMock({ streamThrows: new Error('connection refused') });
    const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
    expect(result).toBeNull();
  });

  it('returns null when the daemon rejects auth (stale token)', async () => {
    const { client, dispose } = makeMock({ daemon: { authReject: true } });
    try {
      const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
      expect(result).toBeNull();
    } finally {
      dispose();
    }
  });

  it('returns null when the daemon speaks an incompatible protocol', async () => {
    const { client, dispose } = makeMock({ daemon: { protocolVersion: PROTOCOL_VERSION + 1 } });
    try {
      const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
      expect(result).toBeNull();
    } finally {
      dispose();
    }
  });

  it('returns a live RpcConnection when the existing daemon is healthy and protocol-compatible', async () => {
    const { client, dispose } = makeMock();
    try {
      const result = await tryReuseExistingDaemon(client, '/h/sock', '/h/tok');
      expect(result).not.toBeNull();
      expect(result!.info.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(result!.info.version).toBe('test-1.0');
      result!.close();
    } finally {
      dispose();
    }
  });

  it('shell-escapes single quotes in the socket path before exec', async () => {
    let observedCmd = '';
    const client: ProbeSshClient = {
      exec: async (cmd) => { observedCmd = cmd; return { stdout: 'NO', stderr: '', exitCode: 0 }; },
      readRemoteFile: async () => Buffer.from(''),
      openUnixStream: async () => { throw new Error('not reached'); },
    };
    await tryReuseExistingDaemon(client, "/path/with'quote/sock", '/h/tok');
    // The escape pattern is 'foo'\''bar' — verify the literal embedded
    // single quote is sealed off rather than ending the outer quoting.
    expect(observedCmd).toContain(`'/path/with'\\''quote/sock'`);
  });
});
