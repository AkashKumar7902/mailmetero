// @mailmetero/db — the SOLE vendor-file domain normalizer (core has none).
//
// Vendored blocklists are messy: stray non-domain lines, mixed case, and IDN labels. This
// is the ONE place that cleans them for seeding: lowercase → url.domainToASCII (punycode) →
// require a dot. Known junk tokens observed in the freemail list are dropped explicitly.

import { domainToASCII } from 'node:url';

/** Non-domain junk lines observed in data/vendor/freemail_domains.txt (dropped on seed). */
export const FREEMAIL_JUNK_TOKENS: ReadonlySet<string> = new Set([
  '404: not found',
  'asean-mail',
  'housefancom',
  'multiplechoices',
]);

/**
 * Normalize a raw vendor line into a storable registrable domain, or null to drop it.
 * Lowercases, converts IDN → punycode ASCII, and requires at least one dot (so bare labels
 * and the known junk tokens are rejected).
 */
export function normalizeDomainForSeed(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (lower === '' || lower.startsWith('#')) return null;
  if (FREEMAIL_JUNK_TOKENS.has(lower)) return null;

  const ascii = domainToASCII(lower);
  if (ascii === '') return null;      // invalid / unconvertible IDN
  if (!ascii.includes('.')) return null; // must be a real domain, not a bare label
  return ascii;
}
