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

import { afterAll } from 'vitest';

const g = globalThis as unknown as {
  activeWindow?: typeof globalThis;
  activeDocument?: object;
};

if (typeof g.activeWindow === 'undefined') {
  g.activeWindow = globalThis;
}

if (typeof g.activeDocument === 'undefined') {
  g.activeDocument =
    typeof document !== 'undefined' ? document : ({} as object);
}

afterAll(() => {
  // Keep the polyfills in place for the lifetime of the run; a no-op hook
  // here just makes the intent explicit.
});
