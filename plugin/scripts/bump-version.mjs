// Sync `plugin/manifest.json`, the repo-root mirrors `manifest.json`,
// `manifest-beta.json` (BRAT --beta channel), `versions.json`, and
// `plugin/versions.json` with the version that npm has just written
// into `plugin/package.json`.
//
// Wired into `package.json`'s `"version"` lifecycle script so
// `npm version <X.Y.Z>` (run from `plugin/`) updates every file at
// once. The CI version-check workflow asserts they agree.
//
// `manifest-beta.json` is what BRAT (Beta Reviewers Auto-update Tool)
// fetches when a user installs with `--beta`. Pre-1.0 it tracks the
// stable manifest 1:1 (every merge IS a beta). Once we cut a `next`
// branch for post-1.0 development, beta will diverge from stable —
// at that point the version-check workflow's beta-equals-stable
// assert needs to be loosened (this script can stay as-is).
//
// Why a root mirror: Obsidian's community plugin browser fetches
// `https://raw.githubusercontent.com/<repo>/HEAD/manifest.json` to
// discover plugin metadata. Plugin source lives under `plugin/` for
// repo-layout reasons (server/, proto/, deploy/ siblings), so we
// mirror to the root so Obsidian — and the obsidianmd/obsidian-releases
// registry validator — can find it.
//
// Manifest version → Obsidian's runtime view of the plugin
//                    (`this.manifest.version` in `main.ts`).
// versions.json    → Obsidian's compatibility map: each plugin
//                    version maps to the minimum Obsidian app
//                    version it supports. We mirror minAppVersion
//                    from manifest.json automatically.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pluginRoot, '..');

const packagePath = path.join(pluginRoot, 'package.json');
const manifestPath = path.join(pluginRoot, 'manifest.json');
const versionsPath = path.join(pluginRoot, 'versions.json');
const rootManifestPath = path.join(repoRoot, 'manifest.json');
const rootManifestBetaPath = path.join(repoRoot, 'manifest-beta.json');
const rootVersionsPath = path.join(repoRoot, 'versions.json');

const pkg = readJson(packagePath);
const manifest = readJson(manifestPath);
const versions = fs.existsSync(versionsPath) ? readJson(versionsPath) : {};

const newVersion = pkg.version;
if (typeof newVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-.+)?$/.test(newVersion)) {
  console.error(`bump-version: package.json has an unexpected version "${newVersion}"`);
  process.exit(1);
}

manifest.version = newVersion;
versions[newVersion] = manifest.minAppVersion;

writeJson(manifestPath, manifest);
writeJson(versionsPath, versions);
writeJson(rootManifestPath, manifest);
writeJson(rootManifestBetaPath, manifest);
writeJson(rootVersionsPath, versions);

console.log(
  `bump-version: synced plugin/manifest.json + manifest.json + manifest-beta.json + versions.json `
  + `(plugin + root) to ${newVersion} (minAppVersion ${manifest.minAppVersion})`,
);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  // Match the existing file's trailing newline convention so diffs
  // stay quiet between editors.
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
