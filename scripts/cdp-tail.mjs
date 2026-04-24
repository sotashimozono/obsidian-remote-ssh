#!/usr/bin/env node
/*
 * CDP tail — connect to Obsidian's Chrome DevTools Protocol endpoint
 * and stream Runtime.consoleAPICalled / Runtime.exceptionThrown events
 * to stdout AND to ./cdp-console.log.
 *
 * Usage:
 *   1. Launch Obsidian with `--remote-debugging-port=9222`
 *      (Windows: edit the shortcut "Target" field; macOS/Linux: pass via argv)
 *   2. node scripts/cdp-tail.mjs
 *
 * Requires Node 22+ (built-in WebSocket).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const CDP_HOST = process.env.CDP_HOST ?? '127.0.0.1';
const CDP_PORT = process.env.CDP_PORT ?? '9222';
const OUT_FILE = path.resolve(process.cwd(), 'cdp-console.log');

if (typeof globalThis.WebSocket !== 'function') {
  console.error('Node 22+ is required (built-in WebSocket). Current:', process.version);
  process.exit(1);
}

async function fetchTargets() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json`);
  if (!res.ok) throw new Error(`CDP /json returned ${res.status}`);
  return res.json();
}

function pickTarget(targets) {
  // Prefer "page" type targets that are obsidian app windows; skip extensions.
  const pages = targets.filter(t => t.type === 'page' && !/^chrome-extension:/.test(t.url));
  if (pages.length === 0) {
    throw new Error('No suitable CDP target found. Make sure Obsidian is running with --remote-debugging-port=' + CDP_PORT);
  }
  return pages[0];
}

function appendOut(line) {
  fs.appendFile(OUT_FILE, line + '\n', () => {});
}

function fmtArg(arg) {
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.description) return arg.description;
  return arg.type ?? '<unknown>';
}

async function main() {
  const targets = await fetchTargets();
  const target = pickTarget(targets);
  const wsUrl = target.webSocketDebuggerUrl;
  console.error(`[cdp-tail] connecting to ${target.title || target.url}`);
  console.error(`[cdp-tail] writing to ${OUT_FILE}`);

  const ws = new WebSocket(wsUrl);
  let nextId = 1;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.enable' }));
    console.error('[cdp-tail] connected');
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
    catch { return; }

    if (msg.method === 'Runtime.consoleAPICalled') {
      const { type, args, timestamp } = msg.params;
      const ts = new Date(timestamp).toISOString();
      const text = (args ?? []).map(fmtArg).join(' ');
      const line = `[${ts}] [console.${type}] ${text}`;
      console.log(line);
      appendOut(line);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const e = msg.params.exceptionDetails;
      const ts = new Date(msg.params.timestamp).toISOString();
      const desc = e?.exception?.description ?? e?.text ?? '<unknown exception>';
      const line = `[${ts}] [exception] ${desc}`;
      console.log(line);
      appendOut(line);
    }
  });

  ws.addEventListener('close', () => {
    console.error('[cdp-tail] connection closed');
    process.exit(0);
  });

  ws.addEventListener('error', (e) => {
    console.error('[cdp-tail] websocket error:', e.message ?? e);
  });
}

main().catch(err => {
  console.error('[cdp-tail] fatal:', err.message ?? err);
  process.exit(1);
});
