// @mailmetero/db — KbClassificationRepo.
//
// Lookups (freemail / disposable / role / typo) for the classification pipeline stage, plus
// the bulk replace/upsert loaders the seed migration and the weekly blocklist-sync cron call
// (both re-seed from vendored files — no network egress).

import type { Domain, LocalPart } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';
import type { KbRoleLocalRow, KbTypoDomainRow } from '../types.ts';

export interface KbClassificationRepo {
  isFreemail(q: Queryable, domain: Domain): Promise<boolean>;
  isDisposable(q: Queryable, domain: Domain): Promise<boolean>;
  isRoleLocal(q: Queryable, localPart: LocalPart): Promise<boolean>;
  typoCorrection(q: Queryable, domain: string): Promise<Domain | null>;
  replaceFreemail(q: Queryable, domains: string[]): Promise<number>;
  replaceDisposable(q: Queryable, domains: string[]): Promise<number>;
  upsertRoleLocals(q: Queryable, rows: KbRoleLocalRow[]): Promise<number>;
  upsertTypos(q: Queryable, rows: KbTypoDomainRow[]): Promise<number>;
}

async function existsRow(q: Queryable, text: string, params: unknown[]): Promise<boolean> {
  const row = await maybeOne<{ ok: boolean }>(q, text, params);
  return row !== null;
}

/** Insert a large domain list in chunks (avoids exceeding the bind-parameter limit). */
async function insertDomainsIdempotent(q: Queryable, table: string, domains: string[]): Promise<number> {
  const CHUNK = 1000;
  let inserted = 0;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const chunk = domains.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const values = chunk.map((_, idx) => `($${idx + 1})`).join(', ');
    inserted += await rowCount(
      q,
      `INSERT INTO ${table} (domain) VALUES ${values} ON CONFLICT (domain) DO NOTHING`,
      chunk,
    );
  }
  return inserted;
}

export function createKbClassificationRepo(): KbClassificationRepo {
  return {
    async isFreemail(q, domain) {
      return existsRow(q, `SELECT true AS ok FROM kb.freemail_domains WHERE domain = $1`, [domain]);
    },
    async isDisposable(q, domain) {
      return existsRow(q, `SELECT true AS ok FROM kb.disposable_domains WHERE domain = $1`, [domain]);
    },
    async isRoleLocal(q, localPart) {
      return existsRow(q, `SELECT true AS ok FROM kb.role_locals WHERE local_part = $1`, [localPart]);
    },
    async typoCorrection(q, domain) {
      const row = await maybeOne<{ correction: string }>(
        q,
        `SELECT correction FROM kb.typo_domains WHERE typo = $1`,
        [domain],
      );
      return row ? (row.correction as Domain) : null;
    },

    async replaceFreemail(q, domains) {
      return insertDomainsIdempotent(q, 'kb.freemail_domains', domains);
    },
    async replaceDisposable(q, domains) {
      return insertDomainsIdempotent(q, 'kb.disposable_domains', domains);
    },

    async upsertRoleLocals(q, rowsIn) {
      let n = 0;
      for (const r of rowsIn) {
        n += await rowCount(
          q,
          `INSERT INTO kb.role_locals (local_part, rfc2142) VALUES ($1, $2)
           ON CONFLICT (local_part) DO UPDATE SET rfc2142 = EXCLUDED.rfc2142`,
          [r.localPart, r.rfc2142],
        );
      }
      return n;
    },

    async upsertTypos(q, rowsIn) {
      let n = 0;
      for (const r of rowsIn) {
        n += await rowCount(
          q,
          `INSERT INTO kb.typo_domains (typo, correction) VALUES ($1, $2)
           ON CONFLICT (typo) DO UPDATE SET correction = EXCLUDED.correction`,
          [r.typo, r.correction],
        );
      }
      return n;
    },
  };
}
