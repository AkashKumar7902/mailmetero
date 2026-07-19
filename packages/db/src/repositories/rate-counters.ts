// @mailmetero/db — RateCountersRepo (attempt-level limiter, PgBouncer-safe).
//
// A single atomic INSERT ... ON CONFLICT DO UPDATE per (api_key_id, window_start) — no
// session state, no advisory locks — so it runs correctly on the pooled web DSN.

import type { IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';

export interface RateCountersRepo {
  incrementAndGet(
    q: Queryable,
    input: { apiKeyId: string; windowStart: IsoTimestamp; windowSeconds: number; limitMax: number },
  ): Promise<{ count: number; limitMax: number; resetAt: IsoTimestamp }>;
  purgeOld(q: Queryable, before: IsoTimestamp): Promise<number>;
}

export function createRateCountersRepo(): RateCountersRepo {
  return {
    async incrementAndGet(q, input) {
      const row = await maybeOne<{ count: number; limit_max: number; reset_at: string }>(
        q,
        `INSERT INTO rate_counters (api_key_id, window_start, window_seconds, count, limit_max)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (api_key_id, window_start)
           DO UPDATE SET count = rate_counters.count + 1
         RETURNING count, limit_max, (window_start + (window_seconds || ' seconds')::interval) AS reset_at`,
        [input.apiKeyId, input.windowStart, input.windowSeconds, input.limitMax],
      );
      // INSERT ... RETURNING always yields a row.
      const r = row as { count: number; limit_max: number; reset_at: string };
      return {
        count: r.count,
        limitMax: r.limit_max,
        resetAt: new Date(r.reset_at).toISOString() as IsoTimestamp,
      };
    },

    async purgeOld(q, before) {
      return rowCount(q, `DELETE FROM rate_counters WHERE window_start < $1`, [before]);
    },
  };
}
