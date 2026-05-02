/**
 * SSHd configuration helpers for integration tests.
 *
 * These utilities generate minimal sshd_config snippets and helper
 * objects that the integration test suite uses to spin up (or talk to)
 * the Docker sshd container. They are intentionally dependency-free —
 * no ssh2 import — so they can be imported at the top of any test
 * file without triggering a live SSH connection.
 */

export const SSHD_HOST = process.env['SSHD_HOST'] ?? '127.0.0.1';
export const SSHD_PORT = Number(process.env['SSHD_PORT'] ?? 2222);
export const SSHD_USER = process.env['SSHD_USER'] ?? 'testuser';
export const SSHD_PASSWORD = process.env['SSHD_PASSWORD'] ?? 'testpass';
export const SSHD_ROOT = process.env['SSHD_ROOT'] ?? '/home/testuser';

/**
 * Minimal ConnectConfig-compatible object for the test sshd container.
 * Spread this into ssh2 `Client.connect()` calls in integration tests.
 */
export function sshdConnectConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: SSHD_HOST,
    port: SSHD_PORT,
    username: SSHD_USER,
    password: SSHD_PASSWORD,
    hostVerifier: () => true,
    readyTimeout: 5000,
    ...overrides,
  };
}

/**
 * Returns a minimal sshd_config text fragment enabling the features
 * that integration tests depend on (SFTP, Unix-domain socket forwarding,
 * keyboard-interactive auth).
 */
export function minimalSshdConfig(opts: {
  port?: number;
  allowPasswordAuth?: boolean;
  allowKbdInteractive?: boolean;
  extraLines?: string[];
} = {}): string {
  const lines: string[] = [
    `Port ${opts.port ?? SSHD_PORT}`,
    'Protocol 2',
    'HostKey /etc/ssh/ssh_host_rsa_key',
    'HostKey /etc/ssh/ssh_host_ed25519_key',
    'Subsystem sftp internal-sftp',
    'StreamLocalBindUnlink yes',
    `PasswordAuthentication ${opts.allowPasswordAuth !== false ? 'yes' : 'no'}`,
    `KbdInteractiveAuthentication ${opts.allowKbdInteractive !== false ? 'yes' : 'no'}`,
    'UsePAM no',
    'StrictModes no',
    'LogLevel VERBOSE',
    ...(opts.extraLines ?? []),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Returns a base SshProfile-shaped plain object referencing the test
 * sshd container. The caller can spread and override individual fields.
 */
export function testSshProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-profile',
    label: 'Integration Test SSHd',
    host: SSHD_HOST,
    port: SSHD_PORT,
    username: SSHD_USER,
    authMethod: 'password' as const,
    vaultRemotePath: SSHD_ROOT,
    jumpHosts: [],
    ...overrides,
  };
}
