/**
 * Format a sha256 hex fingerprint into colon-separated byte pairs
 * (`aa:bb:cc:...`) for readability. Matches the convention OpenSSH
 * uses when printing fingerprints in non-base64 form.
 */
export function formatFingerprint(hex: string): string {
  const clean = hex.toLowerCase().replace(/[^0-9a-f]/g, '');
  const pairs: string[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    pairs.push(clean.slice(i, i + 2));
  }
  return pairs.join(':');
}
