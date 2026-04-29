// ESLint flat config for the Obsidian community plugin review process.
//
// Two layers of strictness:
//
//   1. `eslint-plugin-obsidianmd`'s recommended preset — same rule set
//      ObsidianReviewBot ships in its npm package (v0.2.8 as of writing).
//
//   2. Bot-parity strengthening — the bot runs a stricter superset of
//      the npm preset on its own infra, including a server-side rule
//      that REJECTS most `eslint-disable` directives. We can't see
//      that exact list locally, but we can prevent the most common
//      classes of regression by adding:
//        - reportUnusedDisableDirectives: 'error'  (catch dead disables)
//        - eslint-comments/require-description     (enforce `-- why` form)
//        - eslint-comments/no-restricted-disable   (ban disables for
//          rules the bot rejects outright)
//        - @typescript-eslint/require-await: 'error' (catches the
//          "Async method 'X' has no 'await'" findings the bot emits
//          but the npm preset turns OFF)
//
// Scope: `src/` only. `tests/` uses conventions (it.skip, mock casts,
// console output for debugging) that would generate noise without value.

import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments/configs";

// Rules where ObsidianReviewBot rejects ANY `eslint-disable` directive
// outright on its server side. Discovered via the round-1/round-2
// rescan reports on PR sotashimozono/obsidian-releases#12390.
//
// Adding a disable for any of these locally fails CI now — caught
// before the bot ever sees it.
const BOT_BANNED_DISABLE_RULES = [
  "obsidianmd/ui/sentence-case",
  "obsidianmd/hardcoded-config-path",
  "obsidianmd/prefer-active-window-timers",
  "obsidianmd/prefer-active-doc",
  "obsidianmd/rule-custom-message",
  "obsidianmd/no-tfile-tfolder-cast",
];

export default defineConfig([
  ...obsidianmd.configs.recommended,
  eslintComments.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    linterOptions: {
      // Catches `// eslint-disable-next-line foo` where `foo` doesn't
      // actually fire on the next line — the disable was redundant or
      // a stale leftover after a refactor. The bot also flags these.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // Every `eslint-disable*` MUST include `-- description` after the
      // rule name. Matches the bot's "Unexpected undescribed directive
      // comment" finding.
      "@eslint-community/eslint-comments/require-description": [
        "error",
        { ignore: [] },
      ],
      // Hard-stop disable directives for the rules the bot rejects.
      // Trips at lint time so the violation surfaces locally instead
      // of after a 6-hour bot rescan loop.
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        ...BOT_BANNED_DISABLE_RULES,
      ],
      // The bot enforces "Async method 'X' has no 'await' expression"
      // even though the obsidianmd npm preset turns this OFF (see
      // `@typescript-eslint/require-await: 'off'` in
      // node_modules/eslint-plugin-obsidianmd/dist/lib/index.js).
      // Re-enable so we catch it ourselves.
      "@typescript-eslint/require-await": "error",
    },
  },
]);
