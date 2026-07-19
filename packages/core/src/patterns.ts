// @mailmetero/core — patterns.ts
//
// The pattern-token grammar. A pattern token is a template over name components; rendering
// substitutes the (already ASCII-folded) parts and yields a local part, or null when a
// referenced component is missing. Tokens are the KEY shape shared with kb.pattern_priors
// and kb.domain_patterns.
//
// Placeholders:
//   {first} {last} {middle}   full folded components
//   {f} {l} {m}               single-letter initials
// Literal separators ('.', '_', '-') pass through verbatim.

import type { PatternToken } from '@mailmetero/contracts';

export interface PatternVars {
  first: string | null;
  last: string | null;
  middle: string | null;
  f: string | null;
  l: string | null;
  m: string | null;
}

/**
 * The closed set of pattern tokens the engine knows how to render / learn. Ordered roughly
 * by real-world prevalence (drives seed priors). Additions are a spec change.
 */
export const KNOWN_PATTERN_TOKENS: ReadonlySet<string> = new Set<string>([
  '{first}.{last}',
  '{first}{last}',
  '{f}{last}',
  '{first}{l}',
  '{f}.{last}',
  '{first}',
  '{last}',
  '{first}_{last}',
  '{first}-{last}',
  '{last}.{first}',
  '{last}{first}',
  '{last}.{f}',
  '{last}{f}',
  '{f}{l}',
  '{f}.{l}',
  '{first}.{m}.{last}',
  '{f}{m}{last}',
  '{first}{m}{last}',
  '{f}{last}{l}',
]);

const PLACEHOLDER = /\{(first|last|middle|f|l|m)\}/g;

/** True (and narrows) when `token` is one of the known pattern tokens. */
export function isKnownPatternToken(token: string): token is PatternToken {
  return KNOWN_PATTERN_TOKENS.has(token);
}

/**
 * Render a pattern token against the supplied vars. Returns the lower-cased local part, or
 * null if any referenced placeholder resolves to a null/empty component (so callers never
 * emit a half-formed address like `.smith`).
 */
export function renderPattern(token: PatternToken, vars: PatternVars): string | null {
  let missing = false;
  const out = token.replace(PLACEHOLDER, (_match, key: string) => {
    const value = resolve(key, vars);
    if (value === null || value.length === 0) {
      missing = true;
      return '';
    }
    return value;
  });
  if (missing) return null;
  const cleaned = out.toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

function resolve(key: string, vars: PatternVars): string | null {
  switch (key) {
    case 'first':
      return vars.first;
    case 'last':
      return vars.last;
    case 'middle':
      return vars.middle;
    case 'f':
      return vars.f ?? initial(vars.first);
    case 'l':
      return vars.l ?? initial(vars.last);
    case 'm':
      return vars.m ?? initial(vars.middle);
    default:
      return null;
  }
}

function initial(component: string | null): string | null {
  if (component === null || component.length === 0) return null;
  return component.charAt(0);
}
