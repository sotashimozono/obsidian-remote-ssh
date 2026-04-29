import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '../src/util/logger';

/**
 * Phase D-β coverage for the structured Logger:
 *
 *   - In-memory ring + listener pattern still work (backward
 *     compat for the dev devtools "open log" panel).
 *   - File sink emits **JSONL** (one JSON object per line) with
 *     the new schema {ts, level, msg, fields?}.
 *   - Optional `fields` overload on every emit method threads a
 *     structured payload through both listener and file sink.
 *   - Secret redaction (delegated to `util/redact.ts`, covered
 *     more thoroughly in `Redact.test.ts`) fires before any
 *     listener / sink sees the payload.
 *   - Existing single-arg call sites
 *     (`logger.info("connected")`) remain green — no churn at
 *     callers.
 */

let tmpDir: string;
let logFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-jsonl-'));
  logFile = path.join(tmpDir, 'console.log');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readJsonl(): Array<Record<string, unknown>> {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── in-memory ring + listener (backward compat) ─────────────────────────

describe('Logger — in-memory ring + listeners (backward compat)', () => {
  it('captures info/warn/error to the in-memory ring with the existing fields', () => {
    const log = new Logger(50, true);
    log.info('connected');
    log.warn('flake');
    log.error('boom');
    const lines = log.getLines();
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    expect(lines.map((l) => l.message)).toEqual(['connected', 'flake', 'boom']);
  });

  it('listener receives every line; unsubscribe stops further deliveries', () => {
    const log = new Logger(50, false);
    const seen: string[] = [];
    const off = log.onLine((l) => seen.push(l.message));
    log.info('a');
    log.info('b');
    off();
    log.info('c');
    expect(seen).toEqual(['a', 'b']);
  });
});

// ── new: structured fields overload ─────────────────────────────────────

describe('Logger — fields overload', () => {
  it('threads optional fields through the in-memory ring', () => {
    const log = new Logger(50, false);
    log.info('connected', { profile: 'staging', host: '157.x.y.z' });
    const line = log.getLines()[0];
    expect(line.fields).toEqual({ profile: 'staging', host: '157.x.y.z' });
  });

  it('omits the `fields` key entirely when no fields are passed (back-compat)', () => {
    const log = new Logger(50, false);
    log.info('connected');
    const line = log.getLines()[0];
    expect('fields' in line).toBe(false);
  });

  it('redacts secret-keyed values before any listener sees them', () => {
    const log = new Logger(50, false);
    const seen: Array<Record<string, unknown> | undefined> = [];
    log.onLine((l) => seen.push(l.fields));
    log.info('auth', { token: 'sekrit', host: 'h' });
    expect(seen[0]).toEqual({ token: '<REDACTED>', host: 'h' });
  });

  it('redacts token-shaped substrings inside the message body', () => {
    const log = new Logger(50, false);
    log.info('uploaded with token=' + 'a'.repeat(40));
    expect(log.getLines()[0].message).toBe('uploaded with token=<REDACTED:40b>');
  });
});

// ── file sink: JSONL format ─────────────────────────────────────────────

describe('Logger — JSONL file sink', () => {
  it('writes one JSON object per line with {ts, level, msg}', async () => {
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    log.info('hello');
    await log.uninstallFileSink();
    const [line] = readJsonl();
    expect(line).toMatchObject({ level: 'info', msg: 'hello' });
    expect(typeof line.ts).toBe('string');
    expect(line.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect('fields' in line).toBe(false); // omitted when absent
  });

  it('serialises optional fields under a `fields` key', async () => {
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    log.info('write', { path: 'a.md', bytes: 42 });
    await log.uninstallFileSink();
    const [line] = readJsonl();
    expect(line.fields).toEqual({ path: 'a.md', bytes: 42 });
  });

  it('redacts secret-keyed values in the serialised JSONL', async () => {
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    log.info('connected', { token: 'sekrit', user: 'alice' });
    await log.uninstallFileSink();
    const [line] = readJsonl();
    expect(line.fields).toEqual({ token: '<REDACTED>', user: 'alice' });
  });

  it('survives a circular-reference field — redactor breaks the cycle', async () => {
    // Self-referential field would normally crash JSON.stringify
    // and (before the redactor's WeakSet) blow the recursion stack.
    // The redactor's cycle detection substitutes `<CYCLE>` for the
    // back-edge, leaving a serialisable result — the line lands
    // without needing the file sink's fallback path.
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    const cycle: Record<string, unknown> = { name: 'a' };
    cycle.self = cycle;
    log.info('weird', cycle);
    await log.uninstallFileSink();
    const [line] = readJsonl();
    expect(line.msg).toBe('weird');
    expect(line.fields).toEqual({ name: 'a', self: '<CYCLE>' });
  });

  it('rotates when the sink crosses the size cap (smoke)', async () => {
    // The rotation policy + cap are pre-existing; this test asserts
    // a JSONL file at the rotation path still lands when many lines
    // are written. We don't exercise the cap directly (5 MB is a
    // lot of lines) — just confirm the sink keeps writing line-
    // delimited JSON for a substantial burst.
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    for (let i = 0; i < 200; i++) log.info(`line ${i}`, { i });
    await log.uninstallFileSink();
    const lines = readJsonl();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toMatchObject({ msg: 'line 0', fields: { i: 0 } });
    expect(lines[199]).toMatchObject({ msg: 'line 199', fields: { i: 199 } });
  });
});

// ── debug-level gating still works ──────────────────────────────────────

describe('Logger — debug gating', () => {
  it('drops debug emits when debug=false (default)', async () => {
    const log = new Logger(50, false);
    log.installFileSink(logFile);
    log.debug_('quiet');
    log.info('loud');
    await log.uninstallFileSink();
    const lines = readJsonl();
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe('loud');
  });

  it('passes debug emits through when debug=true', async () => {
    const log = new Logger(50, true);
    log.installFileSink(logFile);
    log.debug_('chatty');
    await log.uninstallFileSink();
    const [line] = readJsonl();
    expect(line.level).toBe('debug');
  });
});
