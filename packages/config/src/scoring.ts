// @mailmetero/config — ScoringConfig bootstrap wiring + validator (D8, CONTRACTS_CORE §5).
// This package does NOT read the DB (that is @mailmetero/db's live loader). It owns:
//   (1) re-exporting the compile-time bootstrap seed DEFAULT_SCORING_CONFIG, and
//   (2) `validateScoringConfig` — the shared invariant check that BOTH the seed
//       migration and the runtime DB loader run before trusting a ScoringConfig,
//       so published hard caps / band monotonicity can never silently drift.

import {
  DEFAULT_SCORING_CONFIG,
  type ScoringConfig,
  type ConfidenceBand,
} from '@mailmetero/contracts';

export { DEFAULT_SCORING_CONFIG };
export type { ScoringConfig };

export class ScoringConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid ScoringConfig:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ScoringConfigError';
    this.problems = problems;
  }
}

/**
 * Validate a ScoringConfig (DB-loaded or seed). Throws ScoringConfigError on any breach.
 * Enforces the PRD §4.2 published policy so a bad DB row cannot loosen a cap:
 *  - bands cover 1..100 contiguously, ascending, non-overlapping
 *  - the four hard caps keep their published ordering relationship
 *  - FINDER_BILLABLE_MIN (70) ≤ VERIFIED_BAND_MIN (95); caps ≤ 100; VERIFY_TOP_N ≥ 1
 */
export function validateScoringConfig(cfg: ScoringConfig): ScoringConfig {
  const p: string[] = [];
  const bands = [...cfg.bands].sort((a: ConfidenceBand, b: ConfidenceBand) => a.min - b.min);
  let expectMin = 1;
  for (const b of bands) {
    if (b.min !== expectMin) p.push(`band ${b.id} should start at ${expectMin}, got ${b.min}`);
    if (b.max < b.min) p.push(`band ${b.id} max<min`);
    expectMin = b.max + 1;
  }
  if (expectMin !== 101) p.push(`bands must cover 1..100 contiguously (ended at ${expectMin - 1})`);

  const c = cfg.caps;
  if (c.M365_ACCEPT_ALL_MAX > 100 || c.CATCH_ALL_ACCEPT_ALL_MAX > 100) p.push('accept_all caps exceed 100');
  if (c.M365_PRIOR_ONLY_MAX > c.M365_ACCEPT_ALL_MAX) p.push('M365 prior-only cap must be ≤ accept_all cap');
  if (c.CATCH_ALL_PRIOR_ONLY_MAX > c.CATCH_ALL_ACCEPT_ALL_MAX) p.push('catch-all prior-only cap must be ≤ accept_all cap');
  if (c.FINDER_BILLABLE_MIN > c.VERIFIED_BAND_MIN) p.push('FINDER_BILLABLE_MIN must be ≤ VERIFIED_BAND_MIN');
  if (c.IMPLICIT_MX_MAX > 100) p.push('IMPLICIT_MX_MAX exceeds 100');
  if (c.VERIFY_TOP_N < 1) p.push('VERIFY_TOP_N must be ≥ 1');
  if (c.MAX_CANDIDATES < c.VERIFY_TOP_N) p.push('MAX_CANDIDATES must be ≥ VERIFY_TOP_N');
  if (c.FINDER_BUDGET_MS <= 0 || c.SYNC_VERIFY_BUDGET_MS <= 0) p.push('budgets must be positive');

  if (p.length > 0) throw new ScoringConfigError(p);
  return cfg;
}
