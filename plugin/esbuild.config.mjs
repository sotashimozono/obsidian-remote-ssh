import esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const prod = process.argv[2] === 'production';

// Mark native .node addons as external so esbuild skips them.
// ssh2 wraps the native crypto binding in a try/catch and falls back to
// pure-JS implementations when the addon is unavailable.
const nativeNodePlugin = {
  name: 'native-node-modules',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, args => ({
      path: args.path,
      external: true,
    }));
  },
};

// ssh2 initialises its `MAX_32BIT_BIGINT` constant via
// `new Function("return 2n ** 32n")()` — a BigInt-availability guard wrapped
// in try/catch (see ssh2/lib/protocol/node-fs-compat.js). That literal
// `new Function(...)` trips Obsidian's plugin-reviewer "Dynamic Code
// Execution" check, even though it executes no user input. Obsidian's
// Electron runtime always supports BigInt, so the value is constant — inline
// it and drop the `new Function`, leaving the shipped main.js free of
// dynamic code execution.
//
// PROBE is a load-bearing string literal: if a future ssh2 release or an
// esbuild minification change alters it, `replaceAll` would silently no-op
// and re-introduce the reviewer finding. So a zero-replacement outcome is a
// HARD ERROR on production builds (warn-only on dev, so the local loop isn't
// blocked while the pattern is being updated).
const stripSsh2BigIntProbe = (file) => {
  const PROBE = 'new Function("return 2n ** 32n")()';
  const code = readFileSync(file, 'utf8');
  if (!code.includes(PROBE)) {
    const msg =
      `stripSsh2BigIntProbe: probe ${JSON.stringify(PROBE)} not found in `
      + `${file}. ssh2 may have changed it or esbuild altered the literal — `
      + 'update PROBE or remove this step. Refusing to ship an unverified bundle.';
    if (prod) throw new Error(msg);
    console.warn(`esbuild: ${msg} (dev build — skipping)`);
    return;
  }
  writeFileSync(file, code.replaceAll(PROBE, '(2n ** 32n)'));
  console.log('esbuild: stripped ssh2 BigInt new Function probe');
};

esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
    'cpu-features',
    'nan',
  ],
  plugins: [nativeNodePlugin],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Prefer the `module` field (ESM build) over `main` (CJS build) when a
  // package ships both. xterm 6 ships a CJS bundle (~488 KB) that's ~40%
  // larger than its ESM equivalent (~345 KB); picking the ESM variant
  // keeps the plugin bundle under the 800 KB guard. esbuild still wraps
  // the result in our CJS output format, so Obsidian can `require()` it.
  mainFields: ['module', 'main'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  outfile: 'main.js',
}).then(() => stripSsh2BigIntProbe('main.js')).catch((err) => {
  console.error('esbuild build failed:', err);
  process.exit(1);
});
