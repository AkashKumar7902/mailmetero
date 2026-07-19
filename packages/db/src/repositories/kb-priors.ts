// @mailmetero/db — PatternPriorsRepo (size-conditioned format-share priors, D8).

import type { SizeBracket, PatternToken } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { rows } from '../client.ts';
import type { KbPatternPriorRow } from '../types.ts';

interface PriorRaw {
  size_bracket: string;
  pattern_token: string;
  share: string | number;
  rank: number;
}

function mapPrior(r: PriorRaw): KbPatternPriorRow {
  return {
    sizeBracket: r.size_bracket as SizeBracket,
    patternToken: r.pattern_token as PatternToken,
    share: typeof r.share === 'number' ? r.share : Number(r.share),
    rank: r.rank,
  };
}

export interface PatternPriorsRepo {
  loadAll(q: Queryable): Promise<KbPatternPriorRow[]>;
  forBracket(q: Queryable, bracket: SizeBracket): Promise<KbPatternPriorRow[]>;
  upsert(q: Queryable, rows: KbPatternPriorRow[]): Promise<void>;
}

export function createPatternPriorsRepo(): PatternPriorsRepo {
  return {
    async loadAll(q) {
      const rs = await rows<PriorRaw>(
        q,
        `SELECT size_bracket, pattern_token, share, rank FROM kb.pattern_priors ORDER BY size_bracket, rank`,
      );
      return rs.map(mapPrior);
    },

    async forBracket(q, bracket) {
      const rs = await rows<PriorRaw>(
        q,
        `SELECT size_bracket, pattern_token, share, rank FROM kb.pattern_priors WHERE size_bracket = $1 ORDER BY rank`,
        [bracket],
      );
      return rs.map(mapPrior);
    },

    async upsert(q, rowsIn) {
      for (const r of rowsIn) {
        await q.query(
          `INSERT INTO kb.pattern_priors (size_bracket, pattern_token, share, rank)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (size_bracket, pattern_token) DO UPDATE SET
             share = EXCLUDED.share, rank = EXCLUDED.rank`,
          [r.sizeBracket, r.patternToken, r.share, r.rank],
        );
      }
    },
  };
}
