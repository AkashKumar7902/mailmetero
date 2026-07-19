// @mailmetero/db — KbDomainsRepo (shared, domain-level; NO person columns, D7).

import type { Domain, MxEnum, Provider, VerifiabilityClass, SizeBracket, IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';
import type { KbDomainRow } from '../types.ts';

interface KbDomainRaw {
  domain: string;
  mx_enum: string | null;
  provider: string | null;
  verifiability_class: string | null;
  is_catch_all: boolean | null;
  has_spf: boolean | null;
  has_dmarc: boolean | null;
  size_bracket: string | null;
  mx_hosts: string[];
  observed_count: number;
  last_probed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function mapDomain(r: KbDomainRaw): KbDomainRow {
  return {
    domain: r.domain as Domain,
    mxEnum: r.mx_enum as MxEnum | null,
    provider: r.provider as Provider | null,
    verifiabilityClass: r.verifiability_class as VerifiabilityClass | null,
    isCatchAll: r.is_catch_all,
    hasSpf: r.has_spf,
    hasDmarc: r.has_dmarc,
    sizeBracket: r.size_bracket as SizeBracket | null,
    mxHosts: r.mx_hosts ?? [],
    observedCount: r.observed_count,
    lastProbedAt: r.last_probed_at as IsoTimestamp | null,
    expiresAt: r.expires_at as IsoTimestamp,
    createdAt: r.created_at as IsoTimestamp,
    updatedAt: r.updated_at as IsoTimestamp,
  };
}

const SELECT = `
  SELECT domain, mx_enum, provider, verifiability_class, is_catch_all, has_spf, has_dmarc,
         size_bracket, mx_hosts, observed_count, last_probed_at, expires_at, created_at, updated_at
    FROM kb.domains`;

export interface KbDomainsRepo {
  get(q: Queryable, domain: Domain): Promise<KbDomainRow | null>;
  upsertFacts(q: Queryable, row: Partial<KbDomainRow> & { domain: Domain; expiresAt: IsoTimestamp }): Promise<KbDomainRow>;
  setCatchAll(q: Queryable, domain: Domain, isCatchAll: boolean): Promise<void>;
  purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>;
}

export function createKbDomainsRepo(): KbDomainsRepo {
  return {
    async get(q, domain) {
      const row = await maybeOne<KbDomainRaw>(q, `${SELECT} WHERE domain = $1`, [domain]);
      return row ? mapDomain(row) : null;
    },

    async upsertFacts(q, row) {
      // COALESCE(EXCLUDED.col, kb.domains.col): only overwrite a fact when a new value is
      // supplied; existing facts survive a partial update. observed_count increments.
      const inserted = await maybeOne<KbDomainRaw>(
        q,
        `INSERT INTO kb.domains
           (domain, mx_enum, provider, verifiability_class, is_catch_all, has_spf, has_dmarc,
            size_bracket, mx_hosts, observed_count, last_probed_at, expires_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'{}'),1,$10,$11, now())
         ON CONFLICT (domain) DO UPDATE SET
            mx_enum             = COALESCE(EXCLUDED.mx_enum, kb.domains.mx_enum),
            provider            = COALESCE(EXCLUDED.provider, kb.domains.provider),
            verifiability_class = COALESCE(EXCLUDED.verifiability_class, kb.domains.verifiability_class),
            is_catch_all        = COALESCE(EXCLUDED.is_catch_all, kb.domains.is_catch_all),
            has_spf             = COALESCE(EXCLUDED.has_spf, kb.domains.has_spf),
            has_dmarc           = COALESCE(EXCLUDED.has_dmarc, kb.domains.has_dmarc),
            size_bracket        = COALESCE(EXCLUDED.size_bracket, kb.domains.size_bracket),
            mx_hosts            = CASE WHEN cardinality(EXCLUDED.mx_hosts) > 0 THEN EXCLUDED.mx_hosts ELSE kb.domains.mx_hosts END,
            observed_count      = kb.domains.observed_count + 1,
            last_probed_at      = COALESCE(EXCLUDED.last_probed_at, kb.domains.last_probed_at),
            expires_at          = EXCLUDED.expires_at,
            updated_at          = now()
         RETURNING domain, mx_enum, provider, verifiability_class, is_catch_all, has_spf, has_dmarc,
                   size_bracket, mx_hosts, observed_count, last_probed_at, expires_at, created_at, updated_at`,
        [
          row.domain,
          row.mxEnum ?? null,
          row.provider ?? null,
          row.verifiabilityClass ?? null,
          row.isCatchAll ?? null,
          row.hasSpf ?? null,
          row.hasDmarc ?? null,
          row.sizeBracket ?? null,
          row.mxHosts ?? null,
          row.lastProbedAt ?? null,
          row.expiresAt,
        ],
      );
      return mapDomain(inserted as KbDomainRaw);
    },

    async setCatchAll(q, domain, isCatchAll) {
      await q.query(
        `UPDATE kb.domains SET is_catch_all = $2, updated_at = now() WHERE domain = $1`,
        [domain, isCatchAll],
      );
    },

    async purgeExpired(q, now, limit) {
      return rowCount(
        q,
        `DELETE FROM kb.domains
          WHERE domain IN (SELECT domain FROM kb.domains WHERE expires_at < $1 ORDER BY expires_at LIMIT $2)`,
        [now, limit],
      );
    },
  };
}
