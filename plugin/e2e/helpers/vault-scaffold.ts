import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

/**
 * Connection coordinates for the Docker test sshd — same as the
 * integration test helpers to reuse the same container.
 */
const TEST_HOST = '127.0.0.1';
const TEST_PORT = 2222;
const TEST_USER = 'tester';
const TEST_VAULT_REMOTE = `/home/${TEST_USER}/vault`;

const PLUGIN_ID = 'remote-ssh';

export interface ScaffoldResult {
  vaultPath: string;
  cleanup: () => void;
}

export interface ScaffoldOptions {
  /**
   * Transport for the seeded test profile. Defaults to `'rpc'` so
   * existing specs (smoke/sync/reflect/demo) are unaffected. The
   * connect-lifecycle spec passes `'sftp'` — the transport the
   * production connect-stall incident was reported on.
   */
  transport?: 'sftp' | 'rpc';
  /**
   * Remote vault path for the seeded profile. Defaults to the docker
   * fixture vault (which exists). The negative-path spec passes a
   * non-existent path to reproduce the field incident (a profile
   * whose remotePath isn't on the remote → connect fails) and assert
   * the failure is *visible*, not a silent hang / spawn storm.
   */
  remotePath?: string;
}

/**
 * Create a temporary Obsidian vault with the remote-ssh plugin
 * pre-installed and a test SSH profile pre-configured.
 *
 * The vault is ready to be opened by Obsidian — the plugin will
 * auto-connect on launch if `autoConnectProfileId` is set in
 * `data.json`.
 */
export function scaffoldTestVault(opts: ScaffoldOptions = {}): ScaffoldResult {
  const transport = opts.transport ?? 'rpc';
  const remotePath = opts.remotePath ?? TEST_VAULT_REMOTE;
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-vault-'));

  // UNIQUE profile id per scaffold. The shadow vault dir is derived
  // as `~/.obsidian-remote/vaults/<sanitised-profile-id>/`, and the
  // plugin's structured logger appends (never truncates) to
  // `<shadow>/.obsidian/plugins/remote-ssh/console.log`. A hardcoded
  // shared id meant connect-failure-visible / connect-lifecycle /
  // connect-reconnect all wrote to ONE rolling log: the log-oracle in
  // a later spec matched an EARLIER spec's stale `SFTP channel open`
  // / `Adapter patched` lines, so connect-reconnect `sshd('stop')`'d
  // the container off a stale success while its own connect was still
  // in flight — that connect then legitimately timed out (the
  // "Connection timed out" the CI was wrongly attributing to a broken
  // product connect). Per-spec ids make every log-oracle read only
  // that spec's own run. The id stays `[a-z0-9-]` so
  // `sanitiseProfileId` is identity (cleanup must compute the same
  // path).
  const profileId = `e2e-test-profile-${crypto.randomBytes(4).toString('hex')}`;

  // .obsidian base
  const obsidianDir = path.join(vaultPath, '.obsidian');
  fs.mkdirSync(obsidianDir, { recursive: true });

  // Install the plugin
  const pluginDir = path.join(obsidianDir, 'plugins', PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });

  // Copy built plugin files
  const filesToCopy = ['main.js', 'manifest.json', 'styles.css'];
  for (const file of filesToCopy) {
    const src = path.join(pluginRoot, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(pluginDir, file));
    }
  }

  // Copy server binary if available
  const serverBinDir = path.join(pluginRoot, 'server-bin');
  if (fs.existsSync(serverBinDir)) {
    const destBinDir = path.join(pluginDir, 'server-bin');
    fs.mkdirSync(destBinDir, { recursive: true });
    for (const entry of fs.readdirSync(serverBinDir)) {
      fs.copyFileSync(
        path.join(serverBinDir, entry),
        path.join(destBinDir, entry),
      );
    }
  }

  // Resolve test private key path
  const privateKeyPath = path.resolve(
    pluginRoot, '..', 'docker', 'keys', 'id_test',
  );

  // Write data.json with a pre-configured test profile
  const dataJson = {
    profiles: [
      {
        id: profileId,
        name: 'E2E Test',
        host: TEST_HOST,
        port: TEST_PORT,
        username: TEST_USER,
        authMethod: 'privateKey',
        privateKeyPath,
        remotePath,
        transport,
        connectTimeoutMs: 30_000,
        keepaliveIntervalMs: 10_000,
        keepaliveCountMax: 3,
      },
    ],
    settings: {
      clientId: 'e2e-test',
      debugLogging: true,
    },
  };

  fs.writeFileSync(
    path.join(pluginDir, 'data.json'),
    JSON.stringify(dataJson, null, 2),
    'utf8',
  );

  // Pre-write the on-disk state Obsidian normally reaches AFTER the
  // user has gone through Settings -> Community plugins -> Turn on:
  //   community-plugins.json -> these plugins should be enabled
  //   core-plugins.json      -> default core plugins are configured
  //   app.json               -> some user setting has been touched
  //
  // Note: workspace.json is intentionally NOT pre-written. Obsidian's
  // renderer treats a workspace with empty `main.children` as "no
  // active leaf" and paints nothing — the DOM still loads (so
  // page.evaluate works and waitForPluginLoaded passes) but the
  // window is visually black, which broke the demo recording. Let
  // Obsidian generate workspace.json itself on first save with a
  // real leaf view; that produces a visible vault.
  fs.writeFileSync(
    path.join(obsidianDir, 'community-plugins.json'),
    JSON.stringify([PLUGIN_ID]),
    'utf8',
  );

  fs.writeFileSync(
    path.join(obsidianDir, 'core-plugins.json'),
    JSON.stringify([
      'file-explorer', 'global-search', 'switcher', 'graph', 'backlink',
      'canvas', 'outgoing-link', 'tag-pane', 'page-preview', 'daily-notes',
      'templates', 'note-composer', 'command-palette', 'editor-status',
      'bookmarks', 'markdown-importer', 'outline', 'word-count',
      'file-recovery',
    ]),
    'utf8',
  );

  // app.json with a single setting touched. An empty-object app.json
  // is treated as "never configured" by some Obsidian builds.
  fs.writeFileSync(
    path.join(obsidianDir, 'app.json'),
    JSON.stringify({ promptDelete: false }, null, 2),
    'utf8',
  );

  // Seed demo notes so the vault isn't empty in screenshots / tests
  seedDemoNotes(vaultPath);

  // Shadow vault dir for THIS profile, computed with the same rule as
  // ShadowVaultBootstrap (`<home>/.obsidian-remote/vaults/<id>`; the
  // id is `[a-z0-9-]` so sanitisation is identity). Removing it on
  // cleanup means a re-run — or the next serial spec — starts with a
  // fresh console.log and no leftover shadow content, instead of
  // inheriting a prior run's state under a shared directory.
  const shadowVaultDir = path.join(
    os.homedir(), '.obsidian-remote', 'vaults', profileId,
  );

  const cleanup = () => {
    try {
      fs.rmSync(vaultPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
    try {
      fs.rmSync(shadowVaultDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    // Prune this profile's entry from the user-global obsidian.json so
    // `findShadowVaultPath` (which picks the highest-`ts` vault whose
    // path still exists) can't resolve to a now-deleted shadow dir and
    // the file doesn't accumulate dead entries across the run.
    try {
      const obsidianConfigPath = path.join(
        process.env.APPDATA ?? path.join(process.env.HOME ?? os.homedir(), '.config'),
        'obsidian',
        'obsidian.json',
      );
      const cfg = JSON.parse(fs.readFileSync(obsidianConfigPath, 'utf8')) as {
        vaults?: Record<string, { path?: string }>;
      };
      let changed = false;
      for (const id of Object.keys(cfg.vaults ?? {})) {
        const p = cfg.vaults?.[id]?.path;
        if (p === vaultPath || p === shadowVaultDir) {
          delete cfg.vaults![id];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(obsidianConfigPath, JSON.stringify(cfg), 'utf8');
      }
    } catch {
      // best effort — obsidian.json may be absent or mid-write
    }
  };

  return { vaultPath, cleanup };
}

/**
 * Seed the vault with sample markdown notes so the file explorer
 * has visible content in E2E tests and demo screenshots.
 */
function seedDemoNotes(vaultPath: string): void {
  // Five `local_demo*.md` notes, deliberately uniform in shape, so
  // the demo GIF reads as: "the local vault has local_demoN; after
  // connect, the shadow vault has remote_demoN" — a clean visual
  // contrast with the docker/test-vault fixtures of the same shape.
  const N = 5;
  for (let i = 1; i <= N; i++) {
    const content = [
      `# Local demo ${i}`,
      '',
      'This note lives **on the local machine** in the scaffold vault.',
      `It is one of ${N} \`local_demo*.md\` files seeded so the file`,
      'explorer has visible content before any SSH connection happens.',
      '',
      'After **Remote SSH: Connect**, a separate shadow vault opens',
      'with the remote files (`remote_demo1.md` … `remote_demo5.md`).',
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(vaultPath, `local_demo${i}.md`),
      content,
      'utf8',
    );
  }
}
