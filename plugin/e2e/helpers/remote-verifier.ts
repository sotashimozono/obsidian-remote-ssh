import { Client } from 'ssh2';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 2222;
const TEST_USER = 'tester';
const TEST_VAULT_REMOTE = `/home/${TEST_USER}/vault`;

const PRIVATE_KEY_PATH = path.resolve(
  __dirname, '..', '..', '..', 'docker', 'keys', 'id_test',
);

/**
 * Direct SSH/SFTP connection to the Docker test sshd for verifying
 * that plugin operations landed on the remote filesystem.
 *
 * This bypasses the plugin entirely — it's the "ground truth" check.
 */
export class RemoteVerifier {
  private client: Client | null = null;

  /** Try to connect. Returns false if the sshd is unreachable. */
  async connect(): Promise<boolean> {
    if (!fs.existsSync(PRIVATE_KEY_PATH)) return false;

    return new Promise<boolean>((resolve) => {
      const client = new Client();
      const timer = setTimeout(() => {
        client.destroy();
        resolve(false);
      }, 10_000);

      client.on('ready', () => {
        clearTimeout(timer);
        this.client = client;
        resolve(true);
      });

      client.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });

      client.connect({
        host: TEST_HOST,
        port: TEST_PORT,
        username: TEST_USER,
        privateKey: fs.readFileSync(PRIVATE_KEY_PATH),
      });
    });
  }

  /** Check if a file exists on the remote. */
  async exists(relativePath: string): Promise<boolean> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(false); return; }
        sftp.stat(fullPath, (statErr) => {
          sftp.end();
          resolve(!statErr);
        });
      });
    });
  }

  /** Read file content from the remote. Returns null if not found. */
  async readFile(relativePath: string): Promise<string | null> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(null); return; }
        sftp.readFile(fullPath, 'utf8', (readErr, data) => {
          sftp.end();
          if (readErr) { resolve(null); return; }
          resolve(typeof data === 'string' ? data : data.toString('utf8'));
        });
      });
    });
  }

  /** List files in a remote directory. */
  async listDir(relativePath: string): Promise<string[]> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve([]); return; }
        sftp.readdir(fullPath, (readErr, list) => {
          sftp.end();
          if (readErr) { resolve([]); return; }
          resolve(list.map((e) => e.filename).filter((n) => n !== '.' && n !== '..'));
        });
      });
    });
  }

  /** Write a file on the remote (for test setup). */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve, reject) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftp.writeFile(fullPath, content, (writeErr) => {
          sftp.end();
          if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    });
  }

  /** Delete a file on the remote (for test cleanup). */
  async removeFile(relativePath: string): Promise<void> {
    const fullPath = `${TEST_VAULT_REMOTE}/${relativePath}`;
    return new Promise((resolve) => {
      this.requireClient().sftp((err, sftp) => {
        if (err) { resolve(); return; }
        sftp.unlink(fullPath, () => {
          sftp.end();
          resolve();
        });
      });
    });
  }

  async disconnect(): Promise<void> {
    this.client?.end();
    this.client = null;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('RemoteVerifier: not connected');
    return this.client;
  }
}
