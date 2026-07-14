import { test, expect, type Page } from '@playwright/test';
import {
  launchObsidian,
  driveConnectFlow,
  findShadowVaultPath,
  waitForShadowVaultLoaded,
  runCommandViaPalette,
  dismissBlockingModals,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import { makeFakePlugin, seedPluginOnRemote } from './helpers/remote-fixtures';
import {
  COMMUNITY_PLUGINS_REL,
  captureCommunityPlugins,
  parseIdList,
  preCleanRemoteFixtures,
  resetRemoteFixtures,
  type CommunityPluginsSnapshot,
  type FixtureFootprint,
} from './helpers/remote-reset';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';

/**
 * DOES A REMOTE VAULT ACTUALLY WORK AS AN OBSIDIAN VAULT? (#468 — BackgroundIndexer)
 *
 * ── The question this file answers ───────────────────────────────────────────
 *
 * `next` gained `BackgroundIndexer` (src/vault/BackgroundIndexer.ts): after
 * connect, a background pass walks the FULL remote tree and feeds every entry to
 * `VaultModelBuilder.buildChunked`, so `vault.fileMap` eventually holds the whole
 * vault instead of just the root's immediate children. Two existing tests prove
 * that a link and an embed into ONE subfolder now resolve
 * (`links-metadata.spec.ts` test 5, `images.spec.ts` subfolder embed).
 *
 * That is a narrow proof. It shows the vault MODEL is complete; it says nothing
 * about the surfaces users actually name when they ask "does my vault work":
 * hyperlinks WHILE EDITING (Live Preview, not reading view), plugins of the
 * Dataview class, and the GRAPH. This file is about those.
 *
 * ── The load-bearing distinction: REGISTER vs READ ───────────────────────────
 *
 * `BackgroundIndexer` REGISTERS files. It never reads a single byte of content —
 * its own docblock says so ("File CONTENT is never read — only the tree"). But
 * frontmatter, tags, headings and links do not come from the tree; they come from
 * Obsidian's `metadataCache`, which READS EVERY MARKDOWN FILE IT LEARNS ABOUT. On
 * a remote vault every one of those reads is an SSH round-trip through the
 * patched adapter.
 *
 * So `BackgroundIndexer` handing Obsidian a complete `fileMap` is not the end of
 * the story — it is the START of a second, much heavier phase that the indexer
 * does not control, does not measure, and cannot fail loudly. Dataview, the
 * graph, backlinks, search and the `[[` autocompleter all read the OUTPUT of that
 * second phase. Test 2 is the one that proves the second phase happens at all;
 * test 10 measures what it costs.
 *
 * ── The fixture is DEEP on purpose ───────────────────────────────────────────
 *
 * Every note except the root one lives at least two levels down, and the headline
 * link (`<S>-a/b/c/deeper.md` → `<S>-a/one.md`) has BOTH ends below the root. The
 * old root-only walk could not have reached either end, so nothing here can pass
 * "by accident" the way a root-level fixture could. And NOTHING IN THIS SPEC EVER
 * CLICKS A FOLDER OPEN before an assertion: an expand click would invoke
 * `LazyFolderLoader` (the delegated `.nav-folder-title` hook in src/main.ts) and
 * quietly do the indexer's job for it, which would make every green below a lie.
 * That is also why notes are opened with `workspace.openFile` rather than by
 * clicking a File Explorer row — a deep row does not even exist until its folder
 * is expanded, and expanding it is the one thing we must not do. The GESTURE under
 * test in each case (typing `[[`, clicking a link, the switcher, the search box)
 * is still a real user gesture; only the "get me to the note" step is model-level.
 *
 * ── The Dataview stand-in (test 9) ───────────────────────────────────────────
 *
 * Real Dataview is NOT installed: that would make CI depend on a marketplace
 * download. Instead a fixture plugin does exactly what Dataview's indexer does —
 * `vault.getMarkdownFiles()`, then `metadataCache.getFileCache(f)` for each — and
 * stashes the result on `window.__E2E_DV__`. It is seeded on the REMOTE (never in
 * the source scaffold: a scaffold plugin ends up in
 * `settings.pendingPluginSuggestions` and the shadow window then opens a
 * `PendingPluginsModal` that swallows Ctrl+P and deadlocks every palette
 * interaction — see plugin-code-roundtrip.spec.ts), pulled in by the connect-time
 * plugin round-trip, and loaded on the relaunch in `beforeAll`. Its scan is
 * re-runnable on demand (`window.__E2E_DV_SCAN__()`), because at `onload()` the
 * background index has barely started and a snapshot taken there would prove
 * nothing.
 *
 * ── PREDICTIONS (nothing below is weakened, skipped or fixme'd) ──────────────
 *
 *   1 registration of the deep tree ........ PASS — this is precisely what #468 does.
 *   2 metadataCache CONTENT for deep files . PASS, and it is the one genuinely at
 *     risk: it depends on Obsidian reading every file over SSH, which is slow and
 *     which nothing in the plugin drives. Hence the 60 s budget.
 *   3 graph nodes .......................... see the test's own docblock — WHICH of
 *     the two assertions it makes is decided at RUNTIME and printed.
 *   4 `[[` suggester in Live Preview ....... PASS if 1+2 pass (the suggester ranks
 *     `vault.getMarkdownFiles()`), and it is the direct answer to "do hyperlinks
 *     work while editing".
 *   5 clicking a link in Live Preview ...... PASS.
 *   6 backlinks deep→deep .................. PASS if 2 passes.
 *   7 global search into a deep note ....... PASS, but it is the slowest surface:
 *     search reads file bodies over SSH.
 *   8 Quick Switcher ....................... PASS if 1 passes.
 *   9 Dataview-class plugin ................ PASS if 1+2 pass.
 *  10 timing ............................... not an assertion; it PRINTS.
 *
 * A red here is a finding about the product, not a broken test.
 *
 * HARD-FAILS, never skips.
 */

const STAMP = Date.now().toString(36);

// ── the DEEP fixture, seeded on the REMOTE before the first connect ──────────
const ROOT = `${STAMP}-root.md`;
const A_DIR = `${STAMP}-a`;
const ONE = `${A_DIR}/one.md`;
const B_DIR = `${A_DIR}/b`;
const DEEP = `${B_DIR}/deep.md`;
const C_DIR = `${B_DIR}/c`;
const DEEPER = `${C_DIR}/deeper.md`;
const ORPHAN = `${STAMP}-orphan.md`;
/** A scratch note for the Live-Preview typing test (test 4). */
const SCRATCH = `${STAMP}-scratch.md`;

/** Every seeded markdown note. Test 1's foundation assertion is about this set. */
const ALL_NOTES = [ROOT, ONE, DEEP, DEEPER, ORPHAN] as const;

const TAG_ROOT = `#${STAMP}tag-root`;
const TAG_A = `#${STAMP}tag-a`;
const TAG_DEEP = `#${STAMP}tag-deep`;

/** Present in NO other file in the vault — test 7's needle. */
const NEEDLE = `${STAMP}NeedleOnlyInDeeper`;

/** The Dataview-class fixture plugin (test 9). */
const DV_ID = 'e2e-dataview-probe';
const DV_VERSION = '1.0.0';

/** Everything this spec puts on the SHARED docker remote, and therefore owes back. */
const FOOTPRINT: FixtureFootprint = { pluginIds: [DV_ID] };

/**
 * Registration is fast (one walk + chunked inserts). CONTENT is not: Obsidian's
 * metadataCache reads every markdown file it learns about, and on a remote vault
 * each of those is an SSH round-trip. 60 s is far past the observed settle time
 * for a 6-file fixture on a warm connection — it exists so a RED here is a real
 * defect rather than a slow runner.
 */
const INDEX_TIMEOUT_MS = 60_000;

/** Budget for ONE UI gesture. Tighter than the config's `actionTimeout: 30_000`. */
const ACTION_TIMEOUT_MS = 15_000;

/**
 * Budget for ONE `page.evaluate`. `page.evaluate` has NO timeout of its own: a
 * wedged renderer never answers, and an `expect.poll` cannot time out while its
 * own probe is stuck inside one — the hang wins and the report says only "Test
 * timeout exceeded". Bounding the evaluate makes "the renderer stopped answering"
 * a fast, named failure. Used ONLY on evaluates, never around a click (there,
 * Playwright's own locator diagnostic is strictly better evidence).
 */
const EVAL_TIMEOUT_MS = 10_000;

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let shadowVaultPath: string;
let communityPluginsSnapshot: CommunityPluginsSnapshot = { raw: null };

/** Wall-clock marks for test 10. `null` = that milestone was never reached. */
let connectStartedAt = 0;
let allFilesAt: number | null = null;
let deepMetadataAt: number | null = null;

test.beforeAll(async () => {
  test.setTimeout(300_000);

  // HARD-FAIL, never skip: a down sshd is a broken harness and a broken connect is
  // a broken plugin. Both must be red, not green-by-skipping.
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though the port ' +
      'is open. This spec hard-fails rather than skipping.',
    );
  }

  // A previous run that crashed leaves the DV fixture on the SHARED docker vault —
  // and the remote enabled list is MONOTONIC (pushCommunityPlugins only ever grows
  // it), so nothing but the harness can take it out again.
  await preCleanRemoteFixtures(remote, FOOTPRINT);
  communityPluginsSnapshot = await captureCommunityPlugins(remote);

  // ── the deep tree, seeded BEFORE connect ─────────────────────────────────
  // Before the connect on purpose: the whole subject is what the connect-time walk
  // + the background index put into `vault.fileMap`. A fixture written afterwards
  // would arrive down the live `fs.watch` → ChangeListener path instead and would
  // exercise none of it.
  await remote.mkdirp(C_DIR); // creates <S>-a, <S>-a/b and <S>-a/b/c in one pass

  await remote.writeFile(
    ROOT,
    `# Root\n\n[[${A_DIR}/one]]\n\n[[${B_DIR}/deep]]\n\n${TAG_ROOT}\n`,
  );
  await remote.writeFile(
    ONE,
    `---\nkind: alpha\nnum: 1\n---\n\n# One\n\n[[${B_DIR}/deep]]\n\n${TAG_A}\n`,
  );
  await remote.writeFile(
    DEEP,
    `---\nkind: beta\nnum: 2\n---\n\n# Deep\n\n[[${STAMP}-root]]\n\n${TAG_DEEP}\n`,
  );
  await remote.writeFile(
    DEEPER,
    `# Deeper\n\n${NEEDLE}\n\n[[${A_DIR}/one]]\n\n${TAG_DEEP}\n`,
  );
  await remote.writeFile(ORPHAN, '# Orphan\n\nNo links, no edges.\n');
  await remote.writeFile(SCRATCH, '# Scratch\n\n');

  // ── the Dataview-class plugin, on the REMOTE ─────────────────────────────
  // Named in the remote enabled list so the connect-time `pullCommunityPlugins`
  // merges it into the shadow vault's list. (The product force-unions `remote-ssh`
  // into that merge, so adding our id cannot disable the sync plugin itself.)
  // Spread into a plain record: `seedPluginOnRemote` takes `Record<string, string>`,
  // and the named `FakePluginFiles` interface has no index signature (same idiom as
  // plugin-code-roundtrip.spec.ts's `probeFiles`).
  await seedPluginOnRemote(remote, DV_ID, { ...makeFakePlugin({
    id: DV_ID,
    version: DV_VERSION,
    onloadBody: dataviewProbeBody(),
  }) });
  const enabled = parseIdList(await remote.readFile(COMMUNITY_PLUGINS_REL));
  if (!enabled.includes(DV_ID)) {
    await remote.writeFile(COMMUNITY_PLUGINS_REL, `${JSON.stringify([...enabled, DV_ID])}\n`);
  }

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Building blocks rather than `connectAndOpenShadow`, so we keep hold of the
  // shadow vault PATH — every relaunch reuses it and `waitForShadowVaultLoaded`
  // needs its log path.
  await driveConnectFlow(obsidian.page);
  shadowVaultPath = await findShadowVaultPath(scaffold.vaultPath, 15_000);
  await obsidian.cleanup();

  // First shadow window: its connect is what PULLS the DV plugin's code onto the
  // shadow disk. Obsidian scans `.obsidian/plugins/` only at STARTUP, so code
  // staged during this connect cannot load until the next open.
  obsidian = await launchObsidian(shadowVaultPath);
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);
  await obsidian.cleanup();

  // RELAUNCH — this is the session every test below runs against, and the one in
  // which the DV plugin is actually loaded. The clock for test 10 starts here:
  // `launchObsidian` returns once the PLUGIN has loaded, but the SSH connect, the
  // adapter patch, the root populate and `startBackgroundIndex()` all land later,
  // at layout-ready. Measuring from before the launch therefore includes the whole
  // connect — which is exactly the wall time a user waits.
  connectStartedAt = Date.now();
  obsidian = await launchObsidian(shadowVaultPath);
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

  // Dismissing the trust dialog makes Obsidian auto-open its Settings dialog on
  // the Community-plugins tab. That `.modal-container.mod-dim` covers the whole
  // window and intercepts pointer events, so nothing can be clicked while it is up.
  await dismissBlockingModals(obsidian.page);
});

test.afterAll(async () => {
  await obsidian?.cleanup().catch(() => { /* best effort */ });
  if (remote) {
    // The remote enabled list can only GROW on its own (the monotonic union in
    // pushCommunityPlugins), so a fixture plugin left there would be pulled into
    // EVERY later spec's shadow vault at connect. Reverting it is the HARNESS's
    // job — the product cannot do it.
    await resetRemoteFixtures(remote, FOOTPRINT, communityPluginsSnapshot);
    await Promise.allSettled([
      remote.removeFile(ROOT),
      remote.removeFile(ORPHAN),
      remote.removeFile(SCRATCH),
    ]);
    await remote.rmrf(A_DIR).catch(() => { /* best effort */ });
    await remote.disconnect();
  }
  scaffold?.cleanup();
});

test.beforeEach(() => {
  // Several of these polls run for a minute against a live SSH connection; the
  // config's 120 s default has no headroom once two of them stack in one test.
  test.setTimeout(240_000);
});

test.describe('a remote vault behaves like a real vault: editing, plugins, graph (#468)', () => {
  /**
   * FOUNDATION. If the background index does not register the deep tree, then
   * every other test in this file is asserting against a vault that is simply not
   * there, and their reds would all be the same red. First, for that reason.
   *
   * Note what this does NOT prove: registration is not indexing. `fileMap` can be
   * complete while `metadataCache` is empty — that is test 2's job.
   */
  test('1 — the background index registers the ENTIRE deep tree', async () => {
    try {
      await expect
        .poll(async () => {
          const paths = await markdownPaths(obsidian.page);
          const present = ALL_NOTES.filter((p) => paths.includes(p)).length;
          if (present === ALL_NOTES.length && allFilesAt === null) allFilesAt = Date.now();
          return present;
        }, {
          message:
            'BackgroundIndexer did not register the whole tree: vault.getMarkdownFiles() ' +
            `never contained all ${ALL_NOTES.length} seeded notes within ` +
            `${INDEX_TIMEOUT_MS}ms. Everything Obsidian knows — links, tags, graph, ` +
            'search, Quick Switcher, every community plugin — is resolved against ' +
            'vault.fileMap and nothing else, so a note that is not in it does not exist.',
          timeout: INDEX_TIMEOUT_MS,
        })
        .toBe(ALL_NOTES.length);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n${await dumpVaultModel(obsidian.page)}`,
      );
    }
  });

  /**
   * THE ONE THE MAINTAINER IS REALLY ASKING ABOUT.
   *
   * `BackgroundIndexer` only REGISTERS files ("File CONTENT is never read — only
   * the tree", BackgroundIndexer.ts:78). Everything a user calls "my vault
   * working" — frontmatter, tags, resolved links, and therefore Dataview, the
   * graph, backlinks — lives in `metadataCache`, which Obsidian populates by
   * READING each registered file. On a remote vault that read is an SSH
   * round-trip, through the patched adapter, for every markdown file in the vault.
   * Nothing in the plugin drives it, waits for it, or reports it.
   *
   * So this test asks the question test 1 cannot: after the tree is registered,
   * does Obsidian actually go and READ it?
   *
   * The three probes are deliberately different SHAPES of metadata, because they
   * can fail independently:
   *   • frontmatter — a YAML block at the head of a DEEP file was parsed
   *   • tags        — the BODY of that file was parsed, not merely its head
   *   • resolvedLinks[deeper] ∋ one — a link whose SOURCE and TARGET are BOTH
   *     below the root. Neither end was reachable by the old root-only walk, so
   *     this edge cannot exist unless the background index put both ends in the
   *     model AND Obsidian then read the source.
   * The failure message reports which of the three is missing.
   */
  test('2 — metadataCache indexed CONTENT for deep files — links, tags and frontmatter', async () => {
    try {
      await expect
        .poll(async () => {
          const m = await probeMetadata(obsidian.page);
          const ok = m.frontmatterKind === 'beta'
            && m.frontmatterNum === 2
            && m.deepTags.includes(TAG_DEEP)
            && m.deeperResolved.includes(ONE);
          if (ok && deepMetadataAt === null) deepMetadataAt = Date.now();
          return ok;
        }, {
          message:
            'metadataCache never indexed the CONTENT of the deep notes within ' +
            `${INDEX_TIMEOUT_MS}ms. BackgroundIndexer registers files but never reads ` +
            'them; Obsidian must then read each one over SSH to extract its metadata. ' +
            'If this is red, the vault model is complete (test 1) and the KNOWLEDGE ' +
            'layer on top of it is still empty — Dataview, the graph, backlinks, tags ' +
            'and search would all see a vault with no content in it.',
          timeout: INDEX_TIMEOUT_MS,
        })
        .toBe(true);
    } catch (e) {
      const m = await probeMetadata(obsidian.page);
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  frontmatter of "${DEEP}": kind=${JSON.stringify(m.frontmatterKind)} ` +
        `(want "beta"), num=${JSON.stringify(m.frontmatterNum)} (want 2)\n` +
        `  tags of "${DEEP}": ${JSON.stringify(m.deepTags)} (want to contain "${TAG_DEEP}")\n` +
        `  resolvedLinks["${DEEPER}"]: ${JSON.stringify(m.deeperResolved)} ` +
        `(want to contain "${ONE}")\n` +
        `  unresolvedLinks["${DEEPER}"]: ${JSON.stringify(m.deeperUnresolved)}\n` +
        `  markdown files with ANY cache entry: ${m.cachedFileCount} of ${m.markdownFileCount}\n` +
        `${await dumpVaultModel(obsidian.page)}`,
      );
    }

    // Asserted individually as well, so a red names the exact layer rather than
    // just reporting "the combined predicate was false".
    const m = await probeMetadata(obsidian.page);
    expect(m.frontmatterKind, `frontmatter.kind of the DEEP note "${DEEP}"`).toBe('beta');
    expect(m.frontmatterNum, `frontmatter.num of the DEEP note "${DEEP}"`).toBe(2);
    expect(m.deepTags, `tags parsed out of the BODY of "${DEEP}"`).toContain(TAG_DEEP);
    expect(
      m.deeperResolved,
      `resolvedLinks["${DEEPER}"] must contain "${ONE}" — a DEEP→DEEP link, neither end ` +
      'of which the old root-only walk could reach',
    ).toContain(ONE);
  });

  /**
   * GRAPH VIEW.
   *
   * WHICH ASSERTION THIS MAKES IS DECIDED AT RUNTIME, AND IT SAYS SO OUT LOUD.
   *
   * The graph's node set lives on an INTERNAL of the core `graph` plugin
   * (`app.workspace.getLeavesOfType('graph')[0].view.renderer.nodes`, each node
   * carrying an `id` that is the file path). That is not public API and it is not
   * in `obsidian.d.ts`, so whether it is reachable in a given Obsidian build is a
   * fact about Obsidian, not about this plugin — and the honest thing is to PROBE
   * for it rather than to assume it.
   *
   *   • PRIMARY (preferred): `renderer.nodes` contains an id for every seeded note.
   *     This is the graph's own state — the strongest statement available short of
   *     reading pixels.
   *   • FALLBACK (only if the renderer is not reachable): the graph leaf opened
   *     WITHOUT error, and every seeded note is a key of
   *     `metadataCache.resolvedLinks` — i.e. the exact structure the graph is BUILT
   *     FROM. This is strictly weaker: it proves the graph's input is complete, not
   *     that the graph drew it.
   *
   * The test prints which branch it took (`[e2e] graph assertion: PRIMARY|FALLBACK`)
   * so a green run can never quietly pass the weaker claim off as the stronger one.
   *
   * ORPHANS: `<S>-orphan.md` has no edges, and "show orphans" is a user-facing graph
   * FILTER. When the engine reports that filter as off, the orphan's absence is
   * correct behaviour and asserting on it would be asserting about a SETTING rather
   * than about the index — so the orphan is asserted only when the filter admits it,
   * and the filter's value is printed either way. The four CONNECTED notes (which
   * include both deep ones) are asserted unconditionally.
   */
  test('3 — graph view shows a node for every note, including the deep ones', async () => {
    await dismissBlockingModals(obsidian.page);
    // "Graph view: Open graph view" — the core `graph` plugin's `graph:open`
    // command. The scaffold enables `graph` in core-plugins.json, so a failure to
    // open is not a missing-plugin problem.
    await runCommandViaPalette(obsidian.page, 'Open graph view');

    await expect
      .poll(() => graphLeafCount(obsidian.page), {
        message:
          'the "Open graph view" command did not open a graph leaf on a remote vault.',
        timeout: ACTION_TIMEOUT_MS,
      })
      .toBeGreaterThan(0);

    // The renderer builds asynchronously off metadataCache, so poll rather than
    // sampling once. `nodeIds === null` means the internal is not reachable at all.
    let graph = await probeGraph(obsidian.page);
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    while (
      Date.now() < deadline
      && graph.nodeIds !== null
      && !ALL_NOTES.every((p) => graph.nodeIds?.includes(p))
    ) {
      await obsidian.page.waitForTimeout(500);
      graph = await probeGraph(obsidian.page);
    }

    const nodeIds = graph.nodeIds;
    if (nodeIds === null) {
      // FALLBACK — announced, never silent.
      console.warn(
        "[e2e] graph assertion: FALLBACK. The graph view's `renderer.nodes` internal was " +
        `not reachable (${graph.why}), so this test asserts the SOURCE OF TRUTH the graph ` +
        'is built from (every seeded note is a key of metadataCache.resolvedLinks) plus ' +
        '"a graph leaf opened without error". That is strictly weaker than asserting the ' +
        'drawn node set, and it is being reported as such.',
      );

      const keys = await resolvedLinkKeys(obsidian.page);
      for (const note of ALL_NOTES) {
        expect(
          keys,
          `metadataCache.resolvedLinks has no entry for "${note}". resolvedLinks is the ` +
          'structure the graph builds its nodes and edges from, so a note missing from it ' +
          'cannot appear in the graph at all.',
        ).toContain(note);
      }
      return;
    }

    console.warn(
      "[e2e] graph assertion: PRIMARY. Asserting on the graph view's own renderer.nodes " +
      `(${nodeIds.length} nodes). showOrphans=${String(graph.showOrphans)}.`,
    );

    // The four notes that have edges. Both deep ones are in here.
    for (const note of [ROOT, ONE, DEEP, DEEPER]) {
      expect(
        nodeIds,
        `the graph has no node for "${note}". The graph enumerates the vault via ` +
        'metadataCache/fileMap, so a missing node means the note is invisible in the one ' +
        'view that is supposed to show the WHOLE vault.\n' +
        `  nodes: ${JSON.stringify(nodeIds.slice(0, 40))}`,
      ).toContain(note);
    }

    // The orphan has no edges, and "show orphans" is a graph FILTER — assert it only
    // when the filter admits orphans, otherwise its absence is the setting doing its
    // job, not the index failing.
    if (graph.showOrphans !== false) {
      expect(
        nodeIds,
        `the graph has no node for the orphan "${ORPHAN}" even though its "show orphans" ` +
        `filter is ${String(graph.showOrphans)}. A note with no links is still a note.`,
      ).toContain(ORPHAN);
    } else {
      console.warn(
        `[e2e] graph: showOrphans is false, so "${ORPHAN}" is filtered out BY SETTING and ` +
        'is not asserted. Every note that HAS an edge is still asserted above.',
      );
    }
  });

  /**
   * "HYPERLINKS WHILE EDITING", part 1 — and NOT a path any existing test covers.
   *
   * `links-metadata.spec.ts` test 4 clicks a link in READING view. Reading view is
   * a rendered HTML pane; Live Preview is CodeMirror 6, a completely different code
   * path, and it is Obsidian's DEFAULT — it is what a user is looking at while they
   * type. The `[[` suggester is the single most-used link affordance there is, and
   * it ranks `vault.getMarkdownFiles()`, so it is a direct readout of whether the
   * background index made the deep tree reachable TO THE EDITOR.
   *
   * A PARTIAL path is typed (`[[<S>-a/b/dee`), so only a real index of the deep
   * tree can complete it.
   */
  test('4 — Live Preview: typing [[ suggests a note in a deep folder', async () => {
    await dismissBlockingModals(obsidian.page);
    await openInLivePreview(obsidian.page, SCRATCH);

    // Click into the editor and put the caret at the end of the note.
    const editor = obsidian.page.locator('.markdown-source-view.mod-cm6 .cm-content').first();
    await editor.click({ timeout: ACTION_TIMEOUT_MS });
    await obsidian.page.keyboard.press('Control+End');

    await obsidian.page.keyboard.type(`[[${B_DIR}/dee`, { delay: 30 });

    const suggestion = obsidian.page
      .locator('.suggestion-container .suggestion-item')
      .filter({ hasText: 'deep' })
      .first();

    try {
      await expect(
        suggestion,
        `typing "[[${B_DIR}/dee" in LIVE PREVIEW offered no suggestion for "${DEEP}". The ` +
        'link suggester ranks vault.getMarkdownFiles(), so this is what a user hits the ' +
        'moment they try to link to a note in a subfolder while editing — the most common ' +
        'linking gesture in Obsidian, and the one the reading-view tests do not touch.',
      ).toBeVisible({ timeout: INDEX_TIMEOUT_MS });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  suggestions on screen: ${JSON.stringify(await suggestionTexts(obsidian.page))}\n` +
        `${await dumpEditor(obsidian.page)}\n${await dumpVaultModel(obsidian.page)}`,
      );
    }

    // Leave the popover closed — a stray suggester would swallow the next test's
    // keystrokes.
    await obsidian.page.keyboard.press('Escape').catch(() => { /* best effort */ });
  });

  /**
   * "HYPERLINKS WHILE EDITING", part 2: FOLLOWING one.
   *
   * Existing coverage clicks links in READING view only. In Live Preview the link is
   * a CodeMirror decoration (`.cm-hmd-internal-link` / `.cm-underline`), not an `<a>`
   * in a rendered pane, and Obsidian attaches its own click handling to it.
   *
   * WHICH GESTURE NAVIGATES: Obsidian's Live Preview follows an internal link on a
   * PLAIN click (Ctrl/Cmd-click is "open in a new tab/split"; in the legacy source
   * mode the modifier IS required). Both are legitimate ways for a user to follow a
   * link, and which one a given Obsidian build wires up is Obsidian's business, not
   * this plugin's — so the test tries the plain click FIRST, falls back to the
   * platform modifier click, and PRINTS which one actually navigated. The ASSERTION
   * is unweakened either way: following an internal link in Live Preview MUST open
   * its target. If neither gesture navigates, that is a red.
   */
  test('5 — Live Preview: clicking an internal link opens the target', async () => {
    await dismissBlockingModals(obsidian.page);
    await openInLivePreview(obsidian.page, ROOT);

    // The first link in <S>-root.md is [[<S>-a/one]]. Anchored on its TEXT, so a
    // reordering of the note cannot silently retarget the assertion.
    const link = obsidian.page
      .locator('.markdown-source-view.mod-cm6 .cm-content .cm-underline')
      .filter({ hasText: `${A_DIR}/one` })
      .first();

    const rendered = await link
      .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!rendered) {
      throw new Error(
        `no rendered internal link for "[[${A_DIR}/one]]" in the LIVE PREVIEW of "${ROOT}" ` +
        `within ${ACTION_TIMEOUT_MS}ms — the wiki link was not even decorated as a link by ` +
        `CodeMirror.\n${await dumpEditor(obsidian.page)}`,
      );
    }

    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    let navigatedBy: string | null = null;

    await link.click({ timeout: ACTION_TIMEOUT_MS });
    if (await waitForActiveFile(obsidian.page, ONE, 8_000)) {
      navigatedBy = 'plain click';
    } else {
      await openInLivePreview(obsidian.page, ROOT);
      await link.click({ timeout: ACTION_TIMEOUT_MS, modifiers: [modifier] });
      if (await waitForActiveFile(obsidian.page, ONE, 8_000)) {
        navigatedBy = `${modifier}+click`;
      }
    }

    if (navigatedBy === null) {
      throw new Error(
        `clicking the "[[${A_DIR}/one]]" link in the LIVE PREVIEW of "${ROOT}" did not open ` +
        `"${ONE}" — neither a plain click nor a ${modifier}+click navigated within 8000ms ` +
        'each. The link is decorated and accepts the click, but does not follow. Following ' +
        'a link while editing is the core navigation gesture of Obsidian.\n' +
        `${await dumpEditor(obsidian.page)}`,
      );
    }

    console.warn(`[e2e] Live Preview link navigation worked via: ${navigatedBy}`);
    expect(await activeFilePath(obsidian.page), 'the active file after following the link')
      .toBe(ONE);
  });

  /**
   * BACKLINKS, deep → deep.
   *
   * `links-metadata.spec.ts` test 3 asserts a backlink between two ROOT notes. This
   * one is between two notes that BOTH live below the root: `<S>-a/one.md` is
   * referred to from `<S>-a/b/c/deeper.md`, three levels down and in a different
   * folder. The old root-only walk could see neither end.
   *
   * The MODEL is the primary assertion: `getBacklinksForFile` is what the backlinks
   * pane, the outgoing-links pane and the graph all read, and asserting it keeps
   * this immune to headless Obsidian's lazy/virtualised sidebar paint under Xvfb
   * (the same reason `waitForShadowVaultLoaded` asserts on the model, not on rows).
   */
  test('6 — backlinks on a deep note list a referrer from a DIFFERENT deep folder', async () => {
    await openInLivePreview(obsidian.page, ONE);

    await expect
      .poll(() => backlinkSourcesFor(obsidian.page, ONE), {
        message:
          `metadataCache.getBacklinksForFile("${ONE}") never listed "${DEEPER}". Both notes ` +
          'live below the root, in different folders, and neither was reachable by the old ' +
          'root-only walk. An empty reverse index means a blank backlinks pane and a missing ' +
          'graph edge for every deep note in the vault.',
        timeout: INDEX_TIMEOUT_MS,
      })
      .toContain(DEEPER);
  });

  /**
   * GLOBAL SEARCH into a deep note.
   *
   * The needle exists in exactly one file in the whole vault, and that file is three
   * folders down. Search is the surface that most obviously reads FILE BODIES:
   * registration alone cannot satisfy it. A green here is therefore independent
   * corroboration of test 2 through a completely different Obsidian subsystem — and,
   * on a remote vault, a lot of SSH traffic, which is why the budget is long.
   */
  test('7 — global search finds text that exists only in a deep note', async () => {
    await dismissBlockingModals(obsidian.page);
    await runCommandViaPalette(obsidian.page, 'Search in all files');

    const input = obsidian.page
      .locator('.workspace-leaf-content[data-type="search"] input')
      .first();
    await expect(input, 'the global-search pane never opened')
      .toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    await input.fill(NEEDLE);

    const hit = obsidian.page
      .locator('.workspace-leaf-content[data-type="search"] .search-result-file-title')
      .filter({ hasText: 'deeper' })
      .first();

    try {
      await expect(
        hit,
        `global search for "${NEEDLE}" — a string that exists in NO other file in the vault ` +
        `— returned no result row for "${DEEPER}". Search reads file bodies, so this is the ` +
        'surface that proves Obsidian is not merely AWARE of the deep note but has actually ' +
        "READ it. To the user, the note's contents simply do not exist.",
      ).toBeVisible({ timeout: INDEX_TIMEOUT_MS });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  result rows on screen: ${JSON.stringify(await searchResultTitles(obsidian.page))}\n` +
        `${await dumpVaultModel(obsidian.page)}`,
      );
    }
  });

  /**
   * QUICK SWITCHER — the "can I even reach this note" test, with NO folder ever
   * expanded anywhere in this spec. The switcher enumerates `vault.fileMap`; before
   * #468, a note in an unexpanded folder was not merely unlinkable, it was
   * UNREACHABLE — the user typed its name and Obsidian told them it did not exist.
   */
  test('8 — Quick Switcher reaches a deep note', async () => {
    // BEFORE the switcher is opened, never after: the switcher is itself a
    // `.modal-container` and the sweep would close it.
    await dismissBlockingModals(obsidian.page);
    await runCommandViaPalette(obsidian.page, 'Open quick switcher');

    const input = obsidian.page
      .locator('.prompt input, input.prompt-input, .suggestion-container input')
      .first();
    await expect(input, 'the Quick Switcher never opened')
      .toBeVisible({ timeout: ACTION_TIMEOUT_MS });
    await input.fill('');
    await obsidian.page.keyboard.type('deeper', { delay: 20 });

    try {
      await expect(
        obsidian.page.locator('.prompt .suggestion-item').filter({ hasText: 'deeper' }).first(),
        `the Quick Switcher offers no suggestion for "${DEEPER}", which is three folders down ` +
        'and which nothing in this spec has ever expanded. The switcher enumerates ' +
        'vault.fileMap: a note that is not in it cannot be reached at all.',
      ).toBeVisible({ timeout: INDEX_TIMEOUT_MS });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  suggestions on screen: ${JSON.stringify(await suggestionTexts(obsidian.page))}\n` +
        `${await dumpVaultModel(obsidian.page)}`,
      );
    }

    await obsidian.page.keyboard.press('Escape').catch(() => { /* best effort */ });
  });

  /**
   * "DOES DATAVIEW WORK." The faithful stand-in.
   *
   * Real Dataview is not installed on purpose — a marketplace download would make CI
   * depend on the network, and the thing under test is not Dataview's code, it is the
   * DATA Dataview is handed. So the fixture plugin does precisely what Dataview's
   * indexer does and nothing else: iterate `vault.getMarkdownFiles()` and call
   * `metadataCache.getFileCache(f)` on each, collecting frontmatter, tags and links.
   * If that pair of calls returns the whole vault WITH its content, every plugin of
   * that class works; if it returns a truncated or content-less view, they all break
   * in the same way.
   *
   * The scan is triggered FROM THE TEST (`window.__E2E_DV_SCAN__()`), not taken from
   * `onload()`. At onload the background index has barely begun, so an onload-time
   * snapshot would be a snapshot of an empty vault and would prove nothing about the
   * steady state — while also being exactly the trap a real plugin falls into.
   */
  test('9 — a Dataview-CLASS plugin sees the whole vault', async () => {
    const loaded = await obsidian.page.evaluate((id: string) => {
      const app = (window as unknown as {
        app?: { plugins?: { plugins?: Record<string, unknown> } };
      }).app;
      return {
        registered: Boolean(app?.plugins?.plugins?.[id]),
        ids: Object.keys(app?.plugins?.plugins ?? {}),
        hasScan:
          typeof (window as unknown as { __E2E_DV_SCAN__?: unknown }).__E2E_DV_SCAN__
          === 'function',
      };
    }, DV_ID);

    expect(
      loaded.registered,
      `the Dataview-class fixture plugin '${DV_ID}' was never loaded by the shadow vault ` +
      `(loaded: ${loaded.ids.join(', ') || 'none'}). It was seeded on the REMOTE and named ` +
      'in the remote enabled list, so the connect-time plugin round-trip should have staged ' +
      'it and the relaunch should have run it. Without that, this test cannot say anything ' +
      'about whether a third-party plugin sees the vault.',
    ).toBe(true);
    expect(loaded.hasScan, `'${DV_ID}' loaded but never installed its scan hook`).toBe(true);

    // Poll the plugin's OWN view of the vault until it settles — the background index
    // and the metadata reads behind it are still landing.
    let view = await runDataviewScan(obsidian.page);
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    while (Date.now() < deadline && !ALL_NOTES.every((p) => p in view.files)) {
      await obsidian.page.waitForTimeout(500);
      view = await runDataviewScan(obsidian.page);
    }

    for (const note of ALL_NOTES) {
      expect(
        Object.keys(view.files),
        'a Dataview-class plugin — iterating vault.getMarkdownFiles() and calling ' +
        `metadataCache.getFileCache() on each — does not see "${note}". Every plugin of that ` +
        'class (Dataview, Templater, Tasks, Omnisearch…) reads the vault exactly this way, ' +
        'so a note missing here is missing from all of them.',
      ).toContain(note);
    }

    const deep = view.files[DEEP];
    expect(
      deep?.frontmatter?.kind,
      `the plugin SEES "${DEEP}" but gets no frontmatter for it. A Dataview query like ` +
      '`WHERE kind = "beta"` would silently return nothing — the worst kind of failure, ' +
      'because the note is listed and its data is not.',
    ).toBe('beta');
    expect(deep?.frontmatter?.num, `frontmatter.num of "${DEEP}" as the plugin sees it`).toBe(2);
    expect(
      deep?.tags,
      `the plugin gets no "${TAG_DEEP}" tag for "${DEEP}" — a tag-driven query would miss it`,
    ).toContain(TAG_DEEP);

    expect(
      view.files[DEEPER]?.links,
      `the plugin sees no outgoing links for "${DEEPER}" — link-graph queries over the deep ` +
      'part of the vault would come back empty',
    ).toContain(`${A_DIR}/one`);
  });

  /**
   * NOT AN ASSERTION ABOUT SPEED — a MEASUREMENT, and the maintainer needs it.
   *
   * `BackgroundIndexer` logs its own cost ("Nf + Md indexed in Xms") and that number
   * is only the REGISTRATION cost. The cost the user actually feels is registration
   * PLUS Obsidian's metadataCache reading every markdown file it was just told about
   * — one SSH round-trip each, through the patched adapter, for the whole vault. That
   * second phase is invisible to the plugin: it does not schedule it, cannot batch it,
   * and has no idea when it finishes.
   *
   * This fixture is six notes, so the absolute numbers below mean nothing on their
   * own. What they show is the SHAPE: how far apart "the tree is registered" and "the
   * deepest note's content is queryable" are. On a 5,000-note vault the first is one
   * paginated walk and the second is 5,000 reads — and that ratio is what decides
   * whether Dataview looks broken for ten seconds or for ten minutes after a connect.
   * Deliberately no timing threshold: one tuned on a six-file fixture would be a lie,
   * and a flaky one.
   *
   * The two expectations at the end are NOT weaker copies of tests 1 and 2 — they are
   * the guard that stops this test reporting a number it never measured.
   */
  test('10 — report how long the full index takes', async () => {
    const registration = allFilesAt === null ? null : allFilesAt - connectStartedAt;
    const content = deepMetadataAt === null ? null : deepMetadataAt - connectStartedAt;

    console.warn(
      `[e2e] ── remote-vault index timing ${'─'.repeat(40)}\n` +
      `[e2e]   fixture: ${ALL_NOTES.length} markdown notes, deepest at "${DEEPER}"\n` +
      '[e2e]   t0 = the moment the shadow Obsidian was launched (the connect lands at\n' +
      '[e2e]        layout-ready, so this is the wall time a user actually waits)\n' +
      `[e2e]   all ${ALL_NOTES.length} files in vault.fileMap ....... ` +
      `${registration === null ? 'NEVER (test 1 failed)' : `${registration} ms`}\n` +
      '[e2e]   metadata for the DEEPEST file ready .. ' +
      `${content === null ? 'NEVER (test 2 failed)' : `${content} ms`}\n` +
      (registration !== null && content !== null
        ? `[e2e]   → the metadataCache phase added ${content - registration} ms on top of\n` +
          '[e2e]     registration, for SIX files. It reads every markdown file in the vault\n' +
          '[e2e]     over SSH, and BackgroundIndexer neither drives nor measures it.\n'
        : '') +
      `[e2e] ${'─'.repeat(72)}`,
    );

    expect(
      registration,
      'test 1 never saw all files registered, so there is nothing to time',
    ).not.toBeNull();
    expect(
      content,
      'test 2 never saw the deep metadata land, so there is nothing to time',
    ).not.toBeNull();
  });
});

// ─── the Dataview-class fixture plugin's onload() body ─────────────────────────

/**
 * What a Dataview-class plugin DOES, reduced to its essence: walk
 * `vault.getMarkdownFiles()`, ask `metadataCache.getFileCache()` for each, keep the
 * frontmatter / tags / links.
 *
 * Exposed as `window.__E2E_DV_SCAN__()` so the TEST decides when to run it. A
 * snapshot taken at `onload()` would be taken while the vault is still filling —
 * which is precisely the bug a real plugin hits, and precisely the thing that would
 * make this test prove nothing. It also re-scans on a registered interval (so
 * Obsidian tears it down with the plugin) and seeds `window.__E2E_DV__` once at load,
 * so the global is always present and never stale.
 *
 * Written as a string because it is compiled into the fixture plugin's `main.js` by
 * `makeFakePlugin`. It runs inside `async onload()`, so `this` is the Plugin.
 */
function dataviewProbeBody(): string {
  return [
    'const scan = () => {',
    '  const files = this.app.vault.getMarkdownFiles();',
    '  const out = {};',
    '  for (const f of files) {',
    '    const cache = this.app.metadataCache.getFileCache(f) || {};',
    '    out[f.path] = {',
    '      frontmatter: cache.frontmatter || null,',
    '      tags: (cache.tags || []).map((t) => t.tag),',
    '      links: (cache.links || []).map((l) => l.link),',
    '    };',
    '  }',
    '  window.__E2E_DV__ = { at: Date.now(), count: files.length, files: out };',
    '  return window.__E2E_DV__;',
    '};',
    'window.__E2E_DV_SCAN__ = scan;',
    'scan();',
    'this.registerInterval(window.setInterval(scan, 2000));',
  ].join('\n    ');
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fail `work` at `ms` instead of letting it run to the test timeout.
 *
 * Scoped deliberately to `page.evaluate`, which has NO timeout of its own: a wedged
 * renderer never answers, and an `expect.poll` cannot time out while its own probe is
 * stuck inside one. NOT used around clicks — `actionTimeout` already bounds those,
 * and Playwright's own "…intercepts pointer events" diagnostic is strictly better
 * evidence than anything a deadline wrapper could synthesise.
 *
 * A late rejection from `work` is absorbed so it cannot resurface as an unhandled
 * rejection after the race is over.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  void work.catch(() => { /* the race below already reports it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `${what} did not settle within ${ms}ms — the Obsidian renderer stopped answering.`,
      )),
      ms,
    );
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** `vault.getMarkdownFiles().map(f => f.path)` — the set every surface enumerates. */
async function markdownPaths(page: Page): Promise<string[]> {
  return withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: { vault?: { getMarkdownFiles?: () => Array<{ path: string }> } };
      }).app;
      return (app?.vault?.getMarkdownFiles?.() ?? []).map((f) => f.path);
    }),
    EVAL_TIMEOUT_MS,
    'markdownPaths()',
  );
}

interface MetadataProbe {
  frontmatterKind: unknown;
  frontmatterNum: unknown;
  deepTags: string[];
  deeperResolved: string[];
  deeperUnresolved: string[];
  /** Markdown files with ANY metadataCache entry — the read phase's progress. */
  cachedFileCount: number;
  markdownFileCount: number;
}

/**
 * Every fact test 2 needs, read in ONE evaluate so they are mutually consistent. A
 * poll that fetched them separately could catch the cache mid-update and report a
 * state that never actually existed.
 */
async function probeMetadata(page: Page): Promise<MetadataProbe> {
  return withDeadline(
    page.evaluate(({ deep, deeper }) => {
      interface Cache {
        frontmatter?: Record<string, unknown>;
        tags?: Array<{ tag: string }>;
      }
      const app = (window as unknown as {
        app?: {
          vault?: {
            getAbstractFileByPath?: (p: string) => unknown;
            getMarkdownFiles?: () => Array<{ path: string }>;
          };
          metadataCache?: {
            getFileCache?: (f: unknown) => Cache | null;
            resolvedLinks?: Record<string, Record<string, number>>;
            unresolvedLinks?: Record<string, Record<string, number>>;
          };
        };
      }).app;
      const vault = app?.vault;
      const mc = app?.metadataCache;

      const deepFile = vault?.getAbstractFileByPath?.(deep);
      const cache = deepFile ? mc?.getFileCache?.(deepFile) ?? null : null;

      const md = vault?.getMarkdownFiles?.() ?? [];
      let cached = 0;
      for (const f of md) {
        if (mc?.getFileCache?.(f)) cached++;
      }

      return {
        frontmatterKind: cache?.frontmatter?.kind,
        frontmatterNum: cache?.frontmatter?.num,
        deepTags: (cache?.tags ?? []).map((t) => t.tag),
        deeperResolved: Object.keys(mc?.resolvedLinks?.[deeper] ?? {}),
        deeperUnresolved: Object.keys(mc?.unresolvedLinks?.[deeper] ?? {}),
        cachedFileCount: cached,
        markdownFileCount: md.length,
      };
    }, { deep: DEEP, deeper: DEEPER }),
    EVAL_TIMEOUT_MS,
    'probeMetadata()',
  );
}

/** `Object.keys(metadataCache.resolvedLinks)` — the structure the graph is built from. */
async function resolvedLinkKeys(page: Page): Promise<string[]> {
  return withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: { metadataCache?: { resolvedLinks?: Record<string, unknown> } };
      }).app;
      return Object.keys(app?.metadataCache?.resolvedLinks ?? {});
    }),
    EVAL_TIMEOUT_MS,
    'resolvedLinkKeys()',
  );
}

/** How many `graph` leaves the workspace currently holds. */
async function graphLeafCount(page: Page): Promise<number> {
  return withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: { workspace?: { getLeavesOfType?: (t: string) => unknown[] } };
      }).app;
      return (app?.workspace?.getLeavesOfType?.('graph') ?? []).length;
    }),
    EVAL_TIMEOUT_MS,
    'graphLeafCount()',
  ).catch(() => 0);
}

interface GraphProbe {
  /** Node ids off the graph's own renderer, or `null` when that internal is unreachable. */
  nodeIds: string[] | null;
  /** The graph engine's "show orphans" filter, when it can be read. */
  showOrphans: boolean | null;
  /** WHY `nodeIds` is null — quoted into the fallback warning. */
  why: string;
}

/**
 * Reach for the graph view's OWN node set.
 *
 * `renderer.nodes` is an Obsidian INTERNAL (not in `obsidian.d.ts`), so this probe
 * reports honestly whether it found it rather than throwing — test 3 then decides
 * which assertion it is entitled to make, and says which one it made.
 */
async function probeGraph(page: Page): Promise<GraphProbe> {
  return withDeadline(
    page.evaluate(() => {
      interface Engine { options?: { showOrphans?: boolean } }
      interface GraphView {
        renderer?: { nodes?: Array<{ id?: unknown }> };
        dataEngine?: Engine;
        engine?: Engine;
      }
      const app = (window as unknown as {
        app?: { workspace?: { getLeavesOfType?: (t: string) => Array<{ view?: GraphView }> } };
      }).app;
      const leaves = app?.workspace?.getLeavesOfType?.('graph') ?? [];
      if (leaves.length === 0) {
        return { nodeIds: null, showOrphans: null, why: 'no graph leaf is open' };
      }

      const view = leaves[0]?.view;
      const engine = view?.dataEngine ?? view?.engine;
      const showOrphans = typeof engine?.options?.showOrphans === 'boolean'
        ? engine.options.showOrphans
        : null;

      const nodes = view?.renderer?.nodes;
      if (!Array.isArray(nodes)) {
        return {
          nodeIds: null,
          showOrphans,
          why: 'the graph leaf is open but view.renderer.nodes is not an array (view keys: '
            + `${Object.keys(view ?? {}).slice(0, 15).join(',')})`,
        };
      }

      return {
        nodeIds: nodes
          .map((n) => n?.id)
          .filter((id): id is string => typeof id === 'string'),
        showOrphans,
        why: '',
      };
    }),
    EVAL_TIMEOUT_MS,
    'probeGraph()',
  ).catch((e: unknown) => ({
    nodeIds: null,
    showOrphans: null,
    why: `probe threw: ${e instanceof Error ? e.message : String(e)}`,
  }));
}

interface DataviewFileView {
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  links: string[];
}

interface DataviewView {
  count: number;
  files: Record<string, DataviewFileView>;
}

/**
 * Trigger the fixture plugin's scan and read back what IT sees — not what the test
 * can see. The whole point is to look at the vault through a third-party plugin's
 * eyes (`getMarkdownFiles()` + `getFileCache()`), so the test must not substitute
 * its own probe for the plugin's.
 */
async function runDataviewScan(page: Page): Promise<DataviewView> {
  return withDeadline(
    page.evaluate(() => {
      const scan = (window as unknown as {
        __E2E_DV_SCAN__?: () => { count?: number; files?: Record<string, unknown> };
      }).__E2E_DV_SCAN__;
      const result = typeof scan === 'function' ? scan() : null;
      return {
        count: result?.count ?? 0,
        files: (result?.files ?? {}) as Record<string, DataviewFileView>,
      };
    }),
    EVAL_TIMEOUT_MS,
    'runDataviewScan()',
  ).catch(() => ({ count: 0, files: {} }));
}

/** `app.workspace.getActiveFile()?.path` — what the user is actually looking at. */
async function activeFilePath(page: Page): Promise<string | null> {
  return withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: { workspace?: { getActiveFile?: () => { path?: string } | null } };
      }).app;
      return app?.workspace?.getActiveFile?.()?.path ?? null;
    }),
    EVAL_TIMEOUT_MS,
    'activeFilePath()',
  );
}

/** Poll `getActiveFile()` for `path`, bounded. Returns whether it arrived. */
async function waitForActiveFile(
  page: Page,
  notePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await activeFilePath(page).catch(() => null)) === notePath) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

/**
 * Open `notePath` in LIVE PREVIEW (`mode: 'source'` + `source: false` — the CM6
 * editor WITH decorations, which is Obsidian's default and what a user types in),
 * then wait until the workspace agrees.
 *
 * Opened through `workspace.openFile` rather than by clicking a File Explorer row,
 * for two reasons that are both load-bearing:
 *
 *   1. A deep note HAS NO ROW until its folder is expanded, and expanding a folder is
 *      the one gesture this spec must never make — it would invoke `LazyFolderLoader`
 *      and materialise the subtree by hand, which is exactly what the background index
 *      is supposed to have already done. (`openFile` goes nowhere near that hook: the
 *      product's lazy-expand trigger is a delegated click listener on
 *      `.nav-folder-title`.)
 *   2. The leaf's view mode must be Live Preview DETERMINISTICALLY, not "whatever the
 *      previous test left the leaf in". `Toggle reading view` is a toggle and would
 *      flip the wrong way half the time.
 *
 * The gesture under test in tests 4 and 5 is the typing and the clicking. Getting to
 * the note is not the gesture.
 */
async function openInLivePreview(page: Page, notePath: string): Promise<void> {
  const err = await withDeadline(
    page.evaluate(async (p: string) => {
      interface Leaf { openFile?: (f: unknown, s?: unknown) => Promise<void> }
      const app = (window as unknown as {
        app?: {
          vault?: { getAbstractFileByPath?: (p: string) => unknown };
          workspace?: { getLeaf?: (n?: boolean) => Leaf | null };
        };
      }).app;
      const file = app?.vault?.getAbstractFileByPath?.(p);
      if (!file) return `"${p}" is not in vault.fileMap — nothing to open`;
      const leaf = app?.workspace?.getLeaf?.(false);
      if (!leaf?.openFile) return 'app.workspace.getLeaf(false) gave no openFile';
      try {
        // mode 'source' + source:false === Live Preview. (mode 'source' +
        // source:true is the legacy plain-text source mode; mode 'preview' is
        // reading view, which the existing specs already cover.)
        await leaf.openFile(file, { state: { mode: 'source', source: false } });
        return null;
      } catch (e) {
        return String(e);
      }
    }, notePath),
    EVAL_TIMEOUT_MS,
    `openInLivePreview("${notePath}")`,
  );
  if (err !== null) {
    throw new Error(
      `openInLivePreview("${notePath}") failed: ${err}\n${await dumpVaultModel(page)}`,
    );
  }

  await expect
    .poll(() => activeFilePath(page), {
      message: `"${notePath}" never became the active file after workspace.openFile`,
      timeout: ACTION_TIMEOUT_MS,
    })
    .toBe(notePath);

  // Live Preview must actually be on screen. If Obsidian cannot put a REMOTE note
  // into its default EDITING mode at all, every "while editing" claim below would be
  // vacuous — so this is asserted, not assumed.
  await expect(
    page.locator('.markdown-source-view.mod-cm6 .cm-content').first(),
    `"${notePath}" is the active file but no CM6 editor is on screen — the note never ` +
    "entered Live Preview, which is Obsidian's default editing mode",
  ).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
}

/**
 * Source paths that link INTO `targetPath`, straight from
 * `metadataCache.getBacklinksForFile(tfile).data` — the structure the backlinks pane
 * renders. `.data` is a `Map` on current Obsidian and a plain object on older builds;
 * both shapes are handled rather than pinned, because which one we get is an
 * Obsidian-version detail with no bearing on the behaviour under test.
 */
async function backlinkSourcesFor(page: Page, targetPath: string): Promise<string[]> {
  return withDeadline(
    page.evaluate((p: string) => {
      const app = (window as unknown as {
        app?: {
          vault?: { getAbstractFileByPath?: (path: string) => unknown };
          metadataCache?: {
            getBacklinksForFile?: (file: unknown) => { data?: unknown } | undefined;
          };
        };
      }).app;
      const tfile = app?.vault?.getAbstractFileByPath?.(p);
      if (!tfile) return [];
      const data = app?.metadataCache?.getBacklinksForFile?.(tfile)?.data;
      if (!data) return [];
      const asMap = data as { keys?: () => Iterable<string> };
      if (typeof asMap.keys === 'function') return Array.from(asMap.keys());
      return Object.keys(data as Record<string, unknown>);
    }, targetPath),
    EVAL_TIMEOUT_MS,
    `backlinkSourcesFor("${targetPath}")`,
  );
}

/** Whatever suggester (palette / switcher / `[[` popover) is currently on screen. */
async function suggestionTexts(page: Page): Promise<string[]> {
  return withDeadline(
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.suggestion-item'))
        .map((el) => (el.textContent ?? '').trim())
        .slice(0, 20)),
    EVAL_TIMEOUT_MS,
    'suggestionTexts()',
  ).catch(() => []);
}

/** The file rows the global-search pane is currently showing. */
async function searchResultTitles(page: Page): Promise<string[]> {
  return withDeadline(
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.search-result-file-title'))
        .map((el) => (el.textContent ?? '').trim())
        .slice(0, 20)),
    EVAL_TIMEOUT_MS,
    'searchResultTitles()',
  ).catch(() => []);
}

/**
 * What the vault model actually holds. A bare "element not found" cannot separate
 * "the index never registered it" from "it IS registered and the UI has not painted
 * it"; this can, in one CI round.
 */
async function dumpVaultModel(page: Page): Promise<string> {
  const state = await withDeadline(
    page.evaluate((stamp: string) => {
      const app = (window as unknown as {
        app?: {
          vault?: {
            fileMap?: Record<string, unknown>;
            getMarkdownFiles?: () => Array<{ path: string }>;
          };
          metadataCache?: { resolvedLinks?: Record<string, unknown> };
        };
      }).app;
      const keys = Object.keys(app?.vault?.fileMap ?? {});
      return {
        fileMapKeys: keys.length,
        seeded: keys.filter((k) => k.startsWith(stamp)).slice(0, 20),
        markdownFiles: (app?.vault?.getMarkdownFiles?.() ?? []).length,
        resolvedLinkKeys: Object.keys(app?.metadataCache?.resolvedLinks ?? {}).length,
        sample: keys.slice(0, 25),
      };
    }, STAMP),
    EVAL_TIMEOUT_MS,
    'dumpVaultModel()',
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `vault model: ${JSON.stringify(state)}`;
}

/** Editor state for the Live-Preview tests: which panes exist, what got decorated. */
async function dumpEditor(page: Page): Promise<string> {
  const state = await withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: { workspace?: { getActiveFile?: () => { path?: string } | null } };
      }).app;
      return {
        cm6Panes: document.querySelectorAll('.markdown-source-view.mod-cm6').length,
        livePreviewPanes: document.querySelectorAll(
          '.markdown-source-view.is-live-preview',
        ).length,
        previewPanes: document.querySelectorAll('.markdown-preview-view').length,
        linkDecorations: Array.from(
          document.querySelectorAll(
            '.cm-content .cm-underline, .cm-content .cm-hmd-internal-link',
          ),
        ).map((el) => (el.textContent ?? '').trim()).slice(0, 10),
        suggestionItems: document.querySelectorAll('.suggestion-item').length,
        activeFile: app?.workspace?.getActiveFile?.()?.path ?? null,
      };
    }),
    EVAL_TIMEOUT_MS,
    'dumpEditor()',
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `editor state: ${JSON.stringify(state)}`;
}
