// @mailmetero/core — classify.ts
//
// Pure classifiers over INJECTED lookup sets (the live sets live in Postgres; the db seed
// ships the builtins). Role-local (RFC 2142+), freemail/disposable domain, and typo-domain
// correction. Also assembles a `DomainInput` from a raw domain string.

import type {
  Domain,
  DomainInput,
  LocalPart,
  SizeBracket,
} from '@mailmetero/contracts';
import { canonicalizeDomain, canonicalizeLocalPart } from './canonicalize.ts';

/**
 * RFC 2142 role mailboxes + the common commercial extensions BounceZero treats as role
 * accounts (excluded from person results). The live set is DB-backed; this is the seed.
 */
export const ROLE_LOCALS_BUILTIN: ReadonlySet<string> = new Set([
  // RFC 2142
  'postmaster', 'hostmaster', 'webmaster', 'abuse', 'noc', 'security',
  'info', 'marketing', 'sales', 'support', 'admin', 'root',
  // common extensions
  'help', 'helpdesk', 'contact', 'hello', 'hi', 'team', 'office',
  'careers', 'jobs', 'hr', 'recruiting', 'recruitment', 'billing',
  'accounts', 'accounting', 'finance', 'legal', 'privacy', 'compliance',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon',
  'newsletter', 'news', 'press', 'media', 'pr', 'enquiries', 'inquiries',
  'service', 'services', 'orders', 'shop', 'store', 'feedback',
  'notifications', 'notification', 'alerts', 'system', 'daemon', 'webhook',
]);

export interface ClassificationTables {
  freemail: ReadonlySet<string>;
  disposable: ReadonlySet<string>;
  roleLocals: ReadonlySet<string>;
  typoDomains: ReadonlyMap<string, Domain>;
}

/** True when the local part is a role/generic mailbox (not a person). */
export function classifyRoleLocal(
  localPart: LocalPart | string,
  roleLocals: ReadonlySet<string> = ROLE_LOCALS_BUILTIN,
): boolean {
  const local = localPart.trim().toLowerCase();
  if (local.length === 0) return false;
  if (roleLocals.has(local)) return true;
  // Normalize separators so 'no_reply' / 'no.reply' collapse onto 'no-reply' family.
  const collapsed = local.replace(/[._]/g, '-');
  return collapsed !== local && roleLocals.has(collapsed);
}

/**
 * Correct a typo domain (e.g. gnail.com → gmail.com) via the injected table.
 * Returns the corrected `Domain`, or null when the domain is not a known typo.
 */
export function correctTypoDomain(
  domain: Domain,
  typoDomains: ReadonlyMap<string, Domain>,
): Domain | null {
  return typoDomains.get(domain.toLowerCase()) ?? null;
}

/**
 * Build a `DomainInput` from a raw domain string: canonicalize to eTLD+1 (punycode,
 * lower-cased) and classify freemail/disposable against the injected sets. Returns null
 * when the raw string has no registrable domain.
 */
export function classifyDomainInput(
  raw: string,
  tables: Pick<ClassificationTables, 'freemail' | 'disposable'>,
  sizeBracket: SizeBracket | null = null,
): DomainInput | null {
  const domain = canonicalizeDomain(raw);
  if (domain === null) return null;
  return {
    raw,
    domain,
    isFreemail: tables.freemail.has(domain),
    isDisposable: tables.disposable.has(domain),
    sizeBracket,
  };
}

/** Convenience: is this a role local part, using a canonicalized local? (kept for symmetry) */
export function isRoleLocalPart(
  raw: string,
  roleLocals: ReadonlySet<string> = ROLE_LOCALS_BUILTIN,
): boolean {
  return classifyRoleLocal(canonicalizeLocalPart(raw), roleLocals);
}
