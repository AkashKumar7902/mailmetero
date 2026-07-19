// @mailmetero/core — name/german.ts
//
// German umlaut / eszett transliteration variants. A "Müller" may hold an account as
// mueller@ (ue transliteration) OR muller@ (bare-vowel fold). We must try both; per-domain
// fold-winner learning (KB) later decides which the company actually uses.

import type { Domain } from '@mailmetero/contracts';

/** Umlaut → digraph transliteration (the canonical German romanization). */
const UMLAUT_DIGRAPH: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
];

/** Umlaut → bare vowel (the "drop the dots" fold produced by NFKD). */
const UMLAUT_BARE: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'a'],
  [/ö/g, 'o'],
  [/ü/g, 'u'],
  [/ß/g, 'ss'],
];

function pushUnique(list: string[], value: string): void {
  if (value.length > 0 && !list.includes(value)) list.push(value);
}

/**
 * Produce the distinct German fold variants of a token, lower-cased ASCII.
 * A raw umlaut token yields its digraph + bare-vowel + collapsed forms. The digraph→bare
 * collapse only fires when the ORIGINAL token actually carried an umlaut: a coincidental
 * ue/oe/ae in an ordinary name ("Bauer", "Samuel", "Neuer") must NOT spawn a bogus baur/
 * samul/neur candidate, and such digraphs are indistinguishable from a genuine
 * transliteration without the source umlaut.
 *
 * Examples:
 *   "Müller"  → ["mueller", "muller"]
 *   "mueller" → ["mueller"]   (no umlaut ⇒ no collapse; can't tell from "Samuel")
 *   "Bauer"   → ["bauer"]
 *   "Weiß"    → ["weiss"]
 *   "Schmidt" → ["schmidt"]
 */
export function germanFoldVariants(token: string): string[] {
  const lower = token.trim().toLowerCase();
  const variants: string[] = [];

  // 1. Digraph transliteration of any raw umlauts.
  let digraph = lower;
  for (const [re, rep] of UMLAUT_DIGRAPH) digraph = digraph.replace(re, rep);
  digraph = digraph.replace(/[^a-z0-9]/g, '');
  pushUnique(variants, digraph);

  // 2. Bare-vowel fold of any raw umlauts.
  let bare = lower;
  for (const [re, rep] of UMLAUT_BARE) bare = bare.replace(re, rep);
  bare = bare.replace(/[^a-z0-9]/g, '');
  pushUnique(variants, bare);

  // 3. Collapse an already-transliterated digraph back to a bare vowel
  //    (mueller → muller, schmoele → schmole). Only when the ORIGINAL token actually
  //    carried an umlaut — otherwise a coincidental ue/oe/ae digraph in an ordinary name
  //    (Bauer → baur, Samuel → samul, Neuer → neur) would spawn bogus candidates.
  if (/[äöü]/.test(lower)) {
    const collapsed = digraph
      .replace(/ae/g, 'a')
      .replace(/oe/g, 'o')
      .replace(/ue/g, 'u');
    pushUnique(variants, collapsed);
  }

  return variants;
}

/** Domain TLDs that strongly imply a German-speaking (DACH) org context. */
const DACH_TLDS = ['.de', '.at', '.ch', '.li'] as const;

/**
 * Heuristic: does this name/domain sit in a Germanic context (so German fold variants
 * are worth emitting)? True when the raw name carries umlauts/ß, or the domain is a
 * DACH TLD.
 */
export function isGermanicContext(rawName: string, domain: Domain | null): boolean {
  if (/[äöüß]/i.test(rawName)) return true;
  if (domain !== null) {
    const d = domain.toLowerCase();
    for (const tld of DACH_TLDS) if (d.endsWith(tld)) return true;
  }
  return false;
}
