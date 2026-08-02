import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nativeFs } from '../src/util/nativeFs';

/**
 * The invariant: `FsModulePatcher` replaces functions on the shared `fs`
 * module so plugins see the remote vault, and our own code must keep
 * seeing the real disk. If these ever start following the patch, the
 * disk cache stops evicting and the write-back watcher starts pushing
 * files that were never there.
 *
 * The end-to-end version of that — patch the module, then call
 * `nativeFs` — is not reproducible here: in the shipped bundle `fs` is a
 * plain CommonJS object and assignment works, but under vitest's ESM
 * interop the namespace is frozen and neither assignment nor `vi.spyOn`
 * can redefine a builtin's export. So this pins the two halves that ARE
 * observable: the technique (a bound copy is detached from later
 * mutation of the object it came from) and the result (nativeFs reads
 * the real disk, and covers every function the patcher takes over).
 */
describe('nativeFs', () => {
  const made: string[] = [];

  afterEach(() => {
    for (const f of made.splice(0)) fs.rmSync(f, { force: true });
  });

  it('reads the real disk', () => {
    const file = path.join(os.tmpdir(), `nativefs-${process.pid}.txt`);
    fs.writeFileSync(file, 'real bytes');
    made.push(file);

    expect(nativeFs.existsSync(file)).toBe(true);
    expect(nativeFs.existsSync(path.join(os.tmpdir(), `nativefs-${process.pid}-absent.txt`))).toBe(false);
    expect(nativeFs.readFileSync(file).toString()).toBe('real bytes');
    expect(nativeFs.statSync(file).size).toBe('real bytes'.length);
  });

  it('covers every function the patcher takes over', () => {
    for (const k of ['existsSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync'] as const) {
      expect(typeof (nativeFs as unknown as Record<string, unknown>)[k], `nativeFs.${k} is missing`)
        .toBe('function');
    }
  });

  it('a bound copy is detached from later mutation of its module object', () => {
    // Exactly how nativeFs is built, against a stand-in we CAN mutate.
    const mod: { existsSync: (p: string) => boolean } = { existsSync: () => false };
    const snapshot = mod.existsSync.bind(mod);

    mod.existsSync = () => true;                 // the patch lands

    expect(mod.existsSync('anything'), 'the stand-in was not actually patched').toBe(true);
    expect(
      snapshot('anything'),
      'the bound copy followed the patch — the snapshot technique does not hold',
    ).toBe(false);
  });
});
