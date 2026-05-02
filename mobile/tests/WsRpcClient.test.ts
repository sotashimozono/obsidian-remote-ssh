import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WsRpcClient } from '../src/transport/WsRpcClient';
import { RpcError } from '../src/transport/RpcError';

// ── Minimal WsChannel stub ────────────────────────────────────────────────────

function makeChannel() {
  let messageHandler: ((body: Uint8Array) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const sent: string[] = [];
  let closed = false;

  return {
    onMessage(cb: (body: Uint8Array) => void) {
      messageHandler = cb;
      return () => { messageHandler = null; };
    },
    onClose(cb: () => void) {
      closeHandler = cb;
      return () => { closeHandler = null; };
    },
    send(body: Uint8Array) {
      if (closed) throw new Error('closed');
      sent.push(new TextDecoder().decode(body));
    },
    close() { closed = true; closeHandler?.(); },
    // test helpers
    _deliver(obj: unknown) {
      messageHandler?.(new TextEncoder().encode(JSON.stringify(obj)));
    },
    _close() { closeHandler?.(); },
    _sent: sent,
  };
}

// ── WsRpcClient tests ─────────────────────────────────────────────────────────

describe('WsRpcClient — happy path', () => {
  it('sends a JSON-RPC request and resolves with result', async () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);

    const p = client.call('fs.stat', { path: '/foo' });

    // Deliver matching response
    const sent = JSON.parse(ch._sent[0]);
    ch._deliver({ jsonrpc: '2.0', id: sent.id, result: { type: 'file', mtime: 100, size: 10, mode: 0o644 } });

    const result = await p;
    expect(result).toMatchObject({ type: 'file' });
  });

  it('increments the request id for each call', async () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);

    // Fire two calls without waiting
    const p1 = client.call('fs.exists', { path: '/a' });
    const p2 = client.call('fs.exists', { path: '/b' });

    const [req1, req2] = ch._sent.map(s => JSON.parse(s));
    expect(req1.id).not.toBe(req2.id);

    ch._deliver({ jsonrpc: '2.0', id: req1.id, result: { exists: true } });
    ch._deliver({ jsonrpc: '2.0', id: req2.id, result: { exists: false } });

    expect(await p1).toEqual({ exists: true });
    expect(await p2).toEqual({ exists: false });
  });
});

describe('WsRpcClient — error handling', () => {
  it('rejects with RpcError when daemon returns error envelope', async () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);

    const p = client.call('fs.stat', { path: '/missing' });
    const req = JSON.parse(ch._sent[0]);
    ch._deliver({ jsonrpc: '2.0', id: req.id, error: { code: -32020, message: 'not found' } });

    await expect(p).rejects.toThrow(RpcError);
    await expect(p).rejects.toMatchObject({ code: -32020 });
  });

  it('rejects pending calls when channel closes', async () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);

    const p = client.call('fs.stat', { path: '/x' });
    ch._close();

    await expect(p).rejects.toThrow(RpcError);
  });

  it('rejects immediately when already closed', async () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);
    ch._close();

    await expect(client.call('fs.stat', { path: '/x' })).rejects.toThrow(RpcError);
  });

  it('times out a call that gets no response', async () => {
    vi.useFakeTimers();
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any, { timeoutMs: 1_000 });

    const p = client.call('fs.stat', { path: '/slow' });
    vi.advanceTimersByTime(1_001);

    await expect(p).rejects.toThrow(/timeout/i);
    vi.useRealTimers();
  });
});

describe('WsRpcClient — notifications', () => {
  it('delivers server-push notifications to registered handlers', () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);
    const handler = vi.fn();

    client.onNotification('fs.watch', handler);
    ch._deliver({ jsonrpc: '2.0', method: 'fs.watch', params: { path: '/vault', event: 'modify' } });

    expect(handler).toHaveBeenCalledWith({ path: '/vault', event: 'modify' });
  });

  it('disposer removes the notification handler', () => {
    const ch = makeChannel();
    const client = new WsRpcClient(ch as any);
    const handler = vi.fn();

    const dispose = client.onNotification('fs.watch', handler);
    dispose();
    ch._deliver({ jsonrpc: '2.0', method: 'fs.watch', params: {} });

    expect(handler).not.toHaveBeenCalled();
  });
});
