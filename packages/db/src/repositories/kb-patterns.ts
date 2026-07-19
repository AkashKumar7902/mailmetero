// @mailmetero/db — KbDomainPatternsRepo (D7 verified_count write-guard).
//
// `bumpVerified` MUST NOT increment verified_count on an accept-all domain: a 250 from a
// catch-all proves nothing about the specific pattern, so treating it as verification would
// poison the learned-pattern signal. On accept-all we still bump observed_count only.

import type { Domain, PatternToken, IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { rows } from '../client.ts';
import type { KbDomainPatternRow } from '../types.ts';

interface KbPatternRaw {
  id: string;
  domain: string;
  pattern_token: string;
  observed_count: number;
  verified_count: number;
  winning_fold: string | null;
  last_seen_at: string;
  created_at: string;
}

function mapPattern(r: KbPatternRaw): KbDomainPatternRow {
  return {
    id: String(r.id),
    domain: r.domain as Domain,
    patternToken: r.pattern_token as PatternToken,
    observedCount: r.observed_count,
    verifiedCount: r.verified_count,
    winningFold: r.winning_fold,
    lastSeenAt: r.last_seen_at as IsoTimestamp,
    createdAt: r.created_at as IsoTimestamp,
  };
}

export interface KbDomainPatternsRepo {
  listForDomain(q: Queryable, domain: Domain): Promise<KbDomainPatternRow[]>;
  bumpObserved(q: Queryable, domain: Domain, pattern: PatternToken, winningFold?: string): Promise<void>;
  /** acceptAll ⇒ verified_count is NOT incremented (D7 write-guard); observed still bumps. */
  bumpVerified(q: Queryable, domain: Domain, pattern: PatternToken, domainIsAcceptAll: boolean): Promise<void>;
}

export function createKbDomainPatternsRepo(): KbDomainPatternsRepo {
  return {
    async listForDomain(q, domain) {
      const rs = await rows<KbPatternRaw>(
        q,
        `SELECT id, domain, pattern_token, observed_count, verified_count, winning_fold, last_seen_at, created_at
           FROM kb.domain_patterns
          WHERE domain = $1
          ORDER BY verified_count DESC, observed_count DESC`,
        [domain],
      );
      return rs.map(mapPattern);
    },

    async bumpObserved(q, domain, pattern, winningFold) {
      await q.query(
        `INSERT INTO kb.domain_patterns (domain, pattern_token, observed_count, verified_count, winning_fold, last_seen_at)
         VALUES ($1, $2, 1, 0, $3, now())
         ON CONFLICT (domain, pattern_token) DO UPDATE SET
           observed_count = kb.domain_patterns.observed_count + 1,
           winning_fold   = COALESCE(EXCLUDED.winning_fold, kb.domain_patterns.winning_fold),
           last_seen_at   = now()`,
        [domain, pattern, winningFold ?? null],
      );
    },

    async bumpVerified(q, domain, pattern, domainIsAcceptAll) {
      // verified_count only advances when the domain is NOT accept-all (CHECK verified<=observed
      // is preserved because observed advances at least as fast).
      const verifiedInc = domainIsAcceptAll ? 0 : 1;
      await q.query(
        `INSERT INTO kb.domain_patterns (domain, pattern_token, observed_count, verified_count, last_seen_at)
         VALUES ($1, $2, 1, $3, now())
         ON CONFLICT (domain, pattern_token) DO UPDATE SET
           observed_count = kb.domain_patterns.observed_count + 1,
           verified_count = kb.domain_patterns.verified_count + $3,
           last_seen_at   = now()`,
        [domain, pattern, verifiedInc],
      );
    },
  };
}
