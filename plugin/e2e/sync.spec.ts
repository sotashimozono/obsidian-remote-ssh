import { test, expect, type Page } from '@playwright/test';
import {
  launchObsidian,
  connectAndWaitForShadowVault,
  findShadowVaultPath,
  waitForShadowVaultLoaded,
  dismissBlockingModals,
  type ObsidianHandle,
} from './helpers/obsidian';
import { scaffoldTestVault, type ScaffoldResult } from './helpers/vault-scaffold';
import { RemoteVerifier } from './helpers/remote-verifier';
import { assertSshdReachable } from './helpers/sshd';
import { logPathFor } from './helpers/log-oracle';

/**
 * E2E sync tests — Obsidian → REMOTE. A create / edit / delete performed in the
 * connected Obsidian window must land on the remote filesystem, and every
 * verdict is taken over an INDEPENDENT SFTP connection (`RemoteVerifier`), never
 * through the plugin. `reflect.spec.ts` covers the opposite direction.
 *
 * Requires: docker test sshd (`npm run sshd:start`), plugin+server built,
 * Obsidian installed. HARD-FAILS — it never skips.
 *
 * ── WHICH DRIVE PATH THIS SPEC USES, AND WHY ─────────────────────────────────
 *
 * The operations are driven through Obsidian's OWN vault API from inside the
 * renderer (`app.vault.create` / `.modify` / `.delete` via `page.evaluate`), NOT
 * by typing into CodeMirror and steering the command palette.
 *
 * That is not a shortcut and it removes no product coverage, because the chain
 * under test starts BELOW that line. In the shadow window `app.vault.adapter` is
 * the plugin's PATCHED adapter, and `vault.create/modify/delete` are exactly the
 * calls Obsidian's editor makes on the user's behalf — they go
 *
 *     vault.<op>  →  patched adapter.write/remove  →  RPC/SFTP  →  remote file
 *
 * i.e. every line of OUR code that a keystroke would have reached. What the old
 * UI path added on top was Obsidian's internal "contenteditable → save debounce
 * → vault.modify" step: Obsidian's code, not the plugin's, and not something
 * this suite is here to certify. What it also added was NON-DETERMINISM, which
 * is what actually broke it:
 *
 *   - `Create new note` makes `Untitled.md`, and the rename to TEST_NOTE was
 *     done by `if (await inlineTitle.isVisible()) { … }` — a SILENT SKIP. When
 *     the title field wasn't there the note simply stayed `Untitled.md` and the
 *     spec went on to assert `remote.exists('e2e-test-<stamp>.md')`, failing with
 *     "Expected true, Received false" — a message that names nothing.
 *   - `isVisible()` does NOT hit-test; `click()` DOES. An element under
 *     Obsidian's auto-opened Settings overlay (`.modal-container.mod-dim`) still
 *     reports visible while every click on it is intercepted. So the overlay
 *     being up or down silently flipped WHICH of those steps worked: the spec
 *     was green by luck, and closing the overlay (which fixed `images` and
 *     `links-metadata`) flipped the luck the other way.
 *   - `waitForTimeout(5_000)` "waited" for the remote. It didn't; it slept, and
 *     any slower-than-5 s propagation was a red with no evidence.
 *
 * So: the SETUP is deterministic and typed, and the VERDICT is unchanged and
 * unweakened. Every silent-skip branch is gone — each stage (the vault accepted
 * the op; the file is in the vault model; the remote has it) asserts, so a red
 * names the stage that broke. Every fixed sleep is gone — the remote is POLLED
 * with `expect.poll` and a message, so a red says what the remote actually held.
 *
 * The three remote assertions (`remote.exists`, `remote.readFile` content) are
 * the product contract and are at full strength. Do not weaken them.
 *
 * ── ORDERING ─────────────────────────────────────────────────────────────────
 *
 * The tests share one Obsidian session and run in declaration order: `create`
 * makes TEST_NOTE, `edit` rewrites it, `delete` removes it. Each re-derives the
 * TFile by path rather than relying on "the note is still open" (which the old
 * `edit` did — another way for focus drift to make it edit the wrong file).
 */

const STAMP = Date.now().toString(36);
const TEST_NOTE = `e2e-test-${STAMP}.md`;
const TEST_CONTENT_INITIAL = `# E2E Test Note\n\nCreated by sync.spec.ts at ${STAMP}\n`;
const TEST_CONTENT_EDITED = `# E2E Test Note (edited)\n\nEdited by sync.spec.ts at ${STAMP}\n`;

/**
 * Budget for a local op to reach the remote: vault → patched adapter → RPC →
 * daemon → disk. Sub-second on a warm connection; 20 s is far past the observed
 * settle time, so a RED here is a real propagation defect and not a slow box.
 * (It replaces a fixed 5 s sleep, which could only ever be wrong in one of two
 * directions.)
 */
const SYNC_TIMEOUT_MS = 20_000;

/**
 * Budget for ONE `page.evaluate`. `page.evaluate` has no timeout of its own: a
 * wedged renderer (say, an adapter write blocked on SSH) simply never answers,
 * and the test would burn its whole timeout reporting nothing. Bounding it makes
 * "the renderer stopped answering" a fast, named failure.
 */
const EVAL_TIMEOUT_MS = 15_000;

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
  const remoteOk = await remote.connect();
  if (!remoteOk) {
    throw new Error(
      'RemoteVerifier could not connect to the docker test sshd even though ' +
      'the port is open — check the test key / container state. This spec ' +
      'hard-fails rather than skipping.',
    );
  }

  scaffold = scaffoldTestVault();
  obsidian = await launchObsidian(scaffold.vaultPath);

  // The connect building blocks rather than `connectAndOpenShadow`, so we keep
  // hold of the shadow vault PATH — `waitForShadowVaultLoaded` needs its log
  // path. Deliberately NOT wrapped in try/catch: if the connect flow throws, the
  // plugin is broken and this suite must go RED. Swallowing it into a
  // `test.skip` is what let a broken connect ship green in 1.0.49.
  shadowVaultPath = await connectAndWaitForShadowVault(obsidian.page, scaffold.vaultPath);
  await obsidian.cleanup();
  obsidian = await launchObsidian(shadowVaultPath);

  // THE RACE THE OLD SPEC NEVER CLOSED. `launchObsidian` returns once the PLUGIN
  // has loaded; the SSH connect, the ADAPTER PATCH and `populateVaultFromRemote`
  // all land later, at layout-ready. A `vault.create` fired before the patch
  // writes to the shadow vault's LOCAL directory and never reaches the remote —
  // a "Received false" that has nothing to do with sync. Block until the remote
  // tree is actually in the vault model before any test runs.
  await waitForShadowVaultLoaded(obsidian.page, logPathFor(shadowVaultPath), 30_000);

  // Harness, not product: dismissing the trust dialog makes Obsidian auto-open
  // its Settings dialog, a full-window `.modal-container.mod-dim` that
  // intercepts pointer events. Nothing below clicks, but a modal left up also
  // steals keyboard focus and makes every failure screenshot unreadable. It logs
  // whatever it closes, so a modal that IS meaningful (a host-key prompt, a
  // write conflict) surfaces in CI instead of being silently swallowed.
  await dismissBlockingModals(obsidian.page);
});

test.afterAll(async () => {
  if (remote) {
    await remote.removeFile(TEST_NOTE).catch(() => { /* best effort */ });
    await remote.disconnect();
  }
  await obsidian?.cleanup();
  scaffold?.cleanup();
});

test.beforeEach(() => {
  // A remote round-trip plus a bounded poll; the config's default 120 s gets
  // tight once the create's two polls stack up inside one test.
  test.setTimeout(180_000);
});

test.describe('Remote sync verification', () => {
  // No `beforeEach` skip gate: reaching here means `beforeAll` completed, which
  // means the connect AND the populate succeeded. If they didn't, `beforeAll`
  // threw and the whole suite is already red — which is the point.

  test('create — new note appears on remote', async () => {
    const { page } = obsidian;

    // Stage 1 — Obsidian accepts the create, at a KNOWN path. `vault.create`
    // either returns the TFile or throws; there is no branch in which this
    // quietly leaves an `Untitled.md` behind and lets the remote assertion take
    // the blame (which is exactly what the old palette + conditional-rename path
    // did).
    await createNote(page, TEST_NOTE, TEST_CONTENT_INITIAL);

    // Stage 2 — and it is in the vault model under that exact path. If this is
    // red, the create never happened locally and nothing about the remote is
    // implicated; if it is GREEN and stage 3 is red, the write did not
    // propagate. That split is the whole diagnostic value.
    expect(
      await inFileMap(page, TEST_NOTE),
      `app.vault.create("${TEST_NOTE}") returned but the note is not in ` +
      `vault.fileMap — the local create did not take.\n${await dumpVaultState(page)}`,
    ).toBe(true);

    // Stage 3 — THE CONTRACT. Ground truth over an independent SFTP connection.
    // Polled, not slept: the old fixed 5 s sleep turned any slower propagation
    // into a bare "Expected true, Received false".
    await expect
      .poll(() => remote.exists(TEST_NOTE), {
        message:
          `"${TEST_NOTE}" was created in Obsidian (it IS in vault.fileMap) but never ` +
          `appeared on the remote within ${SYNC_TIMEOUT_MS}ms. The vault → patched ` +
          'adapter → RPC/SFTP → disk chain did not deliver the write.',
        timeout: SYNC_TIMEOUT_MS,
      })
      .toBe(true);

    // …and with the right BYTES, not merely the right name. Polled separately:
    // a zero-byte file can exist for a beat before its content lands, and
    // asserting content off the back of `exists` alone would be racy in the
    // other direction.
    await expect
      .poll(() => remote.readFile(TEST_NOTE), {
        message:
          `"${TEST_NOTE}" exists on the remote but its content never contained the ` +
          'text Obsidian created it with — the file landed, its bytes did not.',
        timeout: SYNC_TIMEOUT_MS,
      })
      .toContain('E2E Test Note');

    const content = await remote.readFile(TEST_NOTE);
    expect(content).toContain('E2E Test Note');
    expect(content).toContain(STAMP);
  });

  test('edit — modified content reflects on remote', async () => {
    const { page } = obsidian;

    // Re-derive the TFile by PATH. The old test assumed "the note from the
    // create test should still be open" and typed into whatever had focus — so a
    // stray modal, a focus drift or a different active leaf silently edited
    // something else (or nothing) and the remote assertion took the blame.
    await modifyNote(page, TEST_NOTE, TEST_CONTENT_EDITED);

    await expect
      .poll(() => remote.readFile(TEST_NOTE), {
        message:
          `"${TEST_NOTE}" was rewritten through app.vault.modify() but the remote copy ` +
          `never picked the new content up within ${SYNC_TIMEOUT_MS}ms — an EDIT in ` +
          'Obsidian does not reach the remote (the create did, so the connection and ' +
          'the adapter patch are both fine).',
        timeout: SYNC_TIMEOUT_MS,
      })
      .toContain('edited');

    // Full strength, unchanged: the edited body — not just the marker word — is
    // what has to be on the remote, and the old body must be GONE (an append
    // would satisfy `toContain('edited')` while leaving the file wrong).
    const content = await remote.readFile(TEST_NOTE);
    expect(content).toContain('edited');
    expect(content).toContain(STAMP);
    expect(content).not.toContain('Created by sync.spec.ts');
  });

  test('delete — removed note disappears from remote', async () => {
    const { page } = obsidian;

    // Precondition, asserted rather than assumed: the previous tests really did
    // leave TEST_NOTE on the remote. Without this a delete test can pass simply
    // because the file was never there — the classic vacuous green.
    expect(
      await remote.exists(TEST_NOTE),
      `"${TEST_NOTE}" is not on the remote BEFORE the delete, so this test could ` +
      'only ever pass vacuously. The create/edit tests above must have failed.',
    ).toBe(true);

    // `vault.delete` is Obsidian's own hard delete — the same `adapter.remove()`
    // the UI's "Delete current file" ends up calling once its confirmation is
    // through. The old test drove the palette and then clicked that confirm
    // button behind `if (await confirmBtn.isVisible(…))`: another silent skip, in
    // which a missing (or overlay-covered) dialog left the file undeleted and the
    // failure landed on `expect(exists).toBe(false)` instead of on the gesture
    // that never happened.
    await deleteNote(page, TEST_NOTE);

    expect(
      await inFileMap(page, TEST_NOTE),
      `app.vault.delete("${TEST_NOTE}") returned but the note is STILL in ` +
      `vault.fileMap — the local delete did not take.\n${await dumpVaultState(page)}`,
    ).toBe(false);

    // THE CONTRACT.
    await expect
      .poll(() => remote.exists(TEST_NOTE), {
        message:
          `"${TEST_NOTE}" was deleted in Obsidian (it is gone from vault.fileMap) but ` +
          `is STILL on the remote after ${SYNC_TIMEOUT_MS}ms. A delete does not ` +
          'propagate: the user removes a note and it silently comes back on the next ' +
          'connect.',
        timeout: SYNC_TIMEOUT_MS,
      })
      .toBe(false);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Fail `work` at `ms` instead of letting it run to the test timeout. Scoped
 * deliberately to `page.evaluate`, which has NO timeout of its own — a renderer
 * wedged inside a blocked adapter write never answers, and the report would say
 * only "Test timeout of 120000ms exceeded". A late rejection is absorbed so it
 * cannot resurface as an unhandled rejection after the race is over.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  void work.catch(() => { /* the race below already reports it */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(
        `${what} did not settle within ${ms}ms — the Obsidian renderer stopped ` +
        'answering (an adapter write blocked on SSH looks exactly like this). Bounded ' +
        'deliberately: an unbounded wait here would eat the whole test timeout and ' +
        'report no evidence at all.',
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

/**
 * The outcome of one in-renderer vault op. The renderer-side reason is carried
 * back VERBATIM rather than collapsed into a boolean — "the note already exists"
 * and "the adapter threw EACCES" are different findings and must not both
 * surface as `false`.
 */
interface VaultOpResult {
  ok: boolean;
  error?: string;
}

/**
 * `app.vault.create(path, content)`. Throws — loudly, with the renderer's own
 * message and the vault state — if Obsidian did not accept the create. There is
 * no branch in which a failed create is carried past.
 */
async function createNote(page: Page, notePath: string, content: string): Promise<void> {
  const result = await withDeadline(
    page.evaluate(
      async ({ p, c }): Promise<VaultOpResult> => {
        const app = (window as unknown as {
          app?: { vault?: { create?: (path: string, data: string) => Promise<unknown> } };
        }).app;
        if (!app?.vault?.create) {
          return { ok: false, error: 'app.vault.create is not available' };
        }
        try {
          await app.vault.create(p, c);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      { p: notePath, c: content },
    ),
    EVAL_TIMEOUT_MS,
    `app.vault.create("${notePath}")`,
  );

  if (!result.ok) {
    throw new Error(
      `app.vault.create("${notePath}") FAILED in the renderer: ${result.error}. ` +
      'Obsidian would not create the note at all, so nothing about remote ' +
      `propagation is under test yet.\n${await dumpVaultState(page)}`,
    );
  }
}

/**
 * `app.vault.modify(getAbstractFileByPath(path), content)` — the same call
 * Obsidian's editor makes when it saves. Resolving the TFile BY PATH is the
 * point: it cannot edit "whatever happened to be focused".
 */
async function modifyNote(page: Page, notePath: string, content: string): Promise<void> {
  const result = await withDeadline(
    page.evaluate(
      async ({ p, c }): Promise<VaultOpResult> => {
        const app = (window as unknown as {
          app?: {
            vault?: {
              getAbstractFileByPath?: (path: string) => unknown;
              modify?: (file: unknown, data: string) => Promise<void>;
            };
          };
        }).app;
        const file = app?.vault?.getAbstractFileByPath?.(p);
        if (!file) {
          return { ok: false, error: `getAbstractFileByPath("${p}") returned null` };
        }
        if (!app?.vault?.modify) {
          return { ok: false, error: 'app.vault.modify is not available' };
        }
        try {
          await app.vault.modify(file, c);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      { p: notePath, c: content },
    ),
    EVAL_TIMEOUT_MS,
    `app.vault.modify("${notePath}")`,
  );

  if (!result.ok) {
    throw new Error(
      `app.vault.modify("${notePath}") FAILED in the renderer: ${result.error}. The ` +
      'EDIT never happened locally, so the remote assertion below would have been ' +
      `reporting the wrong defect.\n${await dumpVaultState(page)}`,
    );
  }
}

/**
 * `app.vault.delete(getAbstractFileByPath(path))` — Obsidian's hard delete,
 * which is what "Delete current file" resolves to once its confirmation dialog
 * is through, and which lands on the patched `adapter.remove()`.
 */
async function deleteNote(page: Page, notePath: string): Promise<void> {
  const result = await withDeadline(
    page.evaluate(
      async (p): Promise<VaultOpResult> => {
        const app = (window as unknown as {
          app?: {
            vault?: {
              getAbstractFileByPath?: (path: string) => unknown;
              delete?: (file: unknown, force?: boolean) => Promise<void>;
            };
          };
        }).app;
        const file = app?.vault?.getAbstractFileByPath?.(p);
        if (!file) {
          return { ok: false, error: `getAbstractFileByPath("${p}") returned null` };
        }
        if (!app?.vault?.delete) {
          return { ok: false, error: 'app.vault.delete is not available' };
        }
        try {
          await app.vault.delete(file);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      notePath,
    ),
    EVAL_TIMEOUT_MS,
    `app.vault.delete("${notePath}")`,
  );

  if (!result.ok) {
    throw new Error(
      `app.vault.delete("${notePath}") FAILED in the renderer: ${result.error}. The ` +
      'DELETE never happened locally, so "still on the remote" would be the wrong ' +
      `finding.\n${await dumpVaultState(page)}`,
    );
  }
}

/** Is `notePath` in `vault.fileMap` at all? The local half of every verdict. */
async function inFileMap(page: Page, notePath: string): Promise<boolean> {
  return withDeadline(
    page.evaluate((p) => {
      const app = (window as unknown as {
        app?: { vault?: { getAbstractFileByPath?: (path: string) => unknown } };
      }).app;
      return app?.vault?.getAbstractFileByPath?.(p) != null;
    }, notePath),
    EVAL_TIMEOUT_MS,
    `inFileMap("${notePath}")`,
  );
}

/**
 * What was on screen and what the vault held, for the failure messages above.
 * A bare "Received false" cannot separate "Obsidian never made the file",
 * "Obsidian made it under a different name" (the old `Untitled.md` failure) and
 * "it propagated nowhere"; the active file, the vault's markdown paths and any
 * open modal (the overlay that silently broke the old click-driven path)
 * separate all three in one CI round.
 */
async function dumpVaultState(page: Page): Promise<string> {
  const state = await withDeadline(
    page.evaluate(() => {
      const app = (window as unknown as {
        app?: {
          vault?: {
            fileMap?: Record<string, unknown>;
            getMarkdownFiles?: () => Array<{ path?: string }>;
          };
          workspace?: { getActiveFile?: () => { path?: string } | null };
        };
      }).app;
      const keys = Object.keys(app?.vault?.fileMap ?? {});
      return {
        activeFile: app?.workspace?.getActiveFile?.()?.path ?? null,
        fileMapKeys: keys.length,
        markdownFiles: (app?.vault?.getMarkdownFiles?.() ?? [])
          .map((f) => f.path)
          .slice(0, 30),
        fileMapSample: keys.slice(0, 30),
        openModals: Array.from(document.querySelectorAll('.modal-container')).map((c) => ({
          title: c.querySelector('.modal-title')?.textContent?.trim() ?? '(untitled)',
          containerClass: c.className,
        })),
      };
    }),
    EVAL_TIMEOUT_MS,
    'dumpVaultState()',
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));

  return `vault + screen state: ${JSON.stringify(state)}`;
}
