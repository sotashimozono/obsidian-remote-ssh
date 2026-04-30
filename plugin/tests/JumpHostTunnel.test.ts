import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createJumpTunnel } from '../src/ssh/JumpHostTunnel';
import { AuthResolver } from '../src/ssh/AuthResolver';
import { SecretStore } from '../src/ssh/SecretStore';
import { HostKeyStore } from '../src/ssh/HostKeyStore';
import type { JumpHostConfig } from '../src/types';

/**
 * Minimal fake of ssh2.Client. Exposes the surface
 * `createJumpTunnel` exercises and lets each test pre-program the
 * outcome of the connect handshake and the forwardOut callback.
 */
class FakeClient extends EventEmitter {
  connectConfig: unknown = null;
  forwardOutCalls: Array<{
    srcHost: string; srcPort: number; dstHost: string; dstPort: number;
  }> = [];
  ended = 0;
  destroyed = 0;

  // Programmable outcomes
  connectOutcome: 'ready' | 'error' | 'never' = 'ready';
  connectError: Error = new Error('boom');
  forwardOutcome: 'success' | 'error' | 'never' = 'success';
  forwardError: Error = new Error('forward boom');
  forwardStream: EventEmitter & { destroy?: () => void };

  constructor() {
    super();
    this.forwardStream = new EventEmitter() as FakeClient['forwardStream'];
    this.forwardStream.destroy = () => this.forwardStream.emit('close');
  }

  connect(config: unknown) {
    this.connectConfig = config;
    queueMicrotask(() => {
      if (this.connectOutcome === 'ready')      this.emit('ready');
      else if (this.connectOutcome === 'error') this.emit('error', this.connectError);
      // 'never' just hangs the test — used for timeouts
    });
  }

  forwardOut(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
    cb: (err: Error | undefined, stream: unknown) => void,
  ) {
    this.forwardOutCalls.push({ srcHost, srcPort, dstHost, dstPort });
    queueMicrotask(() => {
      if (this.forwardOutcome === 'success')    cb(undefined, this.forwardStream);
      else if (this.forwardOutcome === 'error') cb(this.forwardError, undefined);
    });
  }

  end()     { this.ended++; }
  destroy() { this.destroyed++; }
}

let fake: FakeClient;
let authResolver: AuthResolver;
let secrets: SecretStore;

const baseJump: JumpHostConfig = {
  host: 'bastion.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'agent',
};

beforeEach(() => {
  fake = new FakeClient();
  secrets = new SecretStore();
  authResolver = new AuthResolver(secrets);
  // Tests assume agent auth so we don't have to write a real key file.
  process.env.SSH_AUTH_SOCK = '/tmp/fake-agent.sock';
});

describe('createJumpTunnel: success path', () => {
  it('connects, forwards, and resolves with the stream', async () => {
    const stream = await createJumpTunnel(
      baseJump,
      'target.example.com', 22,
      authResolver,
      { clientFactory: () => fake },
    );
    expect(stream).toBe(fake.forwardStream);
    expect(fake.forwardOutCalls).toHaveLength(1);
    expect(fake.forwardOutCalls[0]).toMatchObject({
      dstHost: 'target.example.com',
      dstPort: 22,
    });
  });

  it('passes connectTimeoutMs as readyTimeout and keepalive when configured', async () => {
    await createJumpTunnel(
      baseJump,
      'target.example.com', 22,
      authResolver,
      {
        clientFactory:       () => fake,
        connectTimeoutMs:    9_000,
        keepaliveIntervalMs: 5_000,
      },
    );
    const cfg = fake.connectConfig as Record<string, unknown>;
    expect(cfg.readyTimeout).toBe(9_000);
    expect(cfg.keepaliveInterval).toBe(5_000);
  });

  it('uses a default readyTimeout when not configured', async () => {
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    );
    const cfg = fake.connectConfig as Record<string, unknown>;
    expect(cfg.readyTimeout).toBe(15_000);
  });

  it('attaches a hostVerifier when a HostKeyStore is supplied', async () => {
    const store = new HostKeyStore();
    const verifySpy = vi.spyOn(store, 'verify').mockReturnValue(true);
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake, hostKeyStore: store },
    );
    const cfg = fake.connectConfig as { hostVerifier?: (k: Buffer) => boolean };
    expect(typeof cfg.hostVerifier).toBe('function');
    cfg.hostVerifier!(Buffer.from('fake key'));
    expect(verifySpy).toHaveBeenCalledWith('bastion.example.com', 22, expect.any(Buffer));
  });

  it('ends the jump client when the tunnel stream closes', async () => {
    const stream = await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    );
    expect(fake.ended).toBe(0);
    (stream as unknown as EventEmitter).emit('close');
    expect(fake.ended).toBe(1);
  });
});

describe('createJumpTunnel: failure paths', () => {
  it('rejects with a wrapped error when the jump connect errors', async () => {
    fake.connectOutcome = 'error';
    fake.connectError = new Error('auth refused');
    await expect(createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    )).rejects.toThrow(/Jump host "bastion.example.com" connect failed: auth refused/);
    // Failed connect should destroy the client to free the socket.
    expect(fake.destroyed).toBe(1);
  });

  it('rejects with a wrapped error when forwardOut fails', async () => {
    fake.forwardOutcome = 'error';
    fake.forwardError = new Error('admin prohibited');
    await expect(createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    )).rejects.toThrow(/Jump tunnel to target.example.com:22 via "bastion.example.com" failed: admin prohibited/);
    // forwardOut failure should also tear the jump client down.
    expect(fake.ended).toBe(1);
  });
});

describe('createJumpTunnel: auth handling', () => {
  it('errors clearly when password auth has no stored secret', async () => {
    const jump: JumpHostConfig = {
      ...baseJump,
      authMethod: 'password',
      passwordRef: 'p:bastion',
    };
    await expect(createJumpTunnel(
      jump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    )).rejects.toThrow(/No password in memory for jump host "bastion.example.com"/);
  });

  it('supplies a stored password to ssh2.connect', async () => {
    authResolver.storeSecret('p:bastion', 's3cret');
    const jump: JumpHostConfig = {
      ...baseJump,
      authMethod: 'password',
      passwordRef: 'p:bastion',
    };
    await createJumpTunnel(
      jump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    );
    expect((fake.connectConfig as Record<string, unknown>).password).toBe('s3cret');
  });

  it('errors clearly when privateKey auth has no path set', async () => {
    const jump: JumpHostConfig = {
      ...baseJump,
      authMethod: 'privateKey',
    };
    await expect(createJumpTunnel(
      jump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake },
    )).rejects.toThrow(/No private key path for jump host "bastion.example.com"/);
  });

  it('reads and forwards the private key when a path is set', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jump-key-'));
    const keyPath = path.join(tmp, 'id_test');
    fs.writeFileSync(keyPath, 'FAKE-KEY-CONTENTS', 'utf8');
    try {
      const jump: JumpHostConfig = {
        ...baseJump,
        authMethod: 'privateKey',
        privateKeyPath: keyPath,
      };
      await createJumpTunnel(
        jump, 'target.example.com', 22, authResolver,
        { clientFactory: () => fake },
      );
      const cfg = fake.connectConfig as { privateKey: Buffer };
      expect(cfg.privateKey.toString('utf8')).toBe('FAKE-KEY-CONTENTS');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('errors when SSH_AUTH_SOCK is missing for agent auth', async () => {
    const original = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      await expect(createJumpTunnel(
        baseJump, 'target.example.com', 22, authResolver,
        { clientFactory: () => fake },
      )).rejects.toThrow(/SSH_AUTH_SOCK not set/);
    } finally {
      if (original !== undefined) process.env.SSH_AUTH_SOCK = original;
    }
  });
});

describe('createJumpTunnel: host-key mismatch handler (#132 follow-up)', () => {
  it('uses the async hostVerifier shape when a mismatch handler is wired', async () => {
    const store = new HostKeyStore();
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      {
        clientFactory: () => fake,
        hostKeyStore: store,
        hostKeyMismatchHandler: vi.fn(async () => 'trust' as const),
      },
    );
    const cfg = fake.connectConfig as {
      hostVerifier?: (k: Buffer, verify: (v: boolean) => void) => void;
    };
    // The async overload takes 2 args (key + verify callback); the
    // sync overload takes 1. Length distinguishes them.
    expect(typeof cfg.hostVerifier).toBe('function');
    expect(cfg.hostVerifier!.length).toBe(2);
  });

  it('falls back to the sync hostVerifier when no mismatch handler is wired', async () => {
    const store = new HostKeyStore();
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      { clientFactory: () => fake, hostKeyStore: store },
    );
    const cfg = fake.connectConfig as {
      hostVerifier?: (k: Buffer | string) => boolean;
    };
    expect(typeof cfg.hostVerifier).toBe('function');
    expect(cfg.hostVerifier!.length).toBe(1);
  });

  it('async hostVerifier proceeds (verify(true)) on a matching pinned key', async () => {
    const store = new HostKeyStore();
    const key = Buffer.from('pinned-key-bytes');
    // Pin via the sync path so the next verifyAsync sees a match.
    store.verify('bastion.example.com', 22, key);

    const handler = vi.fn(async () => 'abort' as const);
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      {
        clientFactory: () => fake,
        hostKeyStore: store,
        hostKeyMismatchHandler: handler,
      },
    );
    const cfg = fake.connectConfig as {
      hostVerifier: (k: Buffer, verify: (v: boolean) => void) => void;
    };
    const verifyCb = vi.fn();
    cfg.hostVerifier(key, verifyCb);
    // Allow the verifyAsync microtask chain to settle.
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(handler).not.toHaveBeenCalled();
    expect(verifyCb).toHaveBeenCalledWith(true);
  });

  it('async hostVerifier consults the handler on a fingerprint mismatch and forwards the trust decision', async () => {
    const store = new HostKeyStore();
    const oldKey = Buffer.from('old');
    store.verify('bastion.example.com', 22, oldKey);

    const handler = vi.fn(async () => 'trust' as const);
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      {
        clientFactory: () => fake,
        hostKeyStore: store,
        hostKeyMismatchHandler: handler,
      },
    );
    const cfg = fake.connectConfig as {
      hostVerifier: (k: Buffer, verify: (v: boolean) => void) => void;
    };
    const verifyCb = vi.fn();
    cfg.hostVerifier(Buffer.from('new'), verifyCb);
    // Wait for the async chain inside verifyAsync to settle.
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      host: 'bastion.example.com',
      port: 22,
    }));
    expect(verifyCb).toHaveBeenCalledWith(true);
  });

  it('async hostVerifier forwards an abort decision as verify(false)', async () => {
    const store = new HostKeyStore();
    store.verify('bastion.example.com', 22, Buffer.from('old'));

    const handler = vi.fn(async () => 'abort' as const);
    await createJumpTunnel(
      baseJump, 'target.example.com', 22, authResolver,
      {
        clientFactory: () => fake,
        hostKeyStore: store,
        hostKeyMismatchHandler: handler,
      },
    );
    const cfg = fake.connectConfig as {
      hostVerifier: (k: Buffer, verify: (v: boolean) => void) => void;
    };
    const verifyCb = vi.fn();
    cfg.hostVerifier(Buffer.from('new'), verifyCb);
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(verifyCb).toHaveBeenCalledWith(false);
  });
});
