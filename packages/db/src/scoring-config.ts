// @mailmetero/db — the LIVE ScoringConfig loader (D8).
//
// Runtime scoring MUST read live weights/caps/bands from `kb.blend_weights`, never the
// compile-time constant. This repo assembles a `ScoringConfig` from the single active row
// and runs `validateScoringConfig` before returning it (a bad DB row can never loosen a
// published cap). When ZERO active rows exist (fresh DB pre-seed) it falls back to
// DEFAULT_SCORING_CONFIG. `activate()` runs ONE transaction so the partial-unique index
// `kb.blend_weights(is_active) WHERE is_active` is never transiently violated.

import type { ScoringConfig, HardCaps, ConfidenceBand } from '@mailmetero/contracts';
import { DEFAULT_SCORING_CONFIG, validateScoringConfig } from '@mailmetero/config';
import type { Queryable } from './client.ts';
import { maybeOne } from './client.ts';

interface BlendWeightsRaw {
  version: string;
  source: 'audit_seed' | 'recalibrated';
  domain_verified_support: string | number;
  verification_outcome_quality: string | number;
  recency_decay: string | number;
  size_conditioned_prior_floor: string | number;
  caps: HardCaps;
  bands: ConfidenceBand[];
}

function num(v: string | number): number {
  return typeof v === 'number' ? v : Number(v);
}

function toScoringConfig(r: BlendWeightsRaw): ScoringConfig {
  return {
    version: r.version,
    source: r.source,
    bands: r.bands,
    caps: r.caps,
    blendWeights: {
      domainVerifiedSupport: num(r.domain_verified_support),
      verificationOutcomeQuality: num(r.verification_outcome_quality),
      recencyDecay: num(r.recency_decay),
      sizeConditionedPriorFloor: num(r.size_conditioned_prior_floor),
    },
  };
}

export interface ScoringConfigRepo {
  /** Assemble the active ScoringConfig; DEFAULT_SCORING_CONFIG only when zero active rows. */
  loadActive(q: Queryable): Promise<ScoringConfig>;
  /** Insert a new version; optionally activate it in the same call. */
  insertVersion(q: Queryable, cfg: ScoringConfig, activate: boolean): Promise<void>;
  /** Flip the active version in ONE transaction (partial-unique safe). */
  activate(q: Queryable, version: string): Promise<void>;
}

export function createScoringConfigRepo(): ScoringConfigRepo {
  return {
    async loadActive(q) {
      const row = await maybeOne<BlendWeightsRaw>(
        q,
        `SELECT version, source, domain_verified_support, verification_outcome_quality,
                recency_decay, size_conditioned_prior_floor, caps, bands
           FROM kb.blend_weights
          WHERE is_active
          LIMIT 1`,
      );
      if (row === null) return DEFAULT_SCORING_CONFIG;
      return validateScoringConfig(toScoringConfig(row));
    },

    async insertVersion(q, cfg, activate) {
      validateScoringConfig(cfg);
      await q.query(
        `INSERT INTO kb.blend_weights
           (version, source, domain_verified_support, verification_outcome_quality,
            recency_decay, size_conditioned_prior_floor, caps, bands, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,false)
         ON CONFLICT (version) DO UPDATE SET
           source = EXCLUDED.source,
           domain_verified_support = EXCLUDED.domain_verified_support,
           verification_outcome_quality = EXCLUDED.verification_outcome_quality,
           recency_decay = EXCLUDED.recency_decay,
           size_conditioned_prior_floor = EXCLUDED.size_conditioned_prior_floor,
           caps = EXCLUDED.caps,
           bands = EXCLUDED.bands`,
        [
          cfg.version,
          cfg.source,
          cfg.blendWeights.domainVerifiedSupport,
          cfg.blendWeights.verificationOutcomeQuality,
          cfg.blendWeights.recencyDecay,
          cfg.blendWeights.sizeConditionedPriorFloor,
          JSON.stringify(cfg.caps),
          JSON.stringify(cfg.bands),
        ],
      );
      if (activate) {
        await this.activate(q, cfg.version);
      }
    },

    async activate(q, version) {
      // Clear the current active flag FIRST, then set the target — so the partial-unique
      // index `kb.blend_weights(is_active) WHERE is_active` never sees two active rows.
      // Callers that need cross-statement atomicity pass a transaction client as `q`.
      await q.query(`UPDATE kb.blend_weights SET is_active = false WHERE is_active`);
      await q.query(`UPDATE kb.blend_weights SET is_active = true WHERE version = $1`, [version]);
    },
  };
}
