import { vi } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Minimal mock of an ssh2 SFTPWrapper.
 * Every method is a vi.fn() so tests can assert call counts and
 * configure per-test return values with mockImplementation / mockResolvedValue.
 */
export function makeMockSftp() {
  return {
    fastGet: vi.fn(),
    fastPut: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    lstat: vi.fn(),
    mkdir: vi.fn(),
    rmdir: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
    realpath: vi.fn(),
    createReadStream: vi.fn(),
    createWriteStream: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
  };
}

export type MockSftp = ReturnType<typeof makeMockSftp>;

/**
 * Minimal mock of an ssh2 Client (EventEmitter shape).
 * `sftp` resolves with a MockSftp by default; override with
 * `client.sftp.mockImplementation(cb => cb(null, customSftp))`.
 */
export function makeMockSshClient(sftpOverride?: MockSftp) {
  const emitter = new EventEmitter();
  const sftp = sftpOverride ?? makeMockSftp();

  const client = Object.assign(emitter, {
    connect: vi.fn(),
    end: vi.fn(),
    sftp: vi.fn((cb: (err: Error | null, s: MockSftp) => void) => cb(null, sftp)),
    exec: vi.fn(),
    shell: vi.fn(),
    forwardOut: vi.fn(),
    openssh_forwardOutStreamLocal: vi.fn(),
    _sftp: sftp,
  });

  return client;
}

export type MockSshClient = ReturnType<typeof makeMockSshClient>;

/**
 * Helper: emit a `keyboard-interactive` event on a client in the
 * standard ssh2 signature and return a Promise that resolves with the
 * responses passed to `finish`.
 */
export function emitKbdInteractive(
  client: EventEmitter,
  prompts: Array<{ prompt: string; echo?: boolean }>,
): Promise<string[]> {
  return new Promise((resolve) => {
    const finish = (responses: string[]) => resolve(responses);
    client.emit(
      'keyboard-interactive',
      'auth-name',
      'instructions',
      '',
      prompts,
      finish,
    );
  });
}
