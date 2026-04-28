import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { perfTracer, type SpanRecord } from '../src/util/PerfTracer';
import { VaultModelBuilder, type RemoteEntry, type ObsidianClassDeps } from '../src/vault/VaultModelBuilder';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { ReadCache } from '../src/cache/ReadCache';
import { DirCache } from '../src/cache/DirCache';
import { RpcRemoteFsClient } from '../src/adapter/RpcRemoteFsClient';
import type { RemoteStat } from '../src/types';

/**
 * Pins the M2 instrumentation contract: when `perfTracer.enabled` is
 * true, every instrumented site emits a span / point with the right
 * name and op attribute. When disabled (the default, exercised by all
 * other test files), the same calls are zero-allocation no-ops — that
 * second half of the contract is held by the unchanged green run of
 * the existing 429 unit tests, not retested here.
 */

// ── shared helpers ────────────────────────────────────────────────────

function captureSpans(): { records: SpanRecord[]; off: () => void } {
  const records: SpanRecord[] = [];
  const off = perfTracer.onSpan((s) => records.push(s));
  return { records, off };
}

beforeEach(() => {
  perfTracer.clear();
  perfTracer.setEnabled(true);
});

afterEach(() => {
  perfTracer.setEnabled(false);
  perfTracer.clear();
});

// ── VaultModelBuilder T5a points ──────────────────────────────────────

class FakeTFile {
  vault!: unknown;
  path!: string;
  name!: string;
  basename!: string;
  extension!: string;
  parent!: FakeTFolder;
  stat!: { ctime: number; mtime: number; size: number };
  constructor(vault: unknown, path: string) { this.vault = vault; this.path = path; }
}
class FakeTFolder {
  vault!: unknown;
  path: string = '';
  name: string = '';
  parent: FakeTFolder | null = null;
  children: Array<FakeTFile | FakeTFolder> = [];
  constructor(vault?: unknown, path?: string) {
    if (vault !== undefined) this.vault = vault;
    if (path !== undefined) this.path = path;
  }
}
const deps: ObsidianClassDeps = {
  TFile:   FakeTFile as unknown as ObsidianClassDeps['TFile'],
  TFolder: FakeTFolder as unknown as ObsidianClassDeps['TFolder'],
};

function makeFakeVault() {
  const root = new FakeTFolder();
  const fileMap: Record<string, FakeTFile | FakeTFolder> = {};
  const triggers: Array<{ event: string; args: unknown[] }> = [];
  const vault = {
    fileMap, triggers,
    getRoot: () => root,
    getAbstractFileByPath: (p: string) => fileMap[p] ?? null,
    trigger: (event: string, ...args: unknown[]) => { triggers.push({ event, args }); },
  };
  return { vault, root, fileMap, triggers };
}

describe('M2: VaultModelBuilder emits T5a points alongside vault.trigger', () => {
  it('insertOne(file) emits T5a {op:"create"} immediately before trigger', () => {
    const { vault, triggers } = makeFakeVault();
    const cap = captureSpans();
    const b = new VaultModelBuilder(vault as never, deps);

    const entry: RemoteEntry = { path: 'Note.md', isDirectory: false, ctime: 1, mtime: 2, size: 3 };
    b.insertOne(entry);
    cap.off();

    const t5a = cap.records.filter(r => r.name === 'T5a');
    expect(t5a).toHaveLength(1);
    expect(t5a[0].attrs).toEqual({ op: 'create', path: 'Note.md' });
    // The point must precede the vault.trigger so PerfAggregator never sees
    // a T5a after the consumer has already reacted.
    expect(triggers).toHaveLength(1);
    expect(triggers[0].event).toBe('create');
  });

  it('removeOne emits T5a {op:"delete"}', () => {
    const { vault, fileMap } = makeFakeVault();
    fileMap['Note.md'] = new FakeTFile(vault, 'Note.md');
    const cap = captureSpans();

    new VaultModelBuilder(vault as never, deps).removeOne('Note.md');
    cap.off();

    const t5a = cap.records.filter(r => r.name === 'T5a');
    expect(t5a).toHaveLength(1);
    expect(t5a[0].attrs).toEqual({ op: 'delete', path: 'Note.md' });
  });

  it('modifyOne emits T5a {op:"modify"}', () => {
    const { vault, fileMap } = makeFakeVault();
    const file = new FakeTFile(vault, 'Note.md');
    file.stat = { ctime: 0, mtime: 0, size: 0 };
    fileMap['Note.md'] = file;
    const cap = captureSpans();

    new VaultModelBuilder(vault as never, deps).modifyOne('Note.md', { ctime: 1, mtime: 2, size: 3 });
    cap.off();

    const t5a = cap.records.filter(r => r.name === 'T5a');
    expect(t5a).toHaveLength(1);
    expect(t5a[0].attrs).toEqual({ op: 'modify', path: 'Note.md' });
  });

  it('renameOne emits T5a {op:"rename", path, newPath}', () => {
    const { vault, root, fileMap } = makeFakeVault();
    const file = new FakeTFile(vault, 'old.md');
    file.parent = root;
    root.children.push(file);
    fileMap['old.md'] = file;
    const cap = captureSpans();

    new VaultModelBuilder(vault as never, deps).renameOne('old.md', 'new.md');
    cap.off();

    const t5a = cap.records.filter(r => r.name === 'T5a');
    expect(t5a).toHaveLength(1);
    expect(t5a[0].attrs).toEqual({ op: 'rename', path: 'old.md', newPath: 'new.md' });
  });
});

// ── SftpDataAdapter S.adp spans ───────────────────────────────────────

function makeMinimalRemoteFsClient() {
  const writes: Array<{ path: string; bytes: number }> = [];
  return {
    writes,
    isAlive: () => true,
    onClose: () => () => { /* noop */ },
    stat: vi.fn(async (_p: string): Promise<RemoteStat> => ({
      isDirectory: false, isFile: true, isSymbolicLink: false,
      mtime: 100, size: 0, mode: 0o100644,
    })),
    exists: vi.fn(async () => true),
    list:   vi.fn(async () => []),
    readBinary:  vi.fn(async () => Buffer.alloc(0)),
    writeBinary: vi.fn(async (p: string, d: Buffer) => { writes.push({ path: p, bytes: d.length }); }),
    mkdirp: vi.fn(async () => { /* noop */ }),
    remove: vi.fn(async () => { /* noop */ }),
    rmdir:  vi.fn(async () => { /* noop */ }),
    rename: vi.fn(async () => { /* noop */ }),
    copy:   vi.fn(async () => { /* noop */ }),
  };
}

function makeAdapter() {
  const client = makeMinimalRemoteFsClient();
  const adapter = new SftpDataAdapter(
    client as never,
    '/remote',
    new ReadCache(64 * 1024 * 1024),
    new DirCache(),
    'test-vault',
  );
  return { adapter, client };
}

describe('M2: SftpDataAdapter emits S.adp spans on write-side methods', () => {
  it('write() emits S.adp {op:"write"} with byte count', async () => {
    const cap = captureSpans();
    const { adapter } = makeAdapter();
    await adapter.write('foo.md', 'hello');
    cap.off();

    const sAdp = cap.records.filter(r => r.name === 'S.adp');
    expect(sAdp).toHaveLength(1);
    expect(sAdp[0].attrs).toMatchObject({ op: 'write', path: 'foo.md', bytes: 5 });
    expect(sAdp[0].durMs).toBeGreaterThanOrEqual(0);
  });

  it('writeBinary() emits S.adp {op:"writeBinary"} with byteLength', async () => {
    const cap = captureSpans();
    const { adapter } = makeAdapter();
    const data = new ArrayBuffer(128);
    await adapter.writeBinary('blob.bin', data);
    cap.off();

    const sAdp = cap.records.filter(r => r.name === 'S.adp');
    expect(sAdp).toHaveLength(1);
    expect(sAdp[0].attrs).toMatchObject({ op: 'writeBinary', path: 'blob.bin', bytes: 128 });
  });

  it('remove() emits S.adp {op:"remove"} even on the success path', async () => {
    const cap = captureSpans();
    const { adapter } = makeAdapter();
    await adapter.remove('doomed.md');
    cap.off();

    const sAdp = cap.records.filter(r => r.name === 'S.adp');
    expect(sAdp).toHaveLength(1);
    expect(sAdp[0].attrs).toMatchObject({ op: 'remove', path: 'doomed.md' });
  });

  it('rename() emits S.adp {op:"rename"} with new path attr', async () => {
    const cap = captureSpans();
    const { adapter } = makeAdapter();
    await adapter.rename('old.md', 'new.md');
    cap.off();

    const sAdp = cap.records.filter(r => r.name === 'S.adp');
    expect(sAdp).toHaveLength(1);
    expect(sAdp[0].attrs).toMatchObject({ op: 'rename', path: 'old.md', newPath: 'new.md' });
  });
});

// ── RpcRemoteFsClient S.rpc spans ─────────────────────────────────────

function makeStubRpcClient() {
  return {
    isClosed: () => false,
    onClose: () => () => { /* noop */ },
    call: vi.fn(async (_method: string, _params: unknown) => ({ mtime: 0 })),
    onNotification: () => () => { /* noop */ },
  };
}

describe('M2: RpcRemoteFsClient emits S.rpc spans on the wire-side calls', () => {
  it('writeBinary() emits S.rpc {method:"fs.writeBinary"} with byte count', async () => {
    const cap = captureSpans();
    const stub = makeStubRpcClient();
    const cli = new RpcRemoteFsClient(stub as never);
    await cli.writeBinary('a.md', Buffer.from('hi'));
    cap.off();

    const sRpc = cap.records.filter(r => r.name === 'S.rpc');
    expect(sRpc).toHaveLength(1);
    expect(sRpc[0].attrs).toMatchObject({ method: 'fs.writeBinary', path: 'a.md', bytes: 2 });
    expect(stub.call).toHaveBeenCalledWith('fs.writeBinary', expect.objectContaining({ path: 'a.md' }));
  });

  it('remove() emits S.rpc {method:"fs.remove"}', async () => {
    const cap = captureSpans();
    const cli = new RpcRemoteFsClient(makeStubRpcClient() as never);
    await cli.remove('gone.md');
    cap.off();

    const sRpc = cap.records.filter(r => r.name === 'S.rpc');
    expect(sRpc).toHaveLength(1);
    expect(sRpc[0].attrs).toMatchObject({ method: 'fs.remove', path: 'gone.md' });
  });

  it('rename() emits S.rpc {method:"fs.rename"} with newPath attr', async () => {
    const cap = captureSpans();
    const cli = new RpcRemoteFsClient(makeStubRpcClient() as never);
    await cli.rename('old.md', 'new.md');
    cap.off();

    const sRpc = cap.records.filter(r => r.name === 'S.rpc');
    expect(sRpc).toHaveLength(1);
    expect(sRpc[0].attrs).toMatchObject({ method: 'fs.rename', path: 'old.md', newPath: 'new.md' });
  });

  it('mkdirp() emits S.rpc {method:"fs.mkdir"}', async () => {
    const cap = captureSpans();
    const cli = new RpcRemoteFsClient(makeStubRpcClient() as never);
    await cli.mkdirp('subdir');
    cap.off();

    const sRpc = cap.records.filter(r => r.name === 'S.rpc');
    expect(sRpc).toHaveLength(1);
    expect(sRpc[0].attrs).toMatchObject({ method: 'fs.mkdir', path: 'subdir' });
  });
});
