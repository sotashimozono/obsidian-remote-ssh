import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SFTPWrapper, Stats } from 'ssh2';
import { SftpClient } from '../src/ssh/SftpClient';
import type { AuthResolver } from '../src/ssh/AuthResolver';
import type { HostKeyStore } from '../src/ssh/HostKeyStore';

// ─── fake helpers ────────────────────────────────────────────────────────────

/** Minimal fake ssh2 Stats that satisfies SftpClient's toRemoteStat() helper. */
function fakeStats(opts: {
  dir?: boolean;
  symlink?: boolean;
  mtime?: number;
  size?: number;
  mode?: number;
} = {}): Stats {
  return {
    isDirectory:    () => opts.dir     ?? false,
    isFile:         () => !(opts.dir ?? false) && !(opts.symlink ?? false),
    isSymbolicLink: () => opts.symlink ?? false,
    mtime:           opts.mtime ?? 1000,
    size:            opts.size  ?? 100,
    mode:            opts.mode  ?? 0o644,
  } as unknown as Stats;
}

/** Create a vi.fn()-backed fake SFTPWrapper. */
function makeSftp() {
  return {
    stat:      vi.fn(),
    readdir:   vi.fn(),
    readFile:  vi.fn(),
    writeFile: vi.fn(),
    rename:    vi.fn(),
    unlink:    vi.fn(),
    mkdir:     vi.fn(),
    rmdir:     vi.fn(),
    fastPut:   vi.fn(),
    // posix-rename extension fields — absent by default
    _extensions:        undefined as Record<string, unknown> | undefined,
    ext_openssh_rename: undefined as ((...a: unknown[]) => void) | undefined,
  } as unknown as SFTPWrapper & {
    stat:               ReturnType<typeof vi.fn>;
    readdir:            ReturnType<typeof vi.fn>;
    readFile:           ReturnType<typeof vi.fn>;
    writeFile:          ReturnType<typeof vi.fn>;
    rename:             ReturnType<typeof vi.fn>;
    unlink:             ReturnType<typeof vi.fn>;
    mkdir:              ReturnType<typeof vi.fn>;
    rmdir:              ReturnType<typeof vi.fn>;
    fastPut:            ReturnType<typeof vi.fn>;
    _extensions:        Record<string, unknown> | undefined;
    ext_openssh_rename: ((...a: unknown[]) => void) | undefined;
  };
}

/** Minimal fake ssh2 Client for testing exec / openUnixStream etc. */
function makeFakeClient(opts: {
  execResult?: { stdout: string; stderr: string; exitCode: number };
  execErr?:   Error;
  streamErr?: Error;
} = {}) {
  const endSpy = vi.fn();

  const client = {
    exec: vi.fn((
      _cmd: string,
      cb: (err: Error | null, stream: any) => void,
    ) => {
      if (opts.execErr) { cb(opts.execErr, null!); return; }

      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const stderrListeners: Record<string, Array<(...a: unknown[]) => void>> = {};

      const stream = {
        on(event: string, fn: (...a: unknown[]) => void) {
          (listeners[event] ??= []).push(fn);
          return stream;
        },
        stderr: {
          on(event: string, fn: (...a: unknown[]) => void) {
            (stderrListeners[event] ??= []).push(fn);
            return this;
          },
        },
      };

      cb(null, stream);

      // Fire events after all .on() registrations have completed.
      Promise.resolve().then(() => {
        if (opts.streamErr) {
          for (const fn of listeners['error'] ?? []) fn(opts.streamErr);
          return;
        }
        const { stdout = '', stderr = '', exitCode = 0 } = opts.execResult ?? {};
        if (stdout) for (const fn of listeners['data']         ?? []) fn(Buffer.from(stdout));
        if (stderr) for (const fn of stderrListeners['data']  ?? []) fn(Buffer.from(stderr));
        for (const fn of listeners['exit']  ?? []) fn(exitCode);
        for (const fn of listeners['close'] ?? []) fn();
      });
    }),
    openssh_forwardOutStreamLocal: vi.fn(),
    shell: vi.fn(),
    end: endSpy,
  };

  return { client, endSpy };
}

/** Build a fresh SftpClient with no-op auth/hostKey stubs. */
function makeSut() {
  const authResolver = {} as unknown as AuthResolver;
  const hostKeyStore = {} as unknown as HostKeyStore;
  return new SftpClient(authResolver, hostKeyStore);
}

/** Inject fake sftp + client so tests can exercise post-connect methods. */
function wire(
  sut: SftpClient,
  sftp: unknown,
  client: unknown = { end: vi.fn() },
) {
  (sut as any).sftp   = sftp;
  (sut as any).client = client;
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

describe('SftpClient — lifecycle (no connection needed)', () => {
  it('isAlive() returns false on a fresh instance', () => {
    expect(makeSut().isAlive()).toBe(false);
  });

  it('isAlive() returns true after client and sftp are wired', () => {
    const sut = makeSut();
    wire(sut, makeSftp());
    expect(sut.isAlive()).toBe(true);
  });

  it('getProfile() returns null on a fresh instance', () => {
    expect(makeSut().getProfile()).toBeNull();
  });

  it('getProfile() returns the injected profile object', () => {
    const sut     = makeSut();
    const profile = { host: 'srv' } as any;
    (sut as any).profile = profile;
    expect(sut.getProfile()).toBe(profile);
  });

  it('disconnect() on a fresh instance resolves without throwing', async () => {
    await expect(makeSut().disconnect()).resolves.toBeUndefined();
  });

  it('disconnect() calls client.end() when a client is wired', async () => {
    const sut = makeSut();
    const { client, endSpy } = makeFakeClient();
    wire(sut, makeSftp(), client);
    await sut.disconnect();
    expect(endSpy).toHaveBeenCalledOnce();
  });

  it('disconnect() does not trigger onClose listeners (intentional disconnect)', async () => {
    const sut      = makeSut();
    const closeSpy = vi.fn();
    sut.onClose(closeSpy);
    wire(sut, makeSftp());
    await sut.disconnect();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('disconnect() survives client.end() throwing', async () => {
    const sut       = makeSut();
    const badClient = { end: () => { throw new Error('socket closed'); } };
    wire(sut, makeSftp(), badClient);
    await expect(sut.disconnect()).resolves.toBeUndefined();
  });
});

// ─── onClose ─────────────────────────────────────────────────────────────────

describe('SftpClient — onClose listener management', () => {
  it('registers a listener and returns a disposer', () => {
    const sut = makeSut();
    const spy = vi.fn();
    const off = sut.onClose(spy);
    expect(typeof off).toBe('function');
    expect((sut as any).closeListeners).toContain(spy);
  });

  it('disposer removes only the targeted listener', () => {
    const sut  = makeSut();
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    const off1 = sut.onClose(spy1);
    sut.onClose(spy2);
    off1();
    expect((sut as any).closeListeners).not.toContain(spy1);
    expect((sut as any).closeListeners).toContain(spy2);
  });
});

// ─── requireSftp / requireClient guards ──────────────────────────────────────

describe('SftpClient — not-connected guards', () => {
  it('stat() throws "not connected" when sftp is null', async () => {
    await expect(makeSut().stat('any')).rejects.toThrow('not connected');
  });

  it('exec() throws "not connected" when client is null', async () => {
    const sut = makeSut();
    (sut as any).sftp = makeSftp(); // sftp present but client absent
    await expect(sut.exec('ls')).rejects.toThrow('not connected');
  });

  it('openUnixStream() throws "not connected" when client is null', async () => {
    await expect(makeSut().openUnixStream('/run/x.sock')).rejects.toThrow('not connected');
  });
});

// ─── stat ────────────────────────────────────────────────────────────────────

describe('SftpClient.stat()', () => {
  it('resolves with a correct RemoteStat on success (mtime is multiplied by 1000)', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: null, s: Stats) => void) =>
      cb(null, fakeStats({ dir: false, mtime: 2000, size: 42, mode: 0o600 })),
    );
    wire(sut, sftp);

    const result = await sut.stat('remote/file.md');
    expect(result).toEqual({
      isFile:         true,
      isDirectory:    false,
      isSymbolicLink: false,
      mtime:          2_000_000,
      size:           42,
      mode:           0o600,
    });
  });

  it('rejects when sftp.stat calls back with an error', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    wire(sut, sftp);
    await expect(sut.stat('missing')).rejects.toThrow('ENOENT');
  });
});

// ─── exists ──────────────────────────────────────────────────────────────────

describe('SftpClient.exists()', () => {
  it('returns true when stat succeeds', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: null, s: Stats) => void) =>
      cb(null, fakeStats()),
    );
    wire(sut, sftp);
    expect(await sut.exists('file')).toBe(true);
  });

  it('returns false when stat throws', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    wire(sut, sftp);
    expect(await sut.exists('missing')).toBe(false);
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe('SftpClient.list()', () => {
  it('returns mapped entries, skipping . and ..', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readdir.mockImplementation((_p: string, cb: (e: null, list: any[]) => void) =>
      cb(null, [
        { filename: '.',       attrs: fakeStats({ dir: true }) },
        { filename: '..',      attrs: fakeStats({ dir: true }) },
        { filename: 'notes',   attrs: fakeStats({ dir: true, mtime: 5000, size: 0 }) },
        { filename: 'file.md', attrs: fakeStats({ mtime: 3000, size: 88 }) },
      ]),
    );
    wire(sut, sftp);

    const list = await sut.list('/vault');
    expect(list.map(e => e.name)).toEqual(['notes', 'file.md']);
    expect(list[0].isDirectory).toBe(true);
    expect(list[1].isFile).toBe(true);
    expect(list[1].mtime).toBe(3_000_000);
  });

  it('rejects when readdir calls back with an error', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readdir.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('EACCES')),
    );
    wire(sut, sftp);
    await expect(sut.list('/protected')).rejects.toThrow('EACCES');
  });
});

// ─── readBinary / readText ───────────────────────────────────────────────────

describe('SftpClient.readBinary() / readText()', () => {
  it('readBinary resolves with the buffer', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    const data = Buffer.from('hello');
    sftp.readFile.mockImplementation((_p: string, cb: (e: null, b: Buffer) => void) =>
      cb(null, data),
    );
    wire(sut, sftp);
    expect(await sut.readBinary('note.md')).toBe(data);
  });

  it('readBinary rejects on error', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readFile.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('SFTP: permission denied')),
    );
    wire(sut, sftp);
    await expect(sut.readBinary('secret')).rejects.toThrow('SFTP: permission denied');
  });

  it('readText decodes the buffer with the given encoding', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readFile.mockImplementation((_p: string, cb: (e: null, b: Buffer) => void) =>
      cb(null, Buffer.from('café', 'utf8')),
    );
    wire(sut, sftp);
    expect(await sut.readText('note.md', 'utf8')).toBe('café');
  });
});

// ─── writeBinary (atomicWrite) ────────────────────────────────────────────────

describe('SftpClient.writeBinary() — atomic write', () => {
  it('success: calls writeFile on tmp path then rename to final path', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.writeFile.mockImplementation((_p: string, _d: Buffer, cb: (e: null) => void) =>
      cb(null),
    );
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: null) => void) =>
      cb(null),
    );
    wire(sut, sftp);

    const data = Buffer.from('content');
    await sut.writeBinary('vault/note.md', data);

    expect(sftp.writeFile).toHaveBeenCalledWith(
      'vault/note.md.rsh_tmp', data, expect.any(Function),
    );
    expect(sftp.rename).toHaveBeenCalledWith(
      'vault/note.md.rsh_tmp', 'vault/note.md', expect.any(Function),
    );
  });

  it('writeFile failure: attempts cleanup and rethrows', async () => {
    const sut      = makeSut();
    const sftp     = makeSftp();
    const writeErr = new Error('ENOSPC');
    sftp.writeFile.mockImplementation((_p: string, _d: Buffer, cb: (e: Error) => void) =>
      cb(writeErr),
    );
    sftp.unlink.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await expect(sut.writeBinary('note.md', Buffer.from('x'))).rejects.toThrow('ENOSPC');
    expect(sftp.unlink).toHaveBeenCalledWith('note.md.rsh_tmp', expect.any(Function));
  });

  it('rename failure: cleanup is attempted and original error rethrows', async () => {
    const sut       = makeSut();
    const sftp      = makeSftp();
    const renameErr = new Error('EXDEV');
    sftp.writeFile.mockImplementation((_p: string, _d: Buffer, cb: (e: null) => void) =>
      cb(null),
    );
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: Error) => void) =>
      cb(renameErr),
    );
    sftp.unlink.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await expect(sut.writeBinary('note.md', Buffer.from('x'))).rejects.toThrow('EXDEV');
    expect(sftp.unlink).toHaveBeenCalled();
  });

  it('writeText encodes string and delegates to atomicWrite', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.writeFile.mockImplementation((_p: string, _d: Buffer, cb: (e: null) => void) =>
      cb(null),
    );
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: null) => void) =>
      cb(null),
    );
    wire(sut, sftp);

    await sut.writeText('note.md', 'hello', 'utf8');
    const [, writtenBuf] = (sftp.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Buffer];
    expect(writtenBuf.toString('utf8')).toBe('hello');
  });
});

// ─── rename ──────────────────────────────────────────────────────────────────

describe('SftpClient.rename()', () => {
  it('uses standard sftp.rename when posix-rename extension is absent', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: null) => void) =>
      cb(null),
    );
    wire(sut, sftp);

    await sut.rename('old.md', 'new.md');
    expect(sftp.rename).toHaveBeenCalledWith('old.md', 'new.md', expect.any(Function));
  });

  it('uses ext_openssh_rename when posix-rename extension is present', async () => {
    const sut    = makeSut();
    const sftp   = makeSftp();
    const extRen = vi.fn((_s: string, _d: string, cb: (e: null) => void) => cb(null));
    (sftp as any)._extensions        = { 'posix-rename@openssh.com': '1' };
    (sftp as any).ext_openssh_rename = extRen;
    wire(sut, sftp);

    await sut.rename('old.md', 'new.md');
    expect(extRen).toHaveBeenCalledWith('old.md', 'new.md', expect.any(Function));
    expect(sftp.rename).not.toHaveBeenCalled();
  });

  it('rejects when rename fails', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: Error) => void) =>
      cb(new Error('EPERM')),
    );
    wire(sut, sftp);
    await expect(sut.rename('a', 'b')).rejects.toThrow('EPERM');
  });
});

// ─── remove ──────────────────────────────────────────────────────────────────

describe('SftpClient.remove()', () => {
  it('calls sftp.unlink and resolves on success', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.unlink.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await expect(sut.remove('note.md')).resolves.toBeUndefined();
    expect(sftp.unlink).toHaveBeenCalledWith('note.md', expect.any(Function));
  });

  it('rejects on unlink error', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.unlink.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    wire(sut, sftp);
    await expect(sut.remove('gone')).rejects.toThrow('ENOENT');
  });
});

// ─── mkdir ───────────────────────────────────────────────────────────────────

describe('SftpClient.mkdir()', () => {
  it('skips mkdir call when the directory already exists', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: null, s: Stats) => void) =>
      cb(null, fakeStats({ dir: true })),
    );
    wire(sut, sftp);

    await sut.mkdir('/vault/notes');
    expect(sftp.mkdir).not.toHaveBeenCalled();
  });

  it('throws when the path exists but is a file', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: null, s: Stats) => void) =>
      cb(null, fakeStats({ dir: false })),
    );
    wire(sut, sftp);

    await expect(sut.mkdir('/vault/conflict')).rejects.toThrow('exists and is not a directory');
  });

  it('calls sftp.mkdir when stat throws (path absent)', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    sftp.mkdir.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await sut.mkdir('/vault/new');
    expect(sftp.mkdir).toHaveBeenCalledWith('/vault/new', expect.any(Function));
  });

  it('swallows "already exist" error from sftp.mkdir (idempotent)', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    sftp.mkdir.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('already exists')),
    );
    wire(sut, sftp);

    await expect(sut.mkdir('/vault/already')).resolves.toBeUndefined();
  });
});

// ─── mkdirp ──────────────────────────────────────────────────────────────────

describe('SftpClient.mkdirp()', () => {
  it('creates each segment of an absolute path', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    sftp.mkdir.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await sut.mkdirp('/a/b/c');

    const created = (sftp.mkdir as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(created).toEqual(['/a', '/a/b', '/a/b/c']);
  });

  it('creates each segment of a relative path', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.stat.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('ENOENT')),
    );
    sftp.mkdir.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await sut.mkdirp('a/b');

    const created = (sftp.mkdir as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(created).toEqual(['a', 'a/b']);
  });
});

// ─── copy ────────────────────────────────────────────────────────────────────

describe('SftpClient.copy()', () => {
  it('reads source then writes to destination', async () => {
    const sut    = makeSut();
    const sftp   = makeSftp();
    const srcBuf = Buffer.from('source data');
    sftp.readFile.mockImplementation((_p: string, cb: (e: null, b: Buffer) => void) =>
      cb(null, srcBuf),
    );
    sftp.writeFile.mockImplementation((_p: string, _d: Buffer, cb: (e: null) => void) =>
      cb(null),
    );
    sftp.rename.mockImplementation((_s: string, _d: string, cb: (e: null) => void) =>
      cb(null),
    );
    wire(sut, sftp);

    await sut.copy('src.md', 'dst.md');
    const [, writtenBuf] = (sftp.writeFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Buffer];
    expect(writtenBuf).toEqual(srcBuf);
  });
});

// ─── listRecursive ───────────────────────────────────────────────────────────

describe('SftpClient.listRecursive()', () => {
  it('returns files from nested subdirectories via BFS', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();

    sftp.readdir
      .mockImplementationOnce((_p: string, cb: (e: null, l: any[]) => void) =>
        cb(null, [
          { filename: 'sub',     attrs: fakeStats({ dir: true }) },
          { filename: 'root.md', attrs: fakeStats({ mtime: 1000 }) },
        ]),
      )
      .mockImplementationOnce((_p: string, cb: (e: null, l: any[]) => void) =>
        cb(null, [{ filename: 'deep.md', attrs: fakeStats({ mtime: 2000 }) }]),
      );
    wire(sut, sftp);

    const entries = await sut.listRecursive('/vault');
    expect(entries.map(e => e.relativePath).sort()).toEqual(['deep.md', 'root.md', 'sub']);
  });

  it('filter predicate excludes non-matching entries', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readdir.mockImplementation((_p: string, cb: (e: null, l: any[]) => void) =>
      cb(null, [
        { filename: 'keep.md',    attrs: fakeStats() },
        { filename: 'ignore.txt', attrs: fakeStats() },
      ]),
    );
    wire(sut, sftp);

    const entries = await sut.listRecursive('/vault', rel => rel.endsWith('.md'));
    expect(entries.map(e => e.name)).toEqual(['keep.md']);
  });

  it('logs a warning and continues when a subdirectory readdir fails', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readdir
      .mockImplementationOnce((_p: string, cb: (e: null, l: any[]) => void) =>
        cb(null, [{ filename: 'bad', attrs: fakeStats({ dir: true }) }]),
      )
      .mockImplementationOnce((_p: string, cb: (e: Error) => void) =>
        cb(new Error('EACCES')),
      );
    wire(sut, sftp);

    const entries = await sut.listRecursive('/vault');
    expect(entries.map(e => e.name)).toEqual(['bad']);
  });
});

// ─── rmdir ───────────────────────────────────────────────────────────────────

describe('SftpClient.rmdir()', () => {
  it('non-recursive: calls sftp.rmdir directly', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.rmdir.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await sut.rmdir('/vault/dir');
    expect(sftp.rmdir).toHaveBeenCalledWith('/vault/dir', expect.any(Function));
  });

  it('recursive: removes all files and subdirs before root', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();

    sftp.readdir.mockImplementation((_p: string, cb: (e: null, l: any[]) => void) =>
      cb(null, [
        { filename: 'file.md', attrs: fakeStats({ mtime: 1000 }) },
        { filename: 'sub',     attrs: fakeStats({ dir: true }) },
      ]),
    );
    sftp.unlink.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    sftp.rmdir.mockImplementation((_p: string, cb: (e: null) => void) => cb(null));
    wire(sut, sftp);

    await sut.rmdir('/vault', true);

    expect(sftp.unlink).toHaveBeenCalledWith('/vault/file.md', expect.any(Function));
    const rmdirCalls = (sftp.rmdir as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(rmdirCalls).toContain('/vault/sub');
    expect(rmdirCalls[rmdirCalls.length - 1]).toBe('/vault');
  });
});

// ─── exec ────────────────────────────────────────────────────────────────────

describe('SftpClient.exec()', () => {
  it('collects stdout, stderr, and exitCode from the stream', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({
      execResult: { stdout: 'out\n', stderr: 'err\n', exitCode: 0 },
    });
    wire(sut, makeSftp(), client);

    const result = await sut.exec('echo hi');
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
    expect(result.exitCode).toBe(0);
  });

  it('rejects when exec calls back with an error', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ execErr: new Error('Channel open failure') });
    wire(sut, makeSftp(), client);
    await expect(sut.exec('ls')).rejects.toThrow('Channel open failure');
  });

  it('rejects when the stream emits an error event', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ streamErr: new Error('stream reset') });
    wire(sut, makeSftp(), client);
    await expect(sut.exec('ls')).rejects.toThrow('stream reset');
  });
});

// ─── getRemoteHome ───────────────────────────────────────────────────────────

describe('SftpClient.getRemoteHome()', () => {
  it('returns trimmed stdout of "echo $HOME"', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ execResult: { stdout: '/home/alice\n', stderr: '', exitCode: 0 } });
    wire(sut, makeSftp(), client);
    expect(await sut.getRemoteHome()).toBe('/home/alice');
  });

  it('caches the result so exec is only called once', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ execResult: { stdout: '/home/alice\n', stderr: '', exitCode: 0 } });
    wire(sut, makeSftp(), client);

    await sut.getRemoteHome();
    await sut.getRemoteHome();
    expect(client.exec).toHaveBeenCalledOnce();
  });

  it('throws when exit code is non-zero', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ execResult: { stdout: '', stderr: 'no home', exitCode: 1 } });
    wire(sut, makeSftp(), client);
    await expect(sut.getRemoteHome()).rejects.toThrow('exited 1');
  });

  it('throws when $HOME is empty', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient({ execResult: { stdout: '   \n', stderr: '', exitCode: 0 } });
    wire(sut, makeSftp(), client);
    await expect(sut.getRemoteHome()).rejects.toThrow('$HOME is empty');
  });
});

// ─── openUnixStream ──────────────────────────────────────────────────────────

describe('SftpClient.openUnixStream()', () => {
  it('resolves with the stream returned by openssh_forwardOutStreamLocal', async () => {
    const sut    = makeSut();
    const stream = { pipe: vi.fn() } as any;
    const { client } = makeFakeClient();
    client.openssh_forwardOutStreamLocal.mockImplementation(
      (_path: string, cb: (e: null, s: any) => void) => cb(null, stream),
    );
    wire(sut, makeSftp(), client);
    expect(await sut.openUnixStream('/run/x.sock')).toBe(stream);
  });

  it('rejects when openssh_forwardOutStreamLocal calls back with an error', async () => {
    const sut = makeSut();
    const { client } = makeFakeClient();
    client.openssh_forwardOutStreamLocal.mockImplementation(
      (_path: string, cb: (e: Error) => void) => cb(new Error('administratively prohibited')),
    );
    wire(sut, makeSftp(), client);
    await expect(sut.openUnixStream('/run/x.sock')).rejects.toThrow('administratively prohibited');
  });
});

// ─── readRemoteFile ──────────────────────────────────────────────────────────

describe('SftpClient.readRemoteFile()', () => {
  it('resolves with the buffer on success', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    const buf  = Buffer.from('token-data');
    sftp.readFile.mockImplementation((_p: string, cb: (e: null, b: Buffer) => void) =>
      cb(null, buf),
    );
    wire(sut, sftp);
    expect(await sut.readRemoteFile('/remote/token')).toBe(buf);
  });

  it('rejects on error', async () => {
    const sut  = makeSut();
    const sftp = makeSftp();
    sftp.readFile.mockImplementation((_p: string, cb: (e: Error) => void) =>
      cb(new Error('SFTP: no such file')),
    );
    wire(sut, sftp);
    await expect(sut.readRemoteFile('/missing')).rejects.toThrow('SFTP: no such file');
  });
});
