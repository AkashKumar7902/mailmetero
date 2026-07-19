// @mailmetero/core — canonicalize.ts
//
// The SOLE place where the branded primitives `EmailAddress`, `Domain`, and `LocalPart`
// are minted. Everything downstream trusts that a value of these types is already
// lower-cased, punycode-normalized, +tag-stripped, and PSL-reduced to eTLD+1.
//
// Pure: the only "I/O" is tldts' bundled Public Suffix List (in-memory) and node:url's
// IDNA/punycode implementation. No network, no filesystem.

import { getDomain } from 'tldts';
import type {
  EmailAddress,
  Domain,
  LocalPart,
  ReasonCode,
  SubStatus,
} from '@mailmetero/contracts';

/** RFC 5321 dot-atom local part (the subset we canonicalize to / accept). */
const LOCAL_PART_ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** Strip a URL scheme, path, port, and userinfo so a raw "https://www.ACME.co.uk/x" reduces to a host. */
function extractHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.length === 0) return host;
  // Drop an explicit scheme.
  const scheme = host.indexOf('://');
  if (scheme !== -1) host = host.slice(scheme + 3);
  // Drop userinfo.
  const at = host.lastIndexOf('@');
  if (at !== -1) host = host.slice(at + 1);
  // Drop path / query / fragment.
  host = host.split(/[/?#]/, 1)[0] ?? '';
  // Drop port.
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  // Drop a trailing dot (fully-qualified form).
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/** Convert a unicode host to its ASCII (punycode / IDNA) form. Returns null if unencodable. */
function toAsciiHost(host: string): string | null {
  if (host.length === 0) return null;
  // Fast path: already ASCII.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(host)) return host;
  try {
    const url = new URL(`http://${host}`);
    // hostname is IDNA/punycode-encoded ASCII.
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize a local part: trim + lowercase. Does NOT strip +tag (that is an
 * address-level decision made by `canonicalizeEmail`). Never returns null — a local
 * part is a free string; syntax validity is a separate concern (`isValidLocalPartSyntax`).
 */
export function canonicalizeLocalPart(raw: string): LocalPart {
  return raw.trim().toLowerCase() as LocalPart;
}

/**
 * Canonicalize a domain to registrable eTLD+1, punycode, lower-cased.
 * Returns null when the input has no registrable domain (bare TLD, garbage, IP literal).
 */
export function canonicalizeDomain(raw: string): Domain | null {
  const host = extractHost(raw);
  if (host.length === 0) return null;
  const ascii = toAsciiHost(host);
  if (ascii === null) return null;
  // tldts reduces to the registrable domain (eTLD+1) using the bundled PSL.
  const registrable = getDomain(ascii, { allowPrivateDomains: false });
  if (registrable === null || registrable.length === 0) return null;
  if (!registrable.includes('.')) return null;
  return registrable.toLowerCase() as Domain;
}

/**
 * Canonicalize a full email address: lower-case, strip exactly one `+tag` from the
 * local part, and PSL-normalize the domain. Returns null when the shape is not
 * `local@domain` or the domain has no registrable form.
 */
export function canonicalizeEmail(raw: string): EmailAddress | null {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const localRaw = trimmed.slice(0, at);
  const domainRaw = trimmed.slice(at + 1);

  const plus = localRaw.indexOf('+');
  const localCore = plus === -1 ? localRaw : localRaw.slice(0, plus);
  if (localCore.length === 0) return null;

  const domain = canonicalizeDomain(domainRaw);
  if (domain === null) return null;

  return `${localCore}@${domain}` as EmailAddress;
}

/** True when `local` is a valid (canonicalized) RFC 5321 dot-atom local part, length ≤ 64. */
export function isValidLocalPartSyntax(local: string): boolean {
  if (local.length === 0 || local.length > 64) return false;
  return LOCAL_PART_ATOM.test(local);
}

export type SyntaxVerdict =
  | { ok: true; email: EmailAddress; localPart: LocalPart; domain: Domain }
  | {
      ok: false;
      reasonCode: Extract<ReasonCode, 'invalid_syntax'>;
      subStatus: Extract<SubStatus, 'invalid_syntax'>;
    };

const INVALID_SYNTAX: Extract<SyntaxVerdict, { ok: false }> = {
  ok: false,
  reasonCode: 'invalid_syntax',
  subStatus: 'invalid_syntax',
};

/**
 * The syntax gate (pipeline stage 0). Accepts a raw address string and either returns
 * its canonical brands or a frozen `invalid_syntax` verdict — the FREE, unbilled reject.
 */
export function validateEmailSyntax(raw: string): SyntaxVerdict {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return INVALID_SYNTAX;

  const localRaw = trimmed.slice(0, at);
  const plus = localRaw.indexOf('+');
  const localCore = plus === -1 ? localRaw : localRaw.slice(0, plus);
  if (!isValidLocalPartSyntax(localCore)) return INVALID_SYNTAX;

  const domain = canonicalizeDomain(trimmed.slice(at + 1));
  if (domain === null) return INVALID_SYNTAX;

  const email = `${localCore}@${domain}` as EmailAddress;
  return {
    ok: true,
    email,
    localPart: localCore as LocalPart,
    domain,
  };
}
