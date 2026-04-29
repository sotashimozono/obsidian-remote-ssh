// Phase D-β — secret redactor for the structured Logger sink.
//
// Logs ship to a rotating file in the user's vault and may be
// shared verbatim when reporting issues. Two layers of redaction:
//
//   1. **Field-name keyed**: any field whose key looks like a
//      credential gets its value replaced with `<REDACTED>` (no
//      length leakage — the *existence* of e.g. a `password`
//      field is fine to log, the value is not).
//
//   2. **String content scan**: long token-shaped substrings in
//      free-text messages get replaced with `<REDACTED:Nb>` where
//      N is the original length (length leak is acceptable here —
//      "we wrote a 36-char hex string" is much less sensitive than
//      the string itself, and N gives debug breadcrumbs).
//
// Pure: no I/O, no global state. Both functions are byte-stable
// for inputs without secrets, so the redactor doesn't churn logs
// on the common path.

const SECRET_KEY_HINTS: ReadonlyArray<string> = Object.freeze([
  'password',
  'passphrase',
  'token',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'privatekey',
  'private_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'cookie',
  'session',
]);

/**
 * Token-like substrings we redact from free-text messages.
 *
 * - **Long hex** (≥ 32 chars): SSH session tokens, server.deploy
 *   tokens, sha256 sums, host-key fingerprints — many things in
 *   this codebase mint these.
 * - **JWT-ish**: three base64url segments separated by dots,
 *   each ≥ 16 chars. Catches OAuth bearers and similar.
 * - **Long base64 / base64url** (≥ 64 chars, no spaces): private
 *   key bodies, ssh agent identities. The 64-char floor avoids
 *   false-positives on shorter base64-encoded fixtures (e.g.
 *   short user-content snippets in test logs).
 */
const TOKEN_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\b[0-9A-Fa-f]{32,}\b/g,
  /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b[A-Za-z0-9+/_-]{64,}={0,2}\b/g,
]);

/**
 * Replace token-shaped substrings inside a free-text message.
 *
 * Fast-path: returns the input string by reference when no token
 * pattern matches — keeps the hot path allocation-free for the
 * common case (most log lines don't contain secrets).
 */
export function redactString(s: string): string {
  let out = s;
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (m) => `<REDACTED:${m.length}b>`);
  }
  return out;
}

/**
 * Recursively redact a fields object: replace values whose key
 * name suggests a credential with `<REDACTED>`, and run
 * `redactString` over any remaining string values. Nested objects
 * + arrays are walked.
 *
 * Cycle-safe: a `WeakSet` tracks visited objects so a self-
 * referential field (rare but possible — e.g. a logged DOM node
 * or an Error wrapping itself) becomes `'<CYCLE>'` instead of
 * blowing the stack.
 *
 * Only enumerable own properties are visited. Symbol keys, getter
 * properties, and prototype-chain inherited keys are ignored
 * (they shouldn't appear in log fields anyway, but the explicit
 * scope keeps the redactor predictable).
 *
 * Returns a new object even when nothing was redacted — callers
 * can serialise the result without worrying about mutating the
 * original. The cost (a clone per emit) is paid once on the
 * write-to-file path, which is already disk-bound.
 */
export function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  // Seed `visited` with the top-level fields object so a self-
  // reference (e.g. `cycle.self = cycle`) is caught on the first
  // recursion, not after one needless clone of the outer level.
  const visited = new WeakSet<object>();
  visited.add(fields);
  return redactObject(fields, visited);
}

function redactObject(o: Record<string, unknown>, visited: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = isSecretKey(k) ? '<REDACTED>' : redactValue(v, visited);
  }
  return out;
}

function redactValue(v: unknown, visited: WeakSet<object>): unknown {
  if (typeof v === 'string') return redactString(v);
  if (v === null || typeof v !== 'object') return v;
  if (visited.has(v)) return '<CYCLE>';
  visited.add(v);
  if (Array.isArray(v)) return v.map((item) => redactValue(item, visited));
  // Plain object — recurse, applying key-name redaction at each
  // level. Other object subtypes (Date, Buffer, Map, Set) are
  // returned as-is; callers serialise them with their own toJSON.
  // Object.getPrototypeOf is typed as returning any; narrow to unknown so the
  // identity comparisons below stay type-safe.
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  return redactObject(v as Record<string, unknown>, visited);
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const hint of SECRET_KEY_HINTS) {
    if (lower.includes(hint)) return true;
  }
  return false;
}

// Exposed for the unit suite + downstream callers that want to
// tweak what counts as a secret-shaped key (e.g. an org-specific
// header name). Keep the array frozen — mutation here would
// silently change behaviour for every caller.
export { SECRET_KEY_HINTS };
