import { test, expect, type Page } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  findShadowVaultPath,
  waitForShadowVaultLoaded,
  runCommandViaPalette,
  dismissBlockingModals,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';

/**
 * Wiki links, backlinks, and the metadata cache over a remote vault.
 *
 * Nothing in the suite covers Obsidian's METADATA layer today. Every existing
 * spec stops at "the bytes are on the remote" / "the row is in the File
 * Explorer". But a vault whose files exist and whose links do not resolve is
 * not a working Obsidian — links, backlinks, graph, and Quick Switcher are the
 * product. This file asserts that layer end-to-end, against a real remote.
 *
 * ── THE DEFECT THESE TESTS ENCODE ────────────────────────────────────────────
 *
 * `src/main.ts:972-973` (`populateVaultFromRemote`):
 *
 *     const lazy = this.settings.lazyFolderLoad !== false;
 *     const walk = await walker.walk('', !lazy);
 *
 * `lazyFolderLoad` DEFAULTS TO TRUE (`src/constants.ts:51`), so the connect-time
 * walk is NON-RECURSIVE: only the ROOT's immediate children are walked, and
 * `VaultModelBuilder.insertFile` is therefore never called for anything living
 * in a subfolder. Those files are absent from `app.vault.fileMap` ENTIRELY —
 * not "present but unloaded", simply not there.
 *
 * Obsidian's `metadataCache` resolves `[[wiki links]]` against `fileMap` and
 * nothing else. A link whose target is missing from `fileMap` cannot resolve;
 * it lands in `unresolvedLinks` instead, produces no backlink, no graph edge,
 * and its target cannot be reached from the Quick Switcher. So on a stock
 * (default-settings) connection, EVERY note in EVERY subfolder is invisible to
 * Obsidian's whole knowledge layer until the user happens to CLICK that folder
 * in the File Explorer — the only thing that deepens the tree is the delegated
 * `.nav-folder-title` click hook at `src/main.ts:919-928`, which calls
 * `LazyFolderLoader.loadFolder`.
 *
 * That is the trade the lazy walk made — a fast connect on a huge vault — and
 * it silently bought it by starving the metadata cache.
 *
 * ── WHICH TESTS ARE EXPECTED RED, AND WHAT THE FIX IS ────────────────────────
 *
 * Tests 1-4 and 7 (root-level links) should PASS: the root IS walked.
 * Tests 5, 6b and 8 (anything below the root) are PREDICTED RED. They are
 * written at FULL STRENGTH on purpose. They are not flaky, not aspirational,
 * and MUST NOT be weakened, quarantined, or `.fixme`d to get the suite green —
 * a green suite here would mean the suite is lying about a user-facing data
 * defect ("my links are broken", "my note is not findable").
 *
 * The fix belongs in the PRODUCT, and there are exactly two shapes of it:
 *
 *   (a) EAGER / BACKGROUND FULL INDEX — keep the fast lazy first paint, then
 *       walk the rest of the tree in the background and feed it to
 *       `VaultModelBuilder`, so `fileMap` eventually holds the whole vault; or
 *   (b) METADATA INVALIDATION ON LAZY INSERT — if the tree stays lazy, a late
 *       `LazyFolderLoader` insert must tell Obsidian to re-resolve links against
 *       the enlarged `fileMap`.
 *
 * Test 6 is the discriminator between those two and is written as two strict
 * halves: (a) expanding the folder DOES get the file into `fileMap` (the lazy
 * loader itself works), and (b) after that late insert, the link in a note that
 * was already indexed resolves. If 6a goes green and 6b stays red, nothing
 * re-runs link resolution after a lazy insert, and fix (b) alone is not enough
 * — the maintainer needs (a), or (a) + (b).
 *
 * ── TWO FIXTURE SUBFOLDERS, NOT ONE ──────────────────────────────────────────
 *
 * These tests share ONE Obsidian session and run in declaration order, so state
 * LEAKS FORWARD: test 6 expands `<S>-sub`, which permanently inserts
 * `<S>-sub/Deep.md` into `fileMap` for every test after it. Test 8 ("a note in
 * an UNEXPANDED subfolder is reachable from the Quick Switcher") therefore
 * cannot use `<S>-sub` — it would be asserting against a folder that test 6 has
 * already expanded, and any green it reported would be an artefact of test
 * ORDER rather than a fact about the product. So test 8 gets its own fixture,
 * `<S>-sub2/Deep2.md`, seeded before connect and expanded by NOBODY.
 *
 * ── WHY EVERY GESTURE CARRIES AN EXPLICIT TIMEOUT ────────────────────────────
 *
 * `playwright.config.ts` now sets `actionTimeout: 30_000`, so a click on an
 * element that never becomes actionable FAILS with Playwright's own locator
 * diagnostic (which resolved element, what covered it) instead of blocking until
 * the test timeout. That diagnostic is the single most useful artefact a red run
 * here can produce, so the gestures below keep their own, TIGHTER bounds only
 * where a faster verdict is worth more than the extra retry window — and they
 * always let Playwright's message propagate rather than replacing it.
 *
 * `page.evaluate` still has NO timeout of its own: a wedged renderer never
 * answers, and an `expect.poll` cannot time out while its own probe is stuck
 * inside one. That is what `withDeadline` below is for, and it is used ONLY on
 * evaluates, never to wrap a click.
 *
 * ── AN OPEN MODAL SWALLOWS EVERY CLICK ───────────────────────────────────────
 *
 * Dismissing the trust dialog makes Obsidian auto-open its Settings dialog on
 * the Community-plugins tab (see `dismissBlockingModals`). That `.modal-container`
 * covers the whole window and intercepts pointer events, so the File Explorer
 * and the rendered link are un-clickable while it is up — the model-level tests
 * (1, 2, 3) pass and only the gesture tests (4, 6, 8) fail, which is a very
 * misleading signature. `dismissBlockingModals` is therefore called after the
 * shadow vault is up and again before every click sequence. It is a HARNESS fix
 * (Playwright cannot click a covered element); it weakens no assertion, and it
 * logs whatever it closed.
 *
 * HARD-FAILS, never skips.
 */

const STAMP = Date.now().toString(36);

// ── remote fixtures (seeded BEFORE connect, so the connect walk sees them) ────
const A = `${STAMP}-A.md`;           // root note that links to B (root)
const B = `${STAMP}-B.md`;           // root link target
const C = `${STAMP}-C.md`;           // root note that links INTO the subfolder
const D = `${STAMP}-D.md`;           // created LIVE, after connect (test 7)
const SUB = `${STAMP}-sub`;          // subfolder — never walked at connect
const DEEP = `${SUB}/Deep.md`;       // the note the whole defect is about
const DEEP_LINKTEXT = `${SUB}/Deep`; // exactly what the `[[...]]` in C contains

// A SECOND subfolder, reserved for test 8 and expanded by nobody — see "TWO
// FIXTURE SUBFOLDERS" above. Test 6 expands SUB, so SUB can no longer stand for
// "a folder the user has never opened" once test 6 has run.
const SUB2 = `${STAMP}-sub2`;
const DEEP2 = `${SUB2}/Deep2.md`;

// Indexing is asynchronous (Obsidian re-resolves links off its own queue), so
// every metadata assertion polls. 20 s is far past the observed settle time on a
// warm connection; it exists so a RED is a real defect, not a slow machine.
const META_TIMEOUT_MS = 20_000;

/**
 * Budget for ONE UI gesture (a click; waiting for a row to paint). Tighter than
 * the config's `actionTimeout: 30_000` on purpose: several gestures stack up
 * inside one test, and 15 s is already far past the observed settle time for a
 * row that is going to become actionable at all. Playwright's own failure text
 * (including "…subtree intercepts pointer events" and the offending element) is
 * always propagated into the thrown error, never replaced by it.
 */
const ACTION_TIMEOUT_MS = 15_000;

/**
 * Budget for ONE `page.evaluate`. `page.evaluate` has no timeout of its own: if
 * the renderer's main thread is wedged (say, a lazy folder load blocking on
 * SSH), a probe inside an `expect.poll` never returns and the poll's own timeout
 * can never fire — the hang wins. Bounding the evaluate makes "the renderer
 * stopped answering" a fast, named failure.
 */
const EVAL_TIMEOUT_MS = 10_000;

/** Test 6's expand + the post-insert settle of the vault model. */
const EXPAND_TIMEOUT_MS = 30_000;

/** Test 6's two polls. Short enough that BOTH verdicts fit inside the test. */
const DISCRIMINATOR_TIMEOUT_MS = 25_000;

let obsidian: ObsidianHandle;
let scaffold: ScaffoldResult;
let remote: RemoteVerifier;
let shadowVaultPath: string;

test.beforeAll(async () => {
  test.setTimeout(180_000);

  // HARD-FAIL, never skip: a down sshd is a broken harness and a broken connect
  // is a broken plugin. Both must be red, not green-by-skipping.
  await assertSshdReachable();

  remote = new RemoteVerifier();
  if (!(await remote.connect())) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though the ' +
      'port is open. This spec hard-fails rather than skipping.',
    );
  }

  // Seed BEFORE the connect. The whole point is what the connect-time walk does
  // (and does not) put into `vault.fileMap`; a fixture written after connect
  // would arrive via the live `fs.watch` → ChangeListener path instead and would
  // not exercise the walk at all. (Test 7 deliberately uses that other path.)
  await remote.writeFile(A, `# A\n\n[[${STAMP}-B]]\n`);
  await remote.writeFile(B, '# B\n');
  await remote.mkdirp(SUB);
  await remote.writeFile(DEEP, '# Deep\n');
  await remote.writeFile(C, `# C\n\n[[${DEEP_LINKTEXT}]]\n`);
  await remote.mkdirp(SUB2);
  await remote.writeFile(DEEP2, '# Deep2\n');

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // Building blocks rather than `connectAndOpenShadow`, so we keep hold of the
  // shadow vault PATH — `waitForShadowVaultLoaded` needs its log path.
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);

  // `launchObsidian` returns once the PLUGIN has loaded; the SSH connect, the
  // adapter patch and `populateVaultFromRemote` all land later, at layout-ready.
  // Every assertion below is about what that populate produced, so we must not
  // race it.
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

  // `launchObsidian` dismissed the trust dialog, and Obsidian answered that by
  // auto-opening its Settings dialog on the Community-plugins tab. It is a
  // full-window `.modal-container.mod-dim` and it intercepts pointer events, so
  // nothing in the File Explorer can be clicked until it is gone. Anything it
  // closes gets logged.
  await dismissBlockingModals(obsidian.page);
});

test.afterAll(async () => {
  await obsidian?.cleanup();
  if (remote) {
    await Promise.allSettled([
      remote.removeFile(A),
      remote.removeFile(B),
      remote.removeFile(C),
      remote.removeFile(D),
    ]);
    await remote.rmrf(SUB).catch(() => { /* best effort */ });
    await remote.rmrf(SUB2).catch(() => { /* best effort */ });
    await remote.disconnect();
  }
  scaffold?.cleanup();
});

test.beforeEach(() => {
  // A remote round-trip plus asynchronous re-indexing; the config's default
  // 120 s gets tight once several polls stack up inside one test.
  test.setTimeout(180_000);
});

test.describe('wiki links, backlinks + metadata cache over a remote vault', () => {
  /**
   * FIRST for a reason: if the metadata cache never indexes the virtual vault
   * AT ALL, that is a much larger finding than the lazy-folder defect and it
   * makes every other test in this file moot. This is the canary.
   */
  test('1 — a root-level wiki link to an existing remote note RESOLVES', async () => {
    await expect
      .poll(async () => (await probeLinks(obsidian.page, A, B)).resolved, {
        message:
          `metadataCache.resolvedLinks["${A}"] never contained "${B}". Both notes are ` +
          'at the ROOT of the remote vault, which the connect walk DOES cover — so if ' +
          'this is red, the metadata cache is not indexing the virtual vault at all ' +
          '(a bigger defect than the lazy-folder one the rest of this file is about).',
        timeout: META_TIMEOUT_MS,
      })
      .toContain(B);
  });

  test('2 — unresolved-link count is 0 for a link whose target EXISTS on the remote', async () => {
    // The mirror image of test 1, and not redundant with it: a link can be BOTH
    // resolved and (stale-ly) listed as unresolved, and a note rendering a
    // dangling-link style is broken to the user even if `resolvedLinks` is right.
    await expect
      .poll(async () => (await probeLinks(obsidian.page, A, B)).unresolved, {
        message:
          `metadataCache.unresolvedLinks["${A}"] is not empty — Obsidian still thinks ` +
          `the link to "${B}" is dangling even though that note exists on the remote.`,
        timeout: META_TIMEOUT_MS,
      })
      .toEqual([]);
  });

  test('3 — the backlink appears on the target note', async () => {
    // The MODEL assertion is the primary one: `getBacklinksForFile` is what the
    // backlinks pane, the graph and the outgoing-links pane all read. Asserting
    // the model (not the pane's DOM) keeps this immune to headless Obsidian's
    // lazy/virtualised sidebar paint under Xvfb — the same reason
    // `waitForShadowVaultLoaded` asserts on the model rather than on nav rows.
    await expect
      .poll(() => backlinkSourcesFor(obsidian.page, B), {
        message:
          `metadataCache.getBacklinksForFile("${B}") never listed "${A}" as a source. ` +
          'The forward link resolves (test 1) but the reverse index is empty — the ' +
          'backlinks pane and the graph would both be blank for this note.',
        timeout: META_TIMEOUT_MS,
      })
      .toContain(A);
  });

  /**
   * The end-to-end user GESTURE, not just the index: open A, switch to Reading
   * view (Obsidian's default is LIVE PREVIEW — a CodeMirror mode in which
   * `.markdown-preview-view` does not exist; see reflect.spec.ts test 5), then
   * click the rendered anchor and assert the workspace actually navigated.
   *
   * Each step is bounded and each failure dumps the reading-view state: does a
   * preview pane exist, how many `a.internal-link` are inside it and what do they
   * point at, what mode is the leaf in, what is `getActiveFile()`. Playwright's
   * own click diagnostic is folded into that message rather than discarded — it
   * is what identified the real cause of this test's last red: the anchor was
   * "visible, enabled and stable" and the click still could not land, because
   * Obsidian's auto-opened Settings dialog was covering the window. Hence the
   * modal sweep first. The ASSERTION is untouched: clicking a link MUST open its
   * target.
   */
  test('4 — clicking a wiki link opens the target note', async () => {
    await dismissBlockingModals(obsidian.page);
    await openNote(obsidian.page, A);
    await ensureReadingView(obsidian.page, A);

    const link = obsidian.page.locator('.markdown-preview-view a.internal-link').first();
    const rendered = await link
      .waitFor({ state: 'visible', timeout: META_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!rendered) {
      throw new Error(
        `no rendered a.internal-link in the reading view of "${A}" within ` +
        `${META_TIMEOUT_MS}ms — the wiki link was not even turned into a clickable ` +
        `anchor.\n${await dumpReadingView(obsidian.page)}`,
      );
    }

    // 15 s of Playwright's actionability retries — tighter than the config's 30 s
    // `actionTimeout` because several gestures stack inside this test. An anchor
    // that is present but never actionable (covered by an Obsidian modal, by the
    // hover page-preview popover, zero-sized under Xvfb, …) fails here, and
    // Playwright's message — which names the element doing the covering — is
    // quoted verbatim into the error below rather than replaced by it.
    const clickErr = await link
      .click({ timeout: ACTION_TIMEOUT_MS })
      .then(() => null)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    if (clickErr) {
      throw new Error(
        `the a.internal-link in "${A}" is rendered but could not be CLICKED within ` +
        `${ACTION_TIMEOUT_MS}ms: ${clickErr}\n${await dumpReadingView(obsidian.page)}`,
      );
    }

    try {
      await expect
        .poll(() => activeFilePath(obsidian.page), {
          message:
            `clicking the [[${STAMP}-B]] anchor in "${A}" did not navigate to "${B}" — ` +
            'the link renders and accepts the click, but does not open its target.',
          timeout: META_TIMEOUT_MS,
        })
        .toBe(B);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n${await dumpReadingView(obsidian.page)}`,
      );
    }
  });

  /**
   * THE HEADLINE DEFECT. PREDICTED RED.
   *
   * `C` sits at the root (so it IS walked and IS indexed) and links into
   * `<STAMP>-sub/`, which the lazy connect walk never descends into. `Deep.md` is
   * therefore not in `fileMap`, so the link cannot resolve.
   *
   * The two assertions before the headline one are DIAGNOSTIC — they narrow the
   * cause to a specific layer so one CI round is conclusive instead of
   * speculative. Note their DIRECTION: they assert what a CORRECT build does
   * (`Deep.md` IS in the vault model; the link is NOT dangling), not what the
   * current build does. Asserting that `getAbstractFileByPath(...)` *is null*
   * would pin today's bug as the expectation and would go red the day someone
   * fixes it — a test that defends a defect. These fail today for the same root
   * cause as the headline assertion, and each names the layer that broke:
   *
   *   5a red  → the file never reached `vault.fileMap`     (the walk starved it)
   *   5b red  → Obsidian classified the link as dangling   (the consequence)
   *   5c red  → the link does not resolve                  (the user-visible harm)
   */
  test('5 — a wiki link into a SUBFOLDER resolves', async () => {
    const probe = await probeLinks(obsidian.page, C, DEEP);
    const diag =
      `\n  fileMap has "${DEEP}": ${probe.inFileMap}` +
      `\n  resolvedLinks["${C}"]: ${JSON.stringify(probe.resolved)}` +
      `\n  unresolvedLinks["${C}"]: ${JSON.stringify(probe.unresolved)}` +
      `\n  fileMap sample: ${JSON.stringify(probe.fileMapSample)}`;

    // 5a — the vault model must contain the note at all.
    await expect
      .poll(async () => (await probeLinks(obsidian.page, C, DEEP)).inFileMap, {
        message:
          `app.vault.getAbstractFileByPath("${DEEP}") is null: the note is not in the ` +
          'vault model AT ALL. The connect walk is non-recursive while `lazyFolderLoad` ' +
          'is on (its default — src/main.ts:972-973, src/constants.ts:51), so ' +
          'VaultModelBuilder.insertFile was never called for anything under a ' +
          'subfolder. Nothing downstream — links, backlinks, graph, Quick Switcher — ' +
          `can see this file.${diag}`,
        timeout: META_TIMEOUT_MS,
      })
      .toBe(true);

    // 5b — and therefore Obsidian must not be treating the link as dangling.
    await expect
      .poll(async () => (await probeLinks(obsidian.page, C, DEEP)).unresolved, {
        message:
          `metadataCache.unresolvedLinks["${C}"] lists "${DEEP_LINKTEXT}" as dangling, ` +
          `but "${DEEP}" exists on the remote. Obsidian resolves links against ` +
          'vault.fileMap and the lazy walk never put the target there, so the user sees ' +
          `a broken link to a note that is plainly there in their own vault.${diag}`,
        timeout: META_TIMEOUT_MS,
      })
      .toEqual([]);

    // 5c — the headline.
    await expect
      .poll(async () => (await probeLinks(obsidian.page, C, DEEP)).resolved, {
        message:
          `metadataCache.resolvedLinks["${C}"] never contained "${DEEP}". Links into ` +
          'subfolders do not resolve on a default connection. Fix this in the PRODUCT ' +
          '— a background/eager full walk, or metadata invalidation on lazy insert — ' +
          `NOT by weakening this assertion.${diag}`,
        timeout: META_TIMEOUT_MS,
      })
      .toContain(DEEP);
  });

  /**
   * The DISCRIMINATOR between the two candidate fixes. Both halves strict.
   *
   *   6a — expanding the folder in the File Explorer (the ONLY user gesture that
   *        deepens the tree: `src/main.ts:919-928` → `LazyFolderLoader.loadFolder`)
   *        gets `Deep.md` into `fileMap`. Expected GREEN — the lazy loader works.
   *   6b — after that late insert, C's link resolves. UNKNOWN, leaning RED:
   *        nothing in the product obviously re-runs link resolution for notes
   *        already indexed when their target arrives late.
   *
   * 6a green + 6b red ⇒ "invalidate metadata on lazy insert" is REQUIRED, and even
   * then every unexpanded folder stays invisible — i.e. the real fix is a
   * background full index. That verdict IS the deliverable of this test, and it
   * only exists if the test FINISHES: the expand (30 s) and both polls (25 s each)
   * are bounded, so 6b's message — "the file IS in fileMap and the link STILL did
   * not resolve" — actually gets printed, instead of being swallowed by a
   * three-minute test timeout that says nothing at all.
   */
  test('6 — expanding the folder in File Explorer makes the subfolder link resolve', async () => {
    // A modal left up by an earlier test would make the folder title
    // un-clickable and turn 6a into a false red about LazyFolderLoader.
    await dismissBlockingModals(obsidian.page);
    await expandFolder(obsidian.page, SUB, EXPAND_TIMEOUT_MS);

    // 6a — the lazy load itself landed.
    try {
      await expect
        .poll(async () => (await probeLinks(obsidian.page, C, DEEP)).inFileMap, {
          message:
            `after clicking the "${SUB}" folder title, "${DEEP}" is STILL not in ` +
            "vault.fileMap — LazyFolderLoader.loadFolder did not materialise the folder's " +
            'children, so the one escape hatch from the lazy walk is broken too.',
          timeout: DISCRIMINATOR_TIMEOUT_MS,
        })
        .toBe(true);
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n${await dumpVaultModel(obsidian.page, SUB)}`,
      );
    }

    // 6b — and the metadata cache noticed. 6a has just proven the file IS in
    // fileMap, so a red here can only mean the lazy insert re-resolved nothing.
    try {
      await expect
        .poll(async () => (await probeLinks(obsidian.page, C, DEEP)).resolved, {
          message:
            `"${DEEP}" IS now in vault.fileMap (6a passed) but ` +
            `metadataCache.resolvedLinks["${C}"] still does not contain it. The lazy ` +
            'insert enlarged the vault WITHOUT making Obsidian re-resolve the links of ' +
            'notes that were already indexed — so even a user who dutifully expands every ' +
            'folder keeps broken links. This is the "invalidate metadata on lazy insert" ' +
            'half of the fix, and it is needed ON TOP OF a fuller walk.',
          timeout: DISCRIMINATOR_TIMEOUT_MS,
        })
        .toContain(DEEP);
    } catch (e) {
      const probe = await probeLinks(obsidian.page, C, DEEP);
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  fileMap has "${DEEP}": ${probe.inFileMap}\n` +
        `  resolvedLinks["${C}"]: ${JSON.stringify(probe.resolved)}\n` +
        `  unresolvedLinks["${C}"]: ${JSON.stringify(probe.unresolved)}`,
      );
    }
  });

  /**
   * Guards the LIVE-CHANGE → metadata chain, which nothing currently covers:
   * `reflect.spec.ts` proves a remote write reaches the File Explorer, but not
   * that it reaches the metadata cache. A note you can see but cannot link to is
   * still broken. Root-level throughout, so the lazy walk is not implicated —
   * this one is expected GREEN, and exists to stay that way.
   */
  test('7 — a note created remotely at root is linkable immediately', async () => {
    await remote.writeFile(D, '# D\n');

    await expect
      .poll(async () => (await probeLinks(obsidian.page, A, D)).inFileMap, {
        message:
          `"${D}" was written on the remote but never reached vault.fileMap — the ` +
          'fs.watch → RPC push → ChangeListener → vault-model chain did not deliver the ' +
          'create.',
        timeout: META_TIMEOUT_MS,
      })
      .toBe(true);

    // Now make an ALREADY-INDEXED note point at the newly arrived one. This is the
    // ordinary "I just made a note and linked to it" flow.
    await remote.writeFile(A, `# A\n\n[[${STAMP}-B]]\n\n[[${STAMP}-D]]\n`);

    await expect
      .poll(async () => (await probeLinks(obsidian.page, A, D)).resolved, {
        message:
          `metadataCache.resolvedLinks["${A}"] never contained "${D}" after "${A}" was ` +
          `rewritten on the remote to link to it. "${D}" IS in the vault model, so the ` +
          'file itself landed — but the modify did not make Obsidian re-parse the source ' +
          'note, so a live remote edit does not update the link index.',
        timeout: META_TIMEOUT_MS,
      })
      .toContain(D);
  });

  /**
   * PREDICTED RED — same root cause as test 5, different user-visible cost.
   *
   * Broken links are only half the damage. The Quick Switcher (and Search, and
   * the graph) enumerate `fileMap`, so a note in an unexpanded subfolder is not
   * merely unlinkable, it is UNREACHABLE: the user types its name and Obsidian
   * tells them it does not exist. This is what the bug actually feels like.
   *
   * ISOLATION — this test used to search for `Deep`, which lives in `<S>-sub`:
   * the very folder test 6 EXPANDS, in the same Obsidian session, two tests
   * earlier. A pass would then have been unfalsifiable — indistinguishable from
   * "test 6 already loaded that folder into fileMap for me". It now targets
   * `<S>-sub2/Deep2.md`, a fixture seeded before connect that NOTHING in this
   * session expands, so the scenario in the title is the scenario under test.
   *
   * The "was it really unexpanded?" fact is captured as a DIAGNOSTIC and folded
   * into the failure message rather than asserted. An `expect(inFileMap).toBe(false)`
   * would encode today's bug as the requirement and would go red the day the
   * product starts indexing the whole vault — the exact inversion this file
   * exists to prevent. The real assertion is unchanged and unweakened: a note
   * that exists on the remote MUST be reachable from the Quick Switcher.
   */
  test('8 — Quick Switcher can reach a note in an unexpanded subfolder', async () => {
    const before = await probeLinks(obsidian.page, C, DEEP2);

    // BEFORE the palette is opened, never after: the palette is itself a
    // `.modal-container` and this would close it.
    await dismissBlockingModals(obsidian.page);
    await runCommandViaPalette(obsidian.page, 'Open quick switcher');

    const input = obsidian.page
      .locator('.prompt input, input.prompt-input, .suggestion-container input')
      .first();
    await expect(input, 'the Quick Switcher never opened').toBeVisible({ timeout: 10_000 });
    await input.fill('');
    await obsidian.page.keyboard.type('Deep2', { delay: 20 });

    try {
      await expect(
        obsidian.page.locator('.prompt .suggestion-item', { hasText: 'Deep2' }).first(),
        `the Quick Switcher offers no suggestion for "Deep2" — "${DEEP2}" exists on the ` +
        'remote, but it lives in a subfolder that NOTHING in this session has expanded, ' +
        'so the lazy connect walk (src/main.ts:972-973) never descended into it. To the ' +
        'user, the note simply does not exist.\n' +
        `  DIAGNOSTIC — when the search was typed, app.vault.getAbstractFileByPath(` +
        `"${DEEP2}") was ${before.inFileMap ? 'a TFile' : 'null'}. If it was null, the ` +
        'switcher cannot enumerate what is not in vault.fileMap and the fix belongs in ' +
        'the vault model (a background/eager walk); if it WAS a TFile, the model is fine ' +
        'and the switcher/search index is the layer at fault.',
      ).toBeVisible({ timeout: META_TIMEOUT_MS });
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n` +
        `  suggestions on screen: ${JSON.stringify(await switcherSuggestions(obsidian.page))}\n` +
        `${await dumpVaultModel(obsidian.page, SUB2)}`,
      );
    }
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fail `work` at `ms` instead of letting it run to the test timeout.
 *
 * Scoped deliberately to `page.evaluate`, which has NO timeout of its own: a
 * wedged renderer simply never answers, and an `expect.poll` cannot time out
 * while its own probe is stuck inside one — the hang wins and the report says
 * only "Test timeout of 180000ms exceeded".
 *
 * It is NOT used around clicks. `playwright.config.ts` now sets
 * `actionTimeout: 30_000`, so an un-actionable element already fails on its own,
 * and Playwright's message ("locator resolved to <div …>; <div class=
 * "modal-container mod-dim"> subtree intercepts pointer events") is strictly
 * better evidence than anything a deadline wrapper could synthesise. Racing a
 * click against a deadline can only throw that away.
 *
 * A late rejection from `work` is absorbed so it cannot resurface as an
 * unhandled rejection after the race is over.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  void work.catch(() => { /* the race below already reports it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `${what} did not settle within ${ms}ms — the Obsidian renderer stopped ` +
        'answering. Bounded deliberately: an unbounded wait here would eat the whole ' +
        'test timeout and report no evidence at all.',
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

interface LinkProbe {
  /** Is `target` in `vault.fileMap` at all? The precondition for ANY resolution. */
  inFileMap: boolean;
  /** `Object.keys(metadataCache.resolvedLinks[src])` — target PATHS. */
  resolved: string[];
  /** `Object.keys(metadataCache.unresolvedLinks[src])` — dangling LINK TEXTS. */
  unresolved: string[];
  /** First 30 `fileMap` keys, so a failure message is conclusive on its own. */
  fileMapSample: string[];
}

/**
 * One round-trip snapshot of everything a link assertion needs. Read inside a
 * single `evaluate` so the three facts are mutually consistent — a poll that
 * fetched them separately could catch the cache mid-update and report a state
 * that never actually existed.
 */
async function probeLinks(page: Page, src: string, target: string): Promise<LinkProbe> {
  return withDeadline(
    page.evaluate(
      ({ src, target }) => {
        const app = (window as unknown as {
          app?: {
            vault?: {
              fileMap?: Record<string, unknown>;
              getAbstractFileByPath?: (p: string) => unknown;
            };
            metadataCache?: {
              resolvedLinks?: Record<string, Record<string, number>>;
              unresolvedLinks?: Record<string, Record<string, number>>;
            };
          };
        }).app;
        const mc = app?.metadataCache;
        return {
          inFileMap: app?.vault?.getAbstractFileByPath?.(target) != null,
          resolved: Object.keys(mc?.resolvedLinks?.[src] ?? {}),
          unresolved: Object.keys(mc?.unresolvedLinks?.[src] ?? {}),
          fileMapSample: Object.keys(app?.vault?.fileMap ?? {}).slice(0, 30),
        };
      },
      { src, target },
    ),
    EVAL_TIMEOUT_MS,
    `probeLinks("${src}" → "${target}")`,
  );
}

/**
 * Source paths that link INTO `targetPath`, straight from
 * `metadataCache.getBacklinksForFile(tfile).data` — the same structure the
 * backlinks pane renders.
 *
 * `.data` is a `Map` on current Obsidian and a plain object on older builds;
 * both shapes are handled rather than pinned, because which one we get is an
 * Obsidian-version detail with no bearing on the behaviour under test. Returns
 * `[]` when the target is not in the vault model at all — which the caller's
 * assertion then correctly reports as "no backlinks".
 */
async function backlinkSourcesFor(page: Page, targetPath: string): Promise<string[]> {
  return withDeadline(
    page.evaluate((p) => {
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

/**
 * Open a note by clicking its File Explorer row — the user's own gesture — and
 * wait until the workspace agrees that note is active.
 *
 * Sweeps modals first: an open `.modal-container` (Obsidian auto-opens Settings
 * after the trust dialog is dismissed) covers the File Explorer and makes the
 * row un-clickable no matter how healthy the vault model is.
 *
 * The wait and the click carry explicit 15 s bounds — tighter than the config's
 * 30 s `actionTimeout` because several gestures stack inside one test — and
 * Playwright's own failure text is quoted verbatim into the error, since that is
 * where "…intercepts pointer events" and the covering element show up.
 */
async function openNote(page: Page, notePath: string): Promise<void> {
  await dismissBlockingModals(page);

  const nav = page.locator(`.nav-file-title[data-path$="${notePath}"]`).first();
  const visible = await nav
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    throw new Error(
      `openNote: no visible .nav-file-title for "${notePath}" within ` +
      `${ACTION_TIMEOUT_MS}ms — the connect walk never materialised it (or the File ` +
      `Explorer never painted it), so there is nothing to click.\n` +
      `${await dumpVaultModel(page, notePath)}`,
    );
  }

  const clickErr = await nav
    .click({ timeout: ACTION_TIMEOUT_MS })
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (clickErr) {
    throw new Error(
      `openNote: the File Explorer row for "${notePath}" could not be clicked within ` +
      `${ACTION_TIMEOUT_MS}ms: ${clickErr}\n${await dumpVaultModel(page, notePath)}`,
    );
  }

  await expect
    .poll(() => activeFilePath(page), {
      message:
        `openNote: clicking the File Explorer row for "${notePath}" did not make it the ` +
        'active file — the note could not even be opened, so nothing downstream of this ' +
        'would mean anything.',
      timeout: ACTION_TIMEOUT_MS,
    })
    .toBe(notePath);
}

/**
 * Make sure the READING view is what is on screen for the note that is open.
 *
 * Obsidian's default is Live Preview, a CodeMirror mode in which
 * `.markdown-preview-view` does not exist at all. `Toggle reading view` is a
 * TOGGLE and the mode sticks to the leaf, so firing it unconditionally would
 * flip a note that is ALREADY in reading view straight back into editing — hence
 * the guard. (Same idiom as `images.spec.ts`'s `openInReadingView`, whose
 * root-embed test passes in CI, so reading view itself is known to work here.)
 */
async function ensureReadingView(page: Page, notePath: string): Promise<void> {
  const preview = page.locator('.markdown-preview-view').first();
  const already = await preview.isVisible({ timeout: 2_000 }).catch(() => false);
  if (!already) {
    // Before the palette, not after — the palette is a `.modal-container` too.
    await dismissBlockingModals(page);
    await runCommandViaPalette(page, 'Toggle reading view');
  }

  const showing = await preview
    .waitFor({ state: 'visible', timeout: META_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!showing) {
    throw new Error(
      `"${notePath}" never entered reading view — no .markdown-preview-view appeared ` +
      `within ${META_TIMEOUT_MS}ms of "Toggle reading view".\n${await dumpReadingView(page)}`,
    );
  }
}

/**
 * Expand a folder in the File Explorer, then wait until its children are
 * actually IN the vault model.
 *
 * Deliberately NOT `helpers/obsidian.ts:expandFolderInExplorer`: that helper
 * waits for the folder title to be merely `attached`, which under Xvfb's
 * virtualised File Explorer is satisfied by a row that never becomes actionable
 * — a 30 s `actionTimeout` burn with a weaker message than the one below. Same
 * PRODUCT gesture (a real click on `.nav-folder-title[data-path=…]`, which is
 * what the delegated listener at `src/main.ts:919-928` hooks), tighter bound,
 * and loud on failure. The shared helper is used by other specs and is not this
 * spec's to change.
 *
 * Sweeps modals first, for the same reason `openNote` does: a covered folder
 * title cannot be clicked, and the resulting red would libel LazyFolderLoader.
 *
 * Waits on `vault.fileMap` rather than on rendered `.nav-file-title` nodes: the
 * model is what the load actually produces, and the File Explorer's paint races
 * under Xvfb.
 */
async function expandFolder(page: Page, folderPath: string, timeoutMs: number): Promise<void> {
  await dismissBlockingModals(page);

  const title = page.locator(`.nav-folder-title[data-path="${folderPath}"]`).first();
  const visible = await title
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    throw new Error(
      `expandFolder: no visible .nav-folder-title[data-path="${folderPath}"] within ` +
      `${ACTION_TIMEOUT_MS}ms — the folder was never materialised by the connect ` +
      `populate, so there is nothing to expand.\n${await dumpVaultModel(page, folderPath)}`,
    );
  }

  const clickErr = await title
    .click({ timeout: ACTION_TIMEOUT_MS })
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (clickErr) {
    throw new Error(
      `expandFolder: the "${folderPath}" folder title is rendered but could not be ` +
      `CLICKED within ${ACTION_TIMEOUT_MS}ms: ${clickErr}\n` +
      `${await dumpVaultModel(page, folderPath)}`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await childrenInFileMap(page, folderPath)) >= 1) return;
    await new Promise((r) => setTimeout(r, 300));
  }

  throw new Error(
    `expandFolder: "${folderPath}" still had no children in vault.fileMap within ` +
    `${timeoutMs}ms of clicking its .nav-folder-title — LazyFolderLoader.loadFolder ` +
    'never landed, so the one escape hatch from the lazy walk is broken too.\n' +
    `${await dumpVaultModel(page, folderPath)}`,
  );
}

/** How many `fileMap` keys sit under `folderPath/`. */
async function childrenInFileMap(page: Page, folderPath: string): Promise<number> {
  return withDeadline(
    page.evaluate((prefix) => {
      const app = (window as unknown as {
        app?: { vault?: { fileMap?: Record<string, unknown> } };
      }).app;
      return Object.keys(app?.vault?.fileMap ?? {})
        .filter((k) => k.startsWith(`${prefix}/`)).length;
    }, folderPath),
    EVAL_TIMEOUT_MS,
    `childrenInFileMap("${folderPath}")`,
  ).catch(() => 0);
}

/**
 * What the vault model and the File Explorer actually contain around
 * `aroundPath`. A bare "element not found" cannot separate "the populate never
 * inserted it" from "it IS in the model but the explorer has not painted it";
 * this can, in one CI round.
 */
async function dumpVaultModel(page: Page, aroundPath: string): Promise<string> {
  const state = await withDeadline(
    page.evaluate((needle) => {
      const app = (window as unknown as {
        app?: { vault?: { fileMap?: Record<string, unknown> } };
      }).app;
      const keys = Object.keys(app?.vault?.fileMap ?? {});
      return {
        fileMapKeys: keys.length,
        hasExactPath: keys.includes(needle),
        under: keys.filter((k) => k.startsWith(`${needle}/`)).slice(0, 20),
        sample: keys.slice(0, 30),
        navFileTitles: Array.from(document.querySelectorAll('.nav-file-title'))
          .map((el) => el.getAttribute('data-path'))
          .slice(0, 30),
        navFolderTitles: Array.from(document.querySelectorAll('.nav-folder-title'))
          .map((el) => el.getAttribute('data-path'))
          .slice(0, 20),
      };
    }, aroundPath),
    EVAL_TIMEOUT_MS,
    `dumpVaultModel("${aroundPath}")`,
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `vault model around "${aroundPath}": ${JSON.stringify(state)}`;
}

/**
 * Everything test 4 needs in order to explain itself: is there a preview pane at
 * all, how many `a.internal-link` are inside it and what do they point at, are
 * there any anywhere else (i.e. did the leaf stay in Live Preview), what mode is
 * the active leaf in, and which file is actually open.
 */
async function dumpReadingView(page: Page): Promise<string> {
  const state = await withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: {
          workspace?: {
            getActiveFile?: () => { path?: string } | null;
            activeLeaf?: { getViewState?: () => { state?: { mode?: string } } } | null;
          };
        };
      }).app;
      const anchors = Array.from(
        document.querySelectorAll('.markdown-preview-view a.internal-link'),
      ).map((el) => ({
        href: el.getAttribute('href'),
        dataHref: el.getAttribute('data-href'),
        text: (el.textContent ?? '').trim(),
        className: el.className,
        painted: (el as HTMLElement).offsetParent !== null,
      }));
      return {
        previewPanes: document.querySelectorAll('.markdown-preview-view').length,
        internalLinksInPreview: anchors.length,
        anchors: anchors.slice(0, 10),
        internalLinksAnywhere: document.querySelectorAll('a.internal-link').length,
        editorPanes: document.querySelectorAll('.markdown-source-view').length,
        leafMode: app?.workspace?.activeLeaf?.getViewState?.()?.state?.mode ?? null,
        activeFile: app?.workspace?.getActiveFile?.()?.path ?? null,
      };
    }),
    EVAL_TIMEOUT_MS,
    'dumpReadingView()',
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `reading-view state: ${JSON.stringify(state)}`;
}

/** The suggestion rows the Quick Switcher is currently showing. */
async function switcherSuggestions(page: Page): Promise<string[]> {
  return withDeadline(
    page.evaluate(() =>
      Array.from(document.querySelectorAll('.prompt .suggestion-item'))
        .map((el) => (el.textContent ?? '').trim())
        .slice(0, 20)),
    EVAL_TIMEOUT_MS,
    'switcherSuggestions()',
  ).catch(() => []);
}
