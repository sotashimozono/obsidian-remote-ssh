#!/usr/bin/env node
/*
 * dev-install — copy build artifacts (main.js, manifest.json, styles.css)
 * into the dev vault's plugins folder.
 *
 * Usage:
 *   node scripts/dev-install.mjs
 *   node scripts/dev-install.mjs <vault-root>
 *
 * The default vault root is read from the `REMOTE_SSH_DEV_VAULT` env var
 * or falls back to `../../SelfArchive-dev` relative to this script
 * (i.e. a sibling of the repo root, since the plugin lives under
 * `<repo>/plugin/`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');     // <repo>/plugin
const repoRoot   = path.resolve(pluginRoot, '..');    // <repo>

const vaultRoot = process.argv[2]
  ?? process.env.REMOTE_SSH_DEV_VAULT
  ?? path.resolve(repoRoot, '..', 'SelfArchive-dev');

const manifestPath = path.join(pluginRoot, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`manifest.json not found at ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const targetDir = path.join(vaultRoot, '.obsidian', 'plugins', manifest.id);
if (!fs.existsSync(path.join(vaultRoot, '.obsidian'))) {
  console.error(`Vault root does not look like an Obsidian vault: ${vaultRoot}`);
  console.error(`(no .obsidian directory found)`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

const files = ['main.js', 'manifest.json', 'styles.css'];
for (const f of files) {
  const src = path.join(pluginRoot, f);
  if (!fs.existsSync(src)) {
    console.error(`missing build artifact: ${src} (run npm run build first)`);
    process.exit(1);
  }
  const dst = path.join(targetDir, f);
  fs.copyFileSync(src, dst);
  console.log(`copied ${f} -> ${dst}`);
}

console.log(`\nplugin '${manifest.id}' v${manifest.version} installed to ${targetDir}`);
console.log('Reload the plugin in Obsidian (Settings → Community plugins → toggle off/on).');
