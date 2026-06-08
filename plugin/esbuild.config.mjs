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

// ssh2 probes BigInt support via `new Function("return 2n ** 32n")()`.
// That literal `new Function(...)` trips Obsidian's plugin-reviewer
// "Dynamic Code Execution" check, even though it executes no user input.
// Obsidian's Electron runtime always supports BigInt, so the probe is
// moot — inline the value it would compute and drop the `new Function`,
// leaving the shipped main.js free of dynamic code execution.
const stripSsh2BigIntProbe = (file) => {
  const code = readFileSync(file, 'utf8');
  const patched = code.replaceAll(
    'new Function("return 2n ** 32n")()',
    '(2n ** 32n)',
  );
  if (patched !== code) {
    writeFileSync(file, patched);
    console.log('esbuild: stripped ssh2 BigInt new Function probe');
  }
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
}).then(() => stripSsh2BigIntProbe('main.js')).catch(() => process.exit(1));
