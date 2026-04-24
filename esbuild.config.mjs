import esbuild from 'esbuild';

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
  sourcemap: prod ? false : 'inline',
  minify: prod,
  outfile: 'main.js',
}).catch(() => process.exit(1));
