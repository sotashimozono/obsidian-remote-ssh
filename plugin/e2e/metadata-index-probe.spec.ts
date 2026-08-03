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
 *  1. how much content Obsidian actually pulled, in bytes — the cost being
 *     argued about, measured rather than assumed
 *  2. whether `metadataCache` has any writable store at all — the shape an
 *     injected index would have to take
 *  3. whether `resolvedLinks` / `unresolvedLinks`, the one pair the public
 *     typings declare as plain writable records, really drive backlinks
 *  4. whether Obsidian persists metadata somewhere a pre-seeded entry could
 *     stand in for reading the file
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

test.describe('capability probe: can the metadata index come from the remote? (#429)', () => {
  test('PROBE — report what decides server-side indexing', async () => {
    test.setTimeout(180_000);

    // Let Obsidian's own indexing settle, so the byte count below is the
    // finished cost rather than a snapshot taken mid-walk.
    await obsidian.page.waitForTimeout(15_000);

    const report = await obsidian.page.evaluate(async () => {
      const out: Record<string, unknown> = {};
      const app = (globalThis as unknown as { app?: Record<string, unknown> }).app as
        | Record<string, any>
        | undefined;
      if (!app) return { error: 'no app' };

      // ── 1. THE COST: how many bytes of note content did Obsidian pull? ────
      // Every byte in the adapter's read cache arrived over the wire. Nothing
      // in this spec opens a note, so whatever is in there was pulled by
      // Obsidian's own indexing and by nothing else.
      const stats = app.plugins?.plugins?.['remote-ssh']?.adapterMgr?.readCache?.stats?.();
      const files: unknown[] = Object.values(app.vault?.fileMap ?? {});
      const md = files.filter((f: any) => f?.extension === 'md');
      out.cost = {
        readCache: stats ?? 'unreachable',
        filesInModel: files.length,
        markdownInModel: md.length,
        // Non-null metadata means Obsidian parsed the file, which means it
        // read it. The ratio is how much of the vault it insisted on having.
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

      // ── 4. Does Obsidian PERSIST metadata (so a seeded entry skips a read)?
      const dbs = (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> })
        .databases;
      out.persistence = {
        indexedDbNames: typeof dbs === 'function'
          ? (await dbs.call(indexedDB)).map((x) => x.name ?? '?')
          : 'databases() unavailable',
        // A store keyed by (path, mtime, size) is the shape that lets a
        // pre-seeded entry stand in for reading the file.
        cacheLikeKeys: mc ? Object.keys(mc).filter((k) => /cache|db|store|index/i.test(k)) : null,
      };

      return out;
    });

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
      (report as { error?: string }).error ?? null,
      'the probe could not reach `app` at all, so it measured nothing',
    ).toBeNull();

    const cost = (report as { cost?: { markdownInModel?: number } }).cost;
    expect(
      cost?.markdownInModel ?? 0,
      'no markdown in the vault model — the probe ran against an empty vault, so every ' +
      'number above is meaningless rather than reassuring',
    ).toBeGreaterThan(0);
  });
});
