import { describe, it, expect, vi } from 'vitest';
import { WsRpcConnection } from '../src/transport/WsRpcConnection';

// ── Fake WebSocket ────────────────────────────────────────────────────────────

function makeFakeWs(initialState: number = WebSocket.OPEN) {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const frames: string[] = [];

  const ws = {
    readyState: initialState,
    addEventListener(type: string, cb: (ev: unknown) => void) {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener(type: string, cb: (ev: unknown) => void) {
      listeners[type] = (listeners[type] ?? []).filter(h => h !== cb);
    },
    send(data: string) { frames.push(data); },
    close() {},
    // test helpers
    emit(type: string, ev: unknown = {}) {
      for (const h of listeners[type] ?? []) h(ev);
    },
    deliver(obj: unknown) {
      const json = JSON.stringify(obj);
      const frame = `Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`;
      this.emit('message', { data: frame });
    },
    frames,
  };
  return ws;
}

function parseFrame(frame: string) {
  return JSON.parse(frame.split('\r\n\r\n')[1]);
}

// ── WsRpcConnection tests ─────────────────────────────────────────────────────

describe('WsRpcConnection.connect', () => {
  it('resolves after auth + server.info succeed', async () => {
    const ws = makeFakeWs();
    const connectPromise = WsRpcConnection.connect(ws as unknown as WebSocket, {
      token: 'secret-token',
    });

    // Wait for auth frame to be sent
    await vi.waitFor(() => expect(ws.frames.length).toBeGreaterThanOrEqual(1));
    const authReq = parseFrame(ws.frames[0]);
    expect(authReq.method).toBe('auth');
    expect(authReq.params.token).toBe('secret-token');

    // Reply to auth → triggers server.info call
    ws.deliver({ jsonrpc: '2.0', id: authReq.id, result: {} });

    // Wait for server.info frame to be sent
    await vi.waitFor(() => expect(ws.frames.length).toBeGreaterThanOrEqual(2));
    const infoReq = parseFrame(ws.frames[1]);
    expect(infoReq.method).toBe('server.info');

    // Reply to server.info
    ws.deliver({
      jsonrpc: '2.0',
      id: infoReq.id,
      result: { version: '1.2.3', protocolVersion: 1, capabilities: [], vaultRoot: '/home/user/vault' },
    });

    const conn = await connectPromise;
    expect(conn.serverInfo.version).toBe('1.2.3');
    expect(conn.serverInfo.vaultRoot).toBe('/home/user/vault');
    expect(conn.rpc.isClosed()).toBe(false);
  });

  it('rejects when auth RPC returns an error', async () => {
    const ws = makeFakeWs();
    const connectPromise = WsRpcConnection.connect(ws as unknown as WebSocket, { token: 'bad' });

    await vi.waitFor(() => expect(ws.frames.length).toBeGreaterThanOrEqual(1));
    const authReq = parseFrame(ws.frames[0]);
    ws.deliver({ jsonrpc: '2.0', id: authReq.id, error: { code: -32011, message: 'auth invalid' } });

    await expect(connectPromise).rejects.toMatchObject({ code: -32011 });
  });

  it('rejects when WebSocket closes before open (CONNECTING state)', async () => {
    const ws = makeFakeWs(WebSocket.CONNECTING);
    const connectPromise = WsRpcConnection.connect(ws as unknown as WebSocket, { token: 't' });
    ws.emit('close', {});
    await expect(connectPromise).rejects.toThrow(/closed before open/i);
  });
});
