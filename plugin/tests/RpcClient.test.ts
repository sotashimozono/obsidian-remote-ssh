import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { RpcClient } from '../src/transport/RpcClient';
import { RpcError } from '../src/transport/RpcError';

/**
 * A FramedDuplex stand-in just rich enough for RpcClient: it exposes
 * the same events (`message`, `close`, `error`) and captures anything
 * written via `writeMessage` so tests can assert the wire shape.
 */
class FakeFramed extends EventEmitter {
  public sent: Buffer[] = [];
  public closed = false;
  writeMessage(body: Buffer): boolean {
    if (this.closed) throw new Error('closed');
    this.sent.push(body);
    return true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  /** Drive a response back to the client; for tests only. */
  pushMessage(envelope: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(envelope), 'utf8'));
  }
}

function setup() {
  const framed = new FakeFramed();
  const client = new RpcClient(framed as unknown as import('../src/transport/framing').FramedDuplex);
  return { framed, client };
}

describe('RpcClient', () => {
  it('correlates a call with its response by id', async () => {
    const { framed, client } = setup();
    const pending = client.call('server.info', {});
    expect(framed.sent.length).toBe(1);
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, result: { version: '1.0.0', protocolVersion: 1, capabilities: [], vaultRoot: '/v' } });
    const result = await pending;
    expect(result.version).toBe('1.0.0');
  });

  it('rejects with RpcError when the response is an error envelope', async () => {
    const { framed, client } = setup();
    const pending = client.call('fs.stat', { path: 'missing.md' });
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, error: { code: -32010, message: 'no such file' } });

    await expect(pending).rejects.toBeInstanceOf(RpcError);
    try {
      await pending;
    } catch (e) {
      expect((e as RpcError).code).toBe(-32010);
      expect((e as RpcError).is(-32010 as never)).toBe(true);
    }
  });

  it('demultiplexes concurrent calls', async () => {
    const { framed, client } = setup();
    const p1 = client.call('fs.stat', { path: 'a.md' });
    const p2 = client.call('fs.stat', { path: 'b.md' });
    expect(framed.sent.length).toBe(2);
    const [id1, id2] = framed.sent.map(b => (JSON.parse(b.toString('utf8')) as { id: number }).id);
    // Deliver out of order.
    framed.pushMessage({ jsonrpc: '2.0', id: id2, result: null });
    framed.pushMessage({ jsonrpc: '2.0', id: id1, result: { type: 'file', mtime: 1, size: 0, mode: 0 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toBeNull();
    expect(r1).not.toBeNull();
  });

  it('delivers notifications to registered handlers', () => {
    const { framed, client } = setup();
    const handler = vi.fn();
    client.onNotification('fs.changed', handler);
    framed.pushMessage({
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { subscriptionId: 's1', path: 'a.md', event: 'modified', mtime: 99 },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ path: 'a.md', event: 'modified' });
  });

  it('unregisters a notification handler via the returned disposer', () => {
    const { framed, client } = setup();
    const handler = vi.fn();
    const off = client.onNotification('fs.changed', handler);
    off();
    framed.pushMessage({
      jsonrpc: '2.0',
      method: 'fs.changed',
      params: { subscriptionId: 's1', path: 'a.md', event: 'modified' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects pending calls when the stream closes', async () => {
    const { framed, client } = setup();
    const pending = client.call('fs.stat', { path: 'a.md' });
    framed.close();
    await expect(pending).rejects.toBeInstanceOf(RpcError);
  });

  it('fires onClose handlers with no error on a clean close', () => {
    const { framed, client } = setup();
    const cb = vi.fn();
    client.onClose(cb);
    framed.close();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeUndefined();
  });

  it('fires onClose handlers with the error on an abort', () => {
    const { framed, client } = setup();
    const cb = vi.fn();
    client.onClose(cb);
    framed.emit('error', new Error('boom'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0][0] as Error).message).toBe('boom');
  });

  it('rejects call() after close()', async () => {
    const { client } = setup();
    client.close();
    await expect(client.call('server.info', {})).rejects.toBeInstanceOf(RpcError);
  });

  it('ignores malformed server responses without killing the session', async () => {
    const { framed, client } = setup();
    const pending = client.call('server.info', {});
    const req = JSON.parse(framed.sent[0].toString('utf8')) as { id: number };

    // Garbage message first — should be silently dropped.
    framed.emit('message', Buffer.from('not-json-at-all', 'utf8'));
    // Valid response afterwards — promise still resolves.
    framed.pushMessage({ jsonrpc: '2.0', id: req.id, result: { version: '1.0.0', protocolVersion: 1, capabilities: [], vaultRoot: '' } });
    await pending;
  });
});
