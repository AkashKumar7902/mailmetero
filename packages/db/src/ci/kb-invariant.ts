// @mailmetero/db — the AUTHORITATIVE D7 gate (kb.* has NO person columns).
//
// The launch gate is the RUNTIME introspection below: after migrating a scratch DB it reads
// information_schema and fails if any kb.* column is (a) not in the conscious allowlist, or
// (b) matches the person-data denylist. A source grep over the migrations is a secondary
// backstop only. role_locals.local_part and domain_patterns.pattern_token are intentionally
// allowlisted; the denylist regex is written to NOT match them.

import type { Queryable } from '../client.ts';
import { rows } from '../client.ts';

export const KB_COLUMN_ALLOWLIST: ReadonlySet<string> = new Set([
  // kb.domains
  'domain', 'mx_enum', 'provider', 'verifiability_class', 'is_catch_all', 'has_spf', 'has_dmarc',
  'size_bracket', 'mx_hosts', 'observed_count', 'last_probed_at', 'expires_at', 'created_at', 'updated_at',
  // kb.domain_patterns
  'id', 'pattern_token', 'verified_count', 'winning_fold', 'last_seen_at',
  // kb.provider_fingerprints
  'mx_suffix', 'priority', 'notes',
  // kb.pattern_priors
  'share', 'rank',
  // kb.blend_weights
  'version', 'source', 'domain_verified_support', 'verification_outcome_quality', 'recency_decay',
  'size_conditioned_prior_floor', 'caps', 'bands', 'is_active',
  // kb.freemail_domains / kb.disposable_domains / kb.typo_domains / kb.role_locals
  'typo', 'correction', 'local_part', 'rfc2142',
]);

export const PERSON_COLUMN_DENYLIST =
  /(^|_)(first|last|middle|full|given|sur|display|person|people|contact)_?name|(^|_)e?mail(_|$)|(^|_)mailbox|(^|_)recipient|(^|_)phone/i;

export class KbInvariantError extends Error {
  readonly offenders: readonly string[];
  constructor(offenders: readonly string[]) {
    super(`kb.* schema invariant violated (D7). Offending columns:\n  - ${offenders.join('\n  - ')}`);
    this.name = 'KbInvariantError';
    this.offenders = offenders;
  }
}

/**
 * Introspect information_schema for every column under schema `kb` and throw
 * KbInvariantError listing any column that is not consciously allowlisted OR that matches
 * the person-data denylist. Passing means the KB is provably domain-level only.
 */
export async function assertKbHasNoPersonColumns(q: Queryable): Promise<void> {
  const cols = await rows<{ table_name: string; column_name: string }>(
    q,
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'kb'
      ORDER BY table_name, ordinal_position`,
  );
  const offenders: string[] = [];
  for (const c of cols) {
    const name = c.column_name;
    if (PERSON_COLUMN_DENYLIST.test(name)) {
      offenders.push(`kb.${c.table_name}.${name} (matches person-data denylist)`);
      continue;
    }
    if (!KB_COLUMN_ALLOWLIST.has(name)) {
      offenders.push(`kb.${c.table_name}.${name} (not in KB_COLUMN_ALLOWLIST)`);
    }
  }
  if (offenders.length > 0) throw new KbInvariantError(offenders);
}
