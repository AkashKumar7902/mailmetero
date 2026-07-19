// @mailmetero/core — name/surname.ts
//
// Compound / punctuated surname expansion, capped at SURNAME_VARIANT_CAP variants (PRD P0-2).
// "van der Berg", "O'Brien", "Smith-Jones", "de la Cruz" each have several plausible local-part
// forms; we emit at most 2 distinct ASCII candidates so the permutation space stays bounded.

import { nfkdAsciiFold } from './normalize.ts';

/** PRD P0-2: never emit more than 2 compound-surname variants. */
export const SURNAME_VARIANT_CAP = 2 as const;

/** Nobiliary / connective particles that are frequently dropped from a local part. */
const PARTICLES: ReadonlySet<string> = new Set([
  'van', 'von', 'de', 'del', 'della', 'der', 'den', 'la', 'le', 'el',
  'da', 'di', 'do', 'dos', 'das', 'du', 'des', 'ter', 'ten', 'al', 'bin',
  'ibn', 'mac', 'mc', 'st', 'san', 'santa',
]);

function pushUnique(list: string[], value: string): void {
  if (value.length > 0 && !list.includes(value)) list.push(value);
}

/**
 * Expand a raw last name into ≤2 ASCII local-part variants, most-likely first.
 *
 * Strategy (ordered by likelihood, deduped, then clamped to the cap):
 *   1. Full concatenation of every segment           ("vanderberg", "obrien", "smithjones")
 *   2. The final significant (non-particle) segment  ("berg", "brien", "jones")
 *
 * A single simple surname returns just its fold (["smith"]).
 */
export function expandSurnameVariants(rawLastName: string): string[] {
  const trimmed = rawLastName.trim();
  if (trimmed.length === 0) return [];

  // Split on whitespace, hyphens, and apostrophes into raw segments.
  const segments = trimmed
    .split(/[\s\-'’]+/)
    .map((seg) => nfkdAsciiFold(seg))
    .filter((seg) => seg.length > 0);

  if (segments.length === 0) return [];
  if (segments.length === 1) return [segments[0] as string];

  const variants: string[] = [];

  // 1. Full concatenation of all segments.
  pushUnique(variants, segments.join(''));

  // 2. Last significant (non-particle) segment.
  let lastSignificant: string | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i] as string;
    if (!PARTICLES.has(seg)) {
      lastSignificant = seg;
      break;
    }
  }
  if (lastSignificant !== null) pushUnique(variants, lastSignificant);

  // 3. Fallback: concatenation of significant segments only (drop leading particles).
  const significant = segments.filter((seg) => !PARTICLES.has(seg));
  if (significant.length > 0) pushUnique(variants, significant.join(''));

  return variants.slice(0, SURNAME_VARIANT_CAP);
}
