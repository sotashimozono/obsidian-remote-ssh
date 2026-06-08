// Vitest polyfills for Obsidian's `activeWindow` / `activeDocument` globals.
//
// In Obsidian, `activeWindow` and `activeDocument` resolve to the currently
// focused workspace window/document so plugins can keep timers and DOM ops
// scoped to popped-out windows. The ESLint rules
// `obsidianmd/prefer-active-window-timers` and `obsidianmd/prefer-active-doc`
// require us to use these instead of the bare `window` / `document` globals.
//
// Vitest's node environment doesn't provide them, so source code that
// references `activeWindow.setTimeout(...)` would throw `ReferenceError`
// inside tests. We polyfill before any test file loads by aliasing
// `activeWindow` to `globalThis` (which has setTimeout / clearTimeout /
// setInterval / clearInterval) and `activeDocument` to a stub document
// (or `document` if jsdom is in play).

import { beforeEach } from 'vitest';
// Direct path (not the 'obsidian' alias) because this setup file is
// shared with vitest.integration.config.ts and vitest.replay.config.ts,
// which do NOT alias 'obsidian' — the integration suite runs against
// a real sshd Docker container and never imports Obsidian UI.
import { clearNotices } from './tests/__mocks__/obsidian';

const g = globalThis as unknown as {
  activeWindow?: typeof globalThis;
  activeDocument?: object;
  window?: typeof globalThis;
};

if (typeof g.activeWindow === 'undefined') {
  g.activeWindow = globalThis;
}

// eslint-plugin-obsidianmd 0.3.0 flipped `prefer-active-window-timers` →
// `prefer-window-timers`, so source now calls `window.setTimeout(...)`.
// The node environment (integration/replay configs) has no `window`, so
// alias it to globalThis too. jsdom already provides one, so this is a
// no-op under the unit config.
if (typeof g.window === 'undefined') {
  g.window = globalThis;
}

if (typeof g.activeDocument === 'undefined') {
  g.activeDocument =
    typeof document !== 'undefined' ? document : ({} as object);
}

// Reset the obsidian-mock Notice buffer before every test so test
// files that touch the UI don't see stale notices from a previous
// suite. Tests can still call clearNotices() mid-test if they need
// to assert on a fresh window.
beforeEach(() => {
  clearNotices();
});
