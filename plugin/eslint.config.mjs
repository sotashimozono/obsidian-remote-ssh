// ESLint flat config for the Obsidian community plugin review process.
// Pulls in `eslint-plugin-obsidianmd`'s recommended preset so we can
// reproduce ObsidianReviewBot's checks locally. Scope: src/ only;
// tests/ uses different conventions (it.skip, mock casts, console).

import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
  },
]);
