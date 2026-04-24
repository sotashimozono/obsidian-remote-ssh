import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SshConfigEntry {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  proxyJump?: string;
}

export function readSshConfig(configPath?: string): SshConfigEntry[] {
  const filePath = configPath ?? path.join(os.homedir(), '.ssh', 'config');
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const entries: SshConfigEntry[] = [];
  let alias: string | null = null;
  let current: Partial<SshConfigEntry> = {};

  const flush = () => {
    if (alias && current.hostname) {
      entries.push(finalize(alias, current));
    }
  };

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;
    const key = line.slice(0, spaceIdx).toLowerCase();
    const value = line.slice(spaceIdx + 1).trim();

    if (key === 'host') {
      flush();
      if (value.includes('*') || value.includes('?')) {
        alias = null;
      } else {
        alias = value;
        current = {};
      }
      continue;
    }

    if (!alias) continue;

    switch (key) {
      case 'hostname':     current.hostname = value; break;
      case 'user':         current.user = value; break;
      case 'port':         current.port = parseInt(value) || 22; break;
      case 'identityfile': current.identityFile = value.replace('~', os.homedir()); break;
      case 'proxyjump':    current.proxyJump = value; break;
    }
  }

  flush();

  return entries;
}

function finalize(alias: string, e: Partial<SshConfigEntry>): SshConfigEntry {
  return {
    alias,
    hostname:     e.hostname ?? alias,
    user:         e.user ?? os.userInfo().username,
    port:         e.port ?? 22,
    identityFile: e.identityFile,
    proxyJump:    e.proxyJump,
  };
}
