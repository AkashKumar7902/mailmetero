// @mailmetero/contracts — §5 Confidence-band model, hard caps & scoring config.
//
// D8 is binding: all format-share priors and blend weights are tunable Postgres tables
// seeded from the BounceZero audit, never code constants. Published hard caps
// (84 / 60 / 55 / 70 …) are policy constants that change only via a documented methodology
// revision. Both flow through ONE typed shape, `ScoringConfig`, assembled at boot. This file
// defines the shape and a bootstrap seed (`DEFAULT_SCORING_CONFIG`); runtime MUST read live
// values from Postgres, not from the constant.

export type BandId = 'verified' | 'learned_pattern' | 'prior_only' | 'risky_capped';

export interface ConfidenceBand {
  id: BandId;
  min: number;        // inclusive
  max: number;        // inclusive
  label: string;
  billable: boolean;  // finder bills only when the returned score lands ≥ FINDER_BILLABLE_MIN
}

export interface HardCaps {
  M365_ACCEPT_ALL_MAX: number;      // 84  — M365 accept_all ceiling; never the 95+ band
  CATCH_ALL_ACCEPT_ALL_MAX: number; // 84  — confirmed catch-all ceiling
  M365_PRIOR_ONLY_MAX: number;      // 55  — prior-only on M365
  CATCH_ALL_PRIOR_ONLY_MAX: number; // 55  — prior-only on catch-all
  IMPLICIT_MX_MAX: number;          // 60  — IMPLICIT_MX_FALLBACK downgrade (not reject)
  FINDER_BILLABLE_MIN: number;      // 70  — finder bills 1 credit only at/above this
  VERIFIED_BAND_MIN: number;        // 95  — floor of the "verified" band
  MAX_CANDIDATES: number;           // 25  — size of the ranked candidate list returned
  VERIFY_TOP_N: number;             // 3   — paid-verify budget per finder request
  FINDER_BUDGET_MS: number;         // 8000 — total finder budget, then degrade to backend=none
  SYNC_VERIFY_BUDGET_MS: number;    // 2000 — verifier sync fast-path budget, else 202
  STALE_AFTER_DAYS: number;         // 90  — verified_at older than this → stale
}

export interface BlendWeights {
  domainVerifiedSupport: number;      // DOMINANT, log-scaled (kb.domain_patterns.verified_count)
  verificationOutcomeQuality: number;
  recencyDecay: number;
  sizeConditionedPriorFloor: number;
}

export interface ScoringConfig {
  version: string;                    // e.g. 'audit-seed-2026-07'
  source: 'audit_seed' | 'recalibrated';
  bands: readonly ConfidenceBand[];
  caps: HardCaps;
  blendWeights: BlendWeights;
}

/**
 * BOOTSTRAP SEED + compile-time reference ONLY. Runtime reads the live ScoringConfig
 * assembled from kb.blend_weights / kb.pattern_priors / kb.calibration_seed (D8).
 * Bands & caps below are the PRD §4.2 published rules.
 */
export const DEFAULT_SCORING_CONFIG: Readonly<ScoringConfig> = Object.freeze({
  version: 'audit-seed-2026-07',
  source: 'audit_seed',
  bands: [
    { id: 'verified',        min: 95, max: 100, label: 'Verified',          billable: true  },
    { id: 'learned_pattern', min: 70, max: 94,  label: 'Learned pattern',   billable: true  },
    { id: 'prior_only',      min: 50, max: 69,  label: 'Prior-only guess',  billable: false },
    { id: 'risky_capped',    min: 1,  max: 49,  label: 'Risky / capped',    billable: false },
  ],
  caps: {
    M365_ACCEPT_ALL_MAX: 84,
    CATCH_ALL_ACCEPT_ALL_MAX: 84,
    M365_PRIOR_ONLY_MAX: 55,
    CATCH_ALL_PRIOR_ONLY_MAX: 55,
    IMPLICIT_MX_MAX: 60,
    FINDER_BILLABLE_MIN: 70,
    VERIFIED_BAND_MIN: 95,
    MAX_CANDIDATES: 25,
    VERIFY_TOP_N: 3,
    FINDER_BUDGET_MS: 8000,
    SYNC_VERIFY_BUDGET_MS: 2000,
    STALE_AFTER_DAYS: 90,
  },
  blendWeights: {
    domainVerifiedSupport: 1.0,
    verificationOutcomeQuality: 0.6,
    recencyDecay: 0.3,
    sizeConditionedPriorFloor: 0.2,
  },
} as const);
