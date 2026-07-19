// @mailmetero/db — SuppressionRepo (global, hash-only, D5/D6).
//
// `isSuppressed` returns a bare boolean — a suppressed subject is observationally identical
// to not-found (no status/reason leak). `writeSuppression` is a CLOSED entry point: only
// `ObjectionsRepo.confirm` calls it, inside the same confirmation transaction, so a
// suppression row is only ever written for a verified objection.

import type { SuppressionHash } from '@mailmetero/contracts';
import type { PoolClient } from 'pg';
import type { Queryable } from '../client.ts';
import { maybeOne } from '../client.ts';
import type { SuppressionScope } from '../types.ts';

export interface SuppressionRepo {
  /** Boolean-only membership test over the given hashes (address and/or domain). */
  isSuppressed(q: Queryable, hashes: SuppressionHash[]): Promise<boolean>;
  /** CLOSED: only ObjectionsRepo.confirm calls this, within the confirm transaction. */
  writeSuppression(
    q: Queryable,
    entries: Array<{ hash: SuppressionHash; scope: SuppressionScope }>,
    tx: PoolClient,
  ): Promise<void>;
}

export function createSuppressionRepo(): SuppressionRepo {
  return {
    async isSuppressed(q, hashes) {
      if (hashes.length === 0) return false;
      const row = await maybeOne<{ ok: boolean }>(
        q,
        `SELECT true AS ok FROM suppression_global WHERE hash = ANY($1::text[]) LIMIT 1`,
        [hashes],
      );
      return row !== null;
    },

    async writeSuppression(_q, entries, tx) {
      for (const e of entries) {
        await tx.query(
          `INSERT INTO suppression_global (hash, scope) VALUES ($1, $2)
           ON CONFLICT (hash) DO NOTHING`,
          [e.hash, e.scope],
        );
      }
    },
  };
}
