import { test, expect } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  waitForShadowVaultLoaded,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * CAPABILITY PROBE — can the link/tag index be served from the remote, instead
 * of rebuilt here out of every note's bytes?
 *
 * This asserts almost nothing about the product. It REPORTS, the way
 * `fs-sync-bridge-probe.spec.ts` does, because the answer decides a design and
 * the design cannot be chosen from the typings alone.
 *
 * ## The question
 *
 * The tree is cheap and already remote-only: `BackgroundIndexer` walks names
 * and never reads a byte. But hyperlinks, backlinks, graph and Dataview all
 * read `app.metadataCache`, and Obsidian fills that itself — the moment a file
 * lands in `vault.fileMap`, Obsidian reads its CONTENT through our patched
 * adapter to parse links, tags and frontmatter. So the whole vault's bytes
 * cross the wire for indexing, even though nothing here is meant to hold them.
 *
 * `obsidian.d.ts` offers no way out: `MetadataCache` declares `getFileCache` /
 * `getCache` and no setter. What it does NOT say is whether the running app
 * exposes an internal store, or persists its cache in a form where a matching
 * entry lets Obsidian skip the read. That is what this measures.
 *
 * ## What each section decides
 *
 *  1. the SCALING LAW, not a byte count. An absolute number off an 11-file
 *     fixture says nothing about the case that matters — a multi-GB vault.
 *     What generalises is the RATIO: bytes Obsidian pulled over the total
 *     size of the markdown in the model. Sizes come from the tree walk
 *     (`TFile.stat.size`), so computing the denominator costs no transfer. A
 *     ratio near 1 proves "Obsidian reads the whole vault", and that is what
 *     extrapolates: at 5 GB it pulls 5 GB.
 *  2. THE decisive experiment: relaunch on the SAME shadow vault and measure
 *     again. Near-zero on the second run means Obsidian persisted its
 *     metadata and reuses it — which is the mechanism a server-computed index
 *     could be seeded into, and B1+B3 is reachable. Equal to the first run
 *     means it re-reads everything on every start, and the GB is paid every
 *     launch.
 *  3. whether `metadataCache` has any writable store at all — the shape an
 *     injected index would have to take
 *  4. whether `resolvedLinks` / `unresolvedLinks`, the one pair the public
 *     typings declare as plain writable records, really drive backlinks
 *  5. where Obsidian persists metadata, if it does
 *
 * ## The knot this is trying to cut
 *
 * Everything in `vault.fileMap` is what makes links, Dataview and graph work
 * — and it is also exactly what makes Obsidian read every note. Fewer files
 * in the model means less transfer and broken links; all of them means links
 * work and the whole vault crosses the wire. Section 2 is whether that knot
 * can be cut at all.
 *
 * Key NAMES are reported, never values: a vault's metadata is the user's
 * content, and this runs in CI.
 */

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let shadowVaultPath: string;

test.beforeAll(async () => {
  // Two launches plus a real connect, like every other spec doing this shape
  // of work. The default 120 s does not cover it.
  test.setTimeout(300_000);

  await assertSshdReachable();
  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

/**
 * One measurement pass, run against whichever launch is current. Extracted so
 * the SECOND launch can be measured with exactly the same code — the point of
 * section 2 is comparing two runs, and a comparison is only worth anything if
 * both sides were measured identically.
 */
/**
 * Wait for Obsidian to finish indexing, then for its cache to be written.
 *
 * The first version waited a flat 15 s and then killed Obsidian, which cannot
 * tell "the cache was not reused" from "the cache was never saved" —
 * `saveMetaCache` / `saveFileCache` are async. Run 30799129744 reported
 * `secondOverFirst: 1` and that reading was not supported by the measurement.
 *
 * `isCacheClean()` is Obsidian's own "indexing is done" predicate; the grace
 * period after it is for the save.
 */
async function settle(page: ObsidianHandle['page'], graceMs = 20_000): Promise<boolean> {
  const clean = await page
    .waitForFunction(
      () => {
        const mc = (globalThis as unknown as { app?: { metadataCache?: any } }).app?.metadataCache;
        return typeof mc?.isCacheClean === 'function' ? Boolean(mc.isCacheClean()) : false;
      },
      undefined,
      { timeout: 60_000 },
    )
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(graceMs);
  return clean;
}

async function measure(page: ObsidianHandle['page']): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const app = (globalThis as unknown as { app?: Record<string, unknown> }).app as
        | Record<string, any>
        | undefined;
      if (!app) return { error: 'no app' };

      // ── 1. THE SCALING LAW ───────────────────────────────────────────────
      // Not "how many bytes" — an absolute number off a small fixture says
      // nothing about a multi-GB vault. The RATIO generalises: bytes pulled
      // over the total size of the markdown in the model. Sizes come from the
      // tree walk, so the denominator costs no transfer. Near 1 means
      // Obsidian reads the whole vault, and THAT extrapolates to GB.
      const rc = app.plugins?.plugins?.['remote-ssh']?.adapterMgr?.readCache;
      const stats = rc?.stats?.();
      const files: unknown[] = Object.values(app.vault?.fileMap ?? {});
      const md = files.filter((f: any) => f?.extension === 'md');
      const totalMdBytes = md.reduce((n: number, f: any) => n + (f?.stat?.size ?? 0), 0);

      // Split the traffic. The previous run reported `pulledOverTotal: 6.468`
      // — 6009 bytes pulled against 929 bytes of markdown — which looked like
      // a catastrophe and was mostly `.obsidian` config and plugin code. That
      // part is a fixed cost per session; it does NOT grow with the vault.
      // Only the note traffic is the thing that scales, so only it belongs in
      // the ratio. Classified, never listed: these are vault paths.
      let noteBytes = 0;
      let noteEntries = 0;
      let configBytes = 0;
      let configEntries = 0;
      const map: Map<string, { data?: { byteLength?: number; length?: number } }> | undefined =
        rc?.map;
      if (map && typeof map.forEach === 'function') {
        map.forEach((v, k) => {
          const n = v?.data?.byteLength ?? v?.data?.length ?? 0;
          if (/(^|\/)\.obsidian(\/|$)/.test(k)) { configBytes += n; configEntries += 1; }
          else { noteBytes += n; noteEntries += 1; }
        });
      }

      // Obsidian validates a cached metadata entry against the file's identity.
      // If OUR side reports a different `(mtime, size)` on each launch, every
      // entry looks stale and the re-read is our own doing — fixable, and it
      // would make seeding the cache work after all. If the identity is stable
      // and Obsidian re-reads anyway, reuse is genuinely refused and only
      // runtime injection is left. Those two cost very different amounts to
      // build, so the difference is worth one map.
      const fingerprint: Record<string, string> = {};
      for (const f of md.slice(0, 200) as any[]) {
        if (typeof f?.path === 'string') {
          fingerprint[f.path] = `${f?.stat?.mtime ?? '?'}:${f?.stat?.size ?? '?'}`;
        }
      }

      out.cost = {
        readCache: stats ?? 'unreachable',
        filesInModel: files.length,
        markdownInModel: md.length,
        totalMdBytes,
        statFingerprint: fingerprint,
        traffic: { noteEntries, noteBytes, configEntries, configBytes },
        // THE scaling number: note bytes pulled over note bytes that exist.
        noteBytesOverTotal: totalMdBytes > 0
          ? Number((noteBytes / totalMdBytes).toFixed(3))
          : null,
        // Non-null metadata means Obsidian parsed the file, which means it
        // read it. This fraction is the scaling law in its cleanest form and
        // does not depend on any byte accounting.
        withParsedMetadata: md.filter(
          (f: any) => app.metadataCache?.getFileCache?.(f) != null,
        ).length,
      };

      // ── 2. Is there anywhere to PUT an index? ─────────────────────────────
      const mc = app.metadataCache;
      const proto = mc ? Object.getPrototypeOf(mc) : null;
      out.metadataCacheShape = {
        ownKeys: mc ? Object.keys(mc) : null,
        protoMethods: proto
          ? Object.getOwnPropertyNames(proto).filter((n) => {
            try { return typeof mc[n] === 'function'; } catch { return false; }
          })
          : null,
        // A path-keyed object is the shape an injected index would go into.
        candidateStores: mc
          ? Object.keys(mc).filter((k) => {
            const v = mc[k];
            return v !== null && typeof v === 'object' && !Array.isArray(v);
          })
          : null,
      };

      // ── 3. Do the two DECLARED-writable properties actually drive links? ──
      // `resolvedLinks` / `unresolvedLinks` are the only pair `obsidian.d.ts`
      // exposes as plain writable records. If the link graph follows what is
      // written there, links and backlinks can be served from the remote even
      // if `CachedMetadata` itself cannot be injected.
      const d = mc ? Object.getOwnPropertyDescriptor(mc, 'resolvedLinks') : null;
      out.linkGraph = {
        resolvedLinksType: typeof mc?.resolvedLinks,
        resolvedLinkSources: Object.keys(mc?.resolvedLinks ?? {}).length,
        unresolvedLinkSources: Object.keys(mc?.unresolvedLinks ?? {}).length,
        descriptor: d ? { writable: d.writable ?? null, hasSetter: typeof d.set === 'function' } : null,
        hasGetBacklinksForFile: typeof mc?.getBacklinksForFile === 'function',
      };

      // ── 5. Does Obsidian PERSIST metadata (so a seeded entry skips a read)?
      //
      // Counting RECORDS, not just database names. The previous version saw
      // both runs pull the same bytes and called it "re-read on every start",
      // which the measurement could not support: an empty cache means the save
      // never happened, a full one that is re-read anyway means reuse is
      // refused, and those need completely different fixes. `metadataCache.db`
      // names the database for THIS vault, so there is no hash to guess.
      const dbs = (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
        .databases;
      const dbName: string | null = mc?.db?.name ?? null;
      let records: unknown = 'not counted';
      if (dbName) {
        records = await new Promise((resolve) => {
          let done = false;
          const finish = (v: unknown): void => { if (!done) { done = true; resolve(v); } };
          setTimeout(() => finish('timed out'), 10_000);
          const req = indexedDB.open(dbName);
          req.onerror = () => finish(`open failed: ${String(req.error)}`);
          req.onsuccess = () => {
            const db = req.result;
            const names = Array.from(db.objectStoreNames);
            if (names.length === 0) { db.close(); finish({}); return; }
            const counts: Record<string, number | string> = {};
            let left = names.length;
            const tx = db.transaction(names, 'readonly');
            for (const n of names) {
              const cr = tx.objectStore(n).count();
              cr.onsuccess = () => {
                counts[n] = cr.result;
                if (--left === 0) { db.close(); finish(counts); }
              };
              cr.onerror = () => {
                counts[n] = `count failed: ${String(cr.error)}`;
                if (--left === 0) { db.close(); finish(counts); }
              };
            }
          };
        });
      }
      out.persistence = {
        vaultDbName: dbName,
        // The decisive number: how many entries this vault's cache holds.
        recordsPerStore: records,
        // In-memory stores, for comparison with what made it to disk.
        inMemory: {
          fileCacheKeys: mc?.fileCache ? Object.keys(mc.fileCache).length : null,
          metadataCacheKeys: mc?.metadataCache ? Object.keys(mc.metadataCache).length : null,
        },
        allIndexedDbNames: typeof dbs === 'function'
          ? (await dbs.call(indexedDB)).map((x) => x.name ?? '?')
          : 'databases() unavailable',
        cacheLikeKeys: mc ? Object.keys(mc).filter((k) => /cache|db|store|index/i.test(k)) : null,
      };

      return out;
  });
}

test.describe('capability probe: can the metadata index come from the remote? (#429)', () => {
  test('PROBE — report what decides server-side indexing', async () => {
    test.setTimeout(300_000);

    // Indexing done AND its cache written — not a flat 15 s, which is what
    // made the previous verdict unsupportable.
    const firstClean = await settle(obsidian.page);
    const firstRun = await measure(obsidian.page);

    // ── THE decisive experiment ──────────────────────────────────────────
    // Relaunch on the SAME shadow vault. If Obsidian persisted its metadata
    // and reuses it, the second run pulls ~nothing — and that persistence is
    // the mechanism a server-computed index can be seeded into, so B1+B3 is
    // reachable. If it pulls the same again, the whole vault crosses the wire
    // on EVERY start, which at GB scale is the thing that cannot be done.
    await obsidian.cleanup();
    obsidian = await launchObsidian(shadowVaultPath);
    await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
    const secondClean = await settle(obsidian.page);
    const secondRun = await measure(obsidian.page);

    // Note bytes, not total: config and plugin traffic is a fixed per-session
    // cost and does not grow with the vault, so including it would make a
    // reused cache look like a re-read one.
    const notesOf = (r: Record<string, unknown>): number | null => {
      const c = r.cost as { traffic?: { noteBytes?: number } } | undefined;
      return typeof c?.traffic?.noteBytes === 'number' ? c.traffic.noteBytes : null;
    };
    const recordsOf = (r: Record<string, unknown>): unknown =>
      (r.persistence as { recordsPerStore?: unknown } | undefined)?.recordsPerStore ?? null;
    const totalRecords = (v: unknown): number | null =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.values(v as Record<string, unknown>)
          .filter((n): n is number => typeof n === 'number')
          .reduce((a, b) => a + b, 0)
        : null;

    const n1 = notesOf(firstRun);
    const n2 = notesOf(secondRun);
    const rec2 = totalRecords(recordsOf(secondRun));
    const reused = n1 !== null && n2 !== null && n1 > 0 && n2 / n1 < 0.2;

    // Did the files keep the same identity across the two launches?
    const fpOf = (r: Record<string, unknown>): Record<string, string> =>
      ((r.cost as { statFingerprint?: Record<string, string> } | undefined)
        ?.statFingerprint) ?? {};
    const fp1 = fpOf(firstRun);
    const fp2 = fpOf(secondRun);
    const changed = Object.keys(fp1)
      .filter((p) => fp2[p] !== fp1[p])
      .slice(0, 10)
      .map((p) => ({ path: p, firstRun: fp1[p], secondRun: fp2[p] ?? '<absent>' }));
    const statStable = Object.keys(fp1).length > 0 && changed.length === 0;

    const report = {
      firstRun,
      secondRun,
      verdict: {
        indexingSettled: { firstRun: firstClean, secondRun: secondClean },
        firstRunNoteBytes: n1,
        secondRunNoteBytes: n2,
        secondOverFirst: n1 !== null && n2 !== null && n1 > 0
          ? Number((n2 / n1).toFixed(3))
          : null,
        cachedRecordsOnSecondRun: rec2,
        // Whose fault the re-read is. Obsidian validates a cached entry
        // against the file's identity, so an identity that changes on every
        // launch would invalidate everything — and that would be ours to fix,
        // not a property of Obsidian.
        statStableAcrossLaunches: statStable,
        statChanged: changed,
        // Four outcomes. "Re-read every start", "never saved", and "we kept
        // handing Obsidian a different file" look identical in a byte count
        // and need entirely different fixes.
        reading: n1 === null || n2 === null
          ? 'could not measure both runs'
          : reused
            ? 'metadata SURVIVES a restart — a server-computed index can be seeded into it'
            : rec2 === 0 || rec2 === null
              ? 'nothing was persisted — cannot yet tell refused-reuse from never-saved; ' +
                'see indexingSettled before reading anything into this'
              : !statStable
                ? 'persisted, but WE changed the files\' (mtime, size) between launches, so ' +
                  'every cached entry looked stale. Ours to fix — and seeding becomes ' +
                  'viable once it is'
                : 'persisted, identity stable, and re-read anyway — reuse is genuinely ' +
                  'refused, so seeding cannot help and the index must be injected at runtime',
      },
    };

    // eslint-disable-next-line no-console
    console.log(`[e2e] metadata index probe:\n${JSON.stringify(report, null, 2)}`);
    await test.info().attach('metadata-index-probe.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    // Reported, not asserted — this spec exists to inform a decision. It fails
    // only when it measured nothing, because a probe that quietly returns
    // nothing is worse than no probe: it reads as an answer.
    expect(
      (firstRun as { error?: string }).error ?? null,
      'the probe could not reach `app` at all, so it measured nothing',
    ).toBeNull();

    const cost = (firstRun as { cost?: { markdownInModel?: number } }).cost;
    expect(
      cost?.markdownInModel ?? 0,
      'no markdown in the vault model — the probe ran against an empty vault, so every ' +
      'number above is meaningless rather than reassuring',
    ).toBeGreaterThan(0);
  });

  /**
   * Can we keep the TREE and refuse the CONTENT?
   *
   * That is the whole question, because the two are not equally expensive and
   * they buy different things. `BackgroundIndexer.ts:55` records the half that
   * is free: `metadataCache` resolves links against `fileMap` alone, so links,
   * Quick Switcher and graph NODES need names and nothing else. Backlinks,
   * search, tags/frontmatter and Dataview are the half that needs bytes.
   *
   * Registering a file is currently what triggers Obsidian to read it, so
   * today those come as a package. Obsidian's own "Excluded files" setting is
   * the one documented, user-facing lever that might separate them —
   * `userIgnoreFilters` on disk, `isUserIgnored` / `updateUserIgnoreFilters`
   * on the running `metadataCache`, both of which the shape probe above found.
   *
   * Unlike injecting `fileCache` / `metadataCache`, this is published
   * behaviour, so a design resting on it is not a bet on internals.
   *
   * Set the filter, relaunch, and measure. Two things matter and they are
   * separate: whether the content reads stop, and whether the files SURVIVE
   * in the model — an exclusion that empties `fileMap` would take links and
   * Quick Switcher with it and be no use at all.
   */
  test('PROBE — does excluding files stop Obsidian reading them?', async () => {
    test.setTimeout(300_000);

    const baseline = await measure(obsidian.page);

    // Obsidian stores this in the vault's own `app.json`. `/…/` is its regex
    // form; this one matches every markdown file. The plugin's
    // `pullSharedObsidianConfig` logged `skipped [app.json, …]` for this
    // fixture, so it will not overwrite what we write here — recorded because
    // if that ever changes, this probe goes quietly meaningless.
    const appJsonPath = path.join(shadowVaultPath, '.obsidian', 'app.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(fs.readFileSync(appJsonPath, 'utf8')) as Record<string, unknown>;
    } catch { /* absent or unparseable — start from empty */ }
    fs.mkdirSync(path.dirname(appJsonPath), { recursive: true });
    fs.writeFileSync(
      appJsonPath,
      JSON.stringify({ ...existing, userIgnoreFilters: ['/\\.md$/'] }, null, 2),
      'utf8',
    );

    await obsidian.cleanup();
    obsidian = await launchObsidian(shadowVaultPath);

    // NOT `waitForShadowVaultLoaded`: it requires `getMarkdownFiles() >= 1`,
    // and "the exclusion emptied the model" is one of the answers being
    // measured, not a reason to abort before reporting it.
    const modelHasFiles = await obsidian.page
      .waitForFunction(
        () => {
          const v = (globalThis as unknown as { app?: { vault?: any } }).app?.vault;
          return Object.keys(v?.fileMap ?? {}).length > 1;
        },
        undefined,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    await settle(obsidian.page);
    const excluded = await measure(obsidian.page);

    const notes = (r: Record<string, unknown>): number | null => {
      const c = r.cost as { traffic?: { noteBytes?: number } } | undefined;
      return typeof c?.traffic?.noteBytes === 'number' ? c.traffic.noteBytes : null;
    };
    const inModel = (r: Record<string, unknown>): number | null =>
      (r.cost as { markdownInModel?: number } | undefined)?.markdownInModel ?? null;
    const parsed = (r: Record<string, unknown>): number | null =>
      (r.cost as { withParsedMetadata?: number } | undefined)?.withParsedMetadata ?? null;

    const b = notes(baseline);
    const e = notes(excluded);
    const stoppedReading = b !== null && e !== null && b > 0 && e / b < 0.2;
    const keptTheTree = (inModel(excluded) ?? 0) > 0;

    const report = {
      baseline: baseline.cost,
      excluded: excluded.cost,
      verdict: {
        modelHasFiles,
        baselineNoteBytes: b,
        excludedNoteBytes: e,
        markdownInModel: { baseline: inModel(baseline), excluded: inModel(excluded) },
        withParsedMetadata: { baseline: parsed(baseline), excluded: parsed(excluded) },
        stoppedReading,
        keptTheTree,
        reading: b === null || e === null
          ? 'could not measure both runs'
          : stoppedReading && keptTheTree
            ? 'EXCLUSION SEPARATES THEM — the tree survives and the content is not read. '
              + 'Links, Quick Switcher and graph nodes can be kept at zero transfer.'
            : stoppedReading
              ? 'reads stopped, but the files left the model too — links and Quick Switcher '
                + 'would go with them, so this lever costs what it saves'
              : 'exclusion did not stop the reads — the tree and the content are one '
                + 'package, and lazy registration is the only dial left',
      },
    };

    // eslint-disable-next-line no-console
    console.log(`[e2e] exclusion probe:\n${JSON.stringify(report, null, 2)}`);
    await test.info().attach('exclusion-probe.json', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });

    expect(b, 'no baseline note traffic to compare against').not.toBeNull();
  });
});
