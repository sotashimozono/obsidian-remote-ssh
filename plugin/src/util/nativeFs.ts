import * as fs from 'fs';

/**
 * Node's real filesystem, captured before anything can replace it.
 *
 * `FsModulePatcher` takes over `fs.readFileSync`, `readdirSync`,
 * `existsSync`, `statSync` and `lstatSync` on the SHARED module object,
 * so that plugins reading the vault through Node see the remote tree
 * (#429). That module is shared with this plugin too — and our own code
 * asking "is this file really on disk?" must get the truth, not the
 * virtual answer we manufacture for everyone else.
 *
 * Left unguarded, the patch feeds itself:
 *
 *  - the disk cache's `statFile` would see a synthesised stat for a
 *    file it never wrote, conclude the copy had been "changed on disk",
 *    and refuse to evict it — so the cache budget would stop working;
 *  - `materializeSync` would see `existsSync` say yes and report a file
 *    materialised when nothing is there;
 *  - worst of all, the write-back watcher's rescan would list every note
 *    in the vault as a local file and start pushing the whole tree back
 *    to the remote.
 *
 * These bindings are taken at module evaluation — plugin load, long
 * before a connect installs any patch — so they stay pristine. Internal
 * callers use these; the patched module is for plugins.
 */
export const nativeFs = {
  existsSync: fs.existsSync.bind(fs),
  statSync: fs.statSync.bind(fs),
  lstatSync: fs.lstatSync.bind(fs),
  readdirSync: fs.readdirSync.bind(fs),
  readFileSync: fs.readFileSync.bind(fs),
  realpathSync: fs.realpathSync.bind(fs),
} as const;
