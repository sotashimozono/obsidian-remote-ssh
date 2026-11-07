import * as fs from 'fs';
import * as path from 'path';
import { SharedConfigWatcher } from './SharedConfigWatcher';
import {
  pullSharedObsidianConfig,
  pushSharedObsidianConfig,
  SHARED_OBSIDIAN_CONFIG_FILES,
  type SharedConfigReader,
  type SharedConfigWriter,
} from './SharedObsidianConfigSync';
import {
  communityPluginsBasePath,
  pullCommunityPlugins,
  pushCommunityPlugins,
  pullPluginBinaries,
  pushPluginBinaries,
  readEnabledPluginIds,
} from './CommunityPluginsSync';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';

/**
 * Everything the post-connect config sync touches, named.
 *
 * It used to be 138 lines inside `main.ts`'s `runAutoConnect`, which is
 * excluded from coverage — so the ordering below, which several long
 * comments insist on, was enforced by nothing.
 */
export interface ConfigSyncPorts {
  adapter: SharedConfigReader & SharedConfigWriter;
  /** Vault-relative, e.g. `.obsidian`. */
  remoteConfigDir: string;
  /** Absolute path to this device's shadow config dir. */
  localConfigDir: string;
  /** Holds the per-device merge base; see `communityPluginsBasePath`. */
  stateRoot: string;
  profileId: string;
  /** Re-runs the marketplace installer over whatever the pull just added. */
  installMissingPlugins(): Promise<void>;
  notify(message: string): void;
  /** Which run this was — `layout-ready` or `reconnect` — for the log. */
  tag: string;
  /** Test seam for the fs watch + timers. */
  makeWatcher?(p: ConfigSyncPorts): SharedConfigWatcher;
}

/**
 * What `fs.watch` reported, as a basename or "something changed, unknown what".
 *
 * The platform does not always give a filename — Windows and some network
 * filesystems report the event without one — and `SharedConfigWatcher` treats
 * null as "consider every shared file". Passing `undefined` straight through
 * would instead look like a basename of "undefined" and match nothing.
 *
 * Its own function so it can be checked on every platform: a unit suite has
 * no business opening a native watch handle, and this is the only part of
 * that callback with a decision in it.
 *
 * @internal Exported for testing.
 */
export function watchedName(filename: string | Buffer | null | undefined): string | null {
  return filename ? String(filename) : null;
}

/**
 * Adapts `fs.watch`'s `(eventType, filename)` to the watcher's `(name | null)`.
 *
 * The event type is deliberately dropped: `rename` and `change` both mean
 * "look at this file again", and `SharedConfigWatcher` decides what to do by
 * comparing content, not by trusting the kind of event.
 *
 * A named function rather than an inline closure so it can be checked without
 * opening a native watch handle — which is what took the Windows worker down.
 *
 * @internal Exported for testing.
 */
export function watchListener(
  onChange: (name: string | null) => void,
): (eventType: string, filename: string | Buffer | null) => void {
  return (_eventType, filename) => onChange(watchedName(filename));
}

/**
 * Open the OS watch on the local config dir, and hand back something that
 * closes it.
 *
 * `open` defaults to the real `fs.watch`; a test passes its own so this can
 * be checked without a native handle. That matters twice over — opening one
 * in the unit suite killed the Windows worker outright, and the invariant
 * worth holding is that the returned closer really does close the watcher.
 * `SharedConfigWatcher.stop()` relies on it, and a closer that did nothing
 * would leak a watch handle on every connect.
 *
 * @internal `open` is exported for testing.
 */
export function openConfigWatch(
  dir: string,
  onChange: (name: string | null) => void,
  open: typeof fs.watch = fs.watch,
): { close(): void } {
  const w = open(dir, { persistent: false }, watchListener(onChange));
  return { close: () => w.close() };
}

/**
 * How the real watcher reaches the disk and the remote.
 *
 * Separate from constructing it so the three callbacks can be exercised: one
 * of them is the only thing that tells a user their settings did not reach
 * the remote, which is #342 in miniature.
 *
 * @internal Exported for testing.
 */
export function watcherPorts(p: ConfigSyncPorts): ConstructorParameters<typeof SharedConfigWatcher>[0] {
  return {
    watch: (onChange) => openConfigWatch(p.localConfigDir, onChange),
    readLocal: (b) => {
      try { return fs.readFileSync(path.join(p.localConfigDir, b), 'utf-8'); }
      catch { return null; }
    },
    flush: async () => {
      const r = await pushSharedObsidianConfig(
        p.adapter, p.remoteConfigDir, p.localConfigDir,
      );
      if (r.errored.length > 0) {
        p.notify(
          `Remote SSH: ${r.errored.length} config file` +
          `${r.errored.length === 1 ? '' : 's'} (${r.errored.join(', ')}) ` +
          'could not be pushed — settings change not yet saved remotely',
        );
      }
    },
    debounceMs: 1500,
    setTimer: (cb, ms) => window.setTimeout(cb, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
  };
}

function defaultWatcher(p: ConfigSyncPorts): SharedConfigWatcher {
  return new SharedConfigWatcher(watcherPorts(p));
}

/**
 * Bring this device's config into line with the remote, then keep watching.
 *
 * The ORDER is the point, and each step's comment says why it sits where it
 * does. Returns the started watcher; the caller owns stopping it.
 */
export async function syncConfigAfterConnect(
  p: ConfigSyncPorts,
): Promise<SharedConfigWatcher> {
    // Pull this device's Obsidian config (app.json / appearance.json /
    // core-plugins.json / hotkeys.json — now per-client via PathMapper)
    // from the remote onto the local shadow disk *before* the populate, so
    // the next time this window restarts Obsidian reads fresh settings
    // instead of the stale local copy (#342). Best-effort: a failure here
    // must not block rendering the vault.
      try {
        const cfg = await pullSharedObsidianConfig(
          p.adapter, p.remoteConfigDir, p.localConfigDir,
        );
        if (cfg.errored.length > 0) {
          // The connection is up but some shared-config files the
          // remote *had* couldn't be pulled (transient SSH error /
          // corrupt file). Without a signal the user would just see
          // settings silently not update — the #342 symptom. Absent
          // files are not errored, so a fresh vault stays quiet.
          p.notify(
            `Remote SSH: ${cfg.errored.length} config file` +
            `${cfg.errored.length === 1 ? '' : 's'} (${cfg.errored.join(', ')}) ` +
            'could not be synced — settings may be stale until the next connect',
          );
        }
      } catch (e) {
        logger.warn(
          `syncConfigAfterConnect(${p.tag}): shared-config pull failed: ${errorMessage(e)}`,
        );
      }

      // #429 / #342 residual: round-trip the enabled community-plugins
      // list. Pull first so plugins set up on the remote load in the
      // shadow vault (the marketplace installer then fetches any missing
      // binaries); then push the converged result so a plugin enabled —
      // or UNINSTALLED — only here reaches the remote for other machines.
      // Kept out of the verbatim shared-config set because `remote-ssh`
      // must be force-preserved through the merge (a verbatim copy of a
      // remote list omitting it would disable this very plugin).
      //
      // Both halves take this device's BASE snapshot: the converged list
      // as of the last successful round-trip HERE. It is what turns the
      // old monotonic union into a real 3-way merge, so a local uninstall
      // propagates instead of being resurrected by the next pull. The
      // pull only reads it; the push commits it once both sides agree.
      const cpBasePath = communityPluginsBasePath(p.stateRoot, p.profileId);
      try {
        await pullCommunityPlugins(p.adapter, p.remoteConfigDir, p.localConfigDir, cpBasePath);
        await pushCommunityPlugins(p.adapter, p.remoteConfigDir, p.localConfigDir, cpBasePath);
      } catch (e) {
        logger.warn(
          `syncConfigAfterConnect(${p.tag}): community-plugins round-trip failed: ${errorMessage(e)}`,
        );
      }

      // #429b: a plugin the pull above just added to community-plugins.json
      // has no binary staged yet and won't load (the startup installer,
      // prepareForAutoConnect, runs only after the whole connect, and not at
      // all on a reconnect). Re-run the marketplace installer now the list is
      // current; `enablePluginAndSave` loads a marketplace plugin live, no
      // restart. Idempotent (already-installed ids are skipped). BRAT /
      // non-marketplace plugins still need their binary on the remote.
      try {
        await p.installMissingPlugins();
      } catch (e) {
        logger.warn(`syncConfigAfterConnect(${p.tag}): post-pull plugin install failed: ${errorMessage(e)}`);
      }

      // #429b binary round-trip: the marketplace installer above can't
      // fetch a BRAT / sideloaded plugin (it isn't on the registry). Run
      // AFTER the installer so the plugins it just fetched are on disk —
      // the pull then only stages what's STILL missing (the non-market
      // ones), which keeps the installer's live load intact and also
      // acts as a fallback if a marketplace fetch failed. The push makes
      // the remote `.obsidian/plugins/` a complete vault so every machine
      // can pull. A pulled binary loads on the next vault open (Obsidian
      // scans the plugins dir at startup).
      try {
        const enabledIds = readEnabledPluginIds(p.localConfigDir);
        await pullPluginBinaries(p.adapter, p.remoteConfigDir, p.localConfigDir, enabledIds);
        await pushPluginBinaries(p.adapter, p.remoteConfigDir, p.localConfigDir, enabledIds);
      } catch (e) {
        logger.warn(`syncConfigAfterConnect(${p.tag}): plugin-binary round-trip failed: ${errorMessage(e)}`);
      }

      // #342 push half: pull only brought remote→local. Without this,
      // a settings change made HERE never reaches the remote, so the
      // next session's pull finds nothing and the change evaporates.
      // Watch the local config dir and push divergent shared files.
      const watcher = (p.makeWatcher ?? defaultWatcher)(p);
      // Seed the just-pulled bytes as the synced baseline so the
      // pull's own writes (and Obsidian re-saving an identical file
      // on open) don't immediately echo back to the remote.
      for (const base of SHARED_OBSIDIAN_CONFIG_FILES) {
        try {
          watcher.markSynced(
            base, fs.readFileSync(path.join(p.localConfigDir, base), 'utf-8'),
          );
        } catch { /* absent locally — nothing to baseline */ }
      }
      watcher.start();
      return watcher;
}
