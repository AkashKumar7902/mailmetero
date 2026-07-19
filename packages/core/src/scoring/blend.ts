// @mailmetero/core — scoring/blend.ts
//
// The confidence blend (PRD §4.2): domain-local verified_count support (DOMINANT, log-scaled)
// + verification-outcome quality + recency decay + size-conditioned prior floor. Produces a
// raw 0–100 score and a tentative evidence tier; hard caps are applied SEPARATELY (caps.ts).
//
// D8: every ceiling/anchor is read from the injected ScoringConfig — NO cap-literal numbers
// (84/60/55/70/95) appear in this file.

import type { EvidenceTier, ScoringConfig, VerifyVerdict } from '@mailmetero/contracts';

export interface BlendInput {
  patternPriorWeight: number;
  verifiedCount: number;
  observedCount: number;
  verifyVerdict: VerifyVerdict | null;
  recencyAgeDays: number | null;
  isNicknameVariant: boolean;
  isCjk: boolean;
  collisionRisk: boolean;
  weights: ScoringConfig['blendWeights'];
  caps: ScoringConfig['caps'];
}

export type TentativeTier = Extract<
  EvidenceTier,
  'verified' | 'learned_pattern' | 'prior_only' | 'degraded'
>;

export interface BlendOutput {
  rawScore: number;
  tentativeTier: TentativeTier;
  components: { prior: number; support: number; verification: number; recency: number };
}

/** Prior-only band floor (band `prior_only` is 50–69 in the seed; 50 is not a cap literal). */
const PRIOR_ONLY_FLOOR = 50;
/** verified_count that saturates the log-scaled support feature. */
const SUPPORT_SATURATION = 20;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const clampScore = (x: number): number => (x < 0 ? 0 : x > 100 ? 100 : x);

/** Log-scaled, saturating support feature in [0,1] from KB verified_count. */
function supportFeature(verifiedCount: number): number {
  if (verifiedCount <= 0) return 0;
  return clamp01(Math.log1p(verifiedCount) / Math.log1p(SUPPORT_SATURATION));
}

/** Verification-quality feature in [0,1]. */
function verifyFeature(verdict: VerifyVerdict | null): number {
  switch (verdict) {
    case 'valid':
      return 1;
    case 'accept_all':
      return 0.5;
    case 'unknown':
    case 'invalid':
    case null:
    default:
      return 0;
  }
}

/** Linear recency-decay feature in [0,1] over the staleness horizon. */
function recencyFeature(ageDays: number | null, staleAfterDays: number): number {
  if (ageDays === null || staleAfterDays <= 0) return 0;
  if (ageDays <= 0) return 1;
  return clamp01(1 - ageDays / staleAfterDays);
}

/**
 * Blend the features into a raw score + tentative tier. Tier is assigned qualitatively:
 *   - a confirmed positive verify → `verified` anchored at caps.VERIFIED_BAND_MIN
 *   - any domain-local verified support → `learned_pattern` in [FINDER_BILLABLE_MIN, 94]
 *   - otherwise → `prior_only` in [50, 69]
 * Nickname/CJK down-weights are applied to non-verified tiers only (a confirmed address is
 * not down-weighted for how its local part was derived).
 */
export function blendScore(input: BlendInput): BlendOutput {
  const { weights, caps } = input;

  const fPrior = clamp01(input.patternPriorWeight);
  const fSupport = supportFeature(input.verifiedCount);
  const fVerify = verifyFeature(input.verifyVerdict);
  const fRecency = recencyFeature(input.recencyAgeDays, caps.STALE_AFTER_DAYS);

  const components = {
    prior: weights.sizeConditionedPriorFloor * fPrior,
    support: weights.domainVerifiedSupport * fSupport,
    verification: weights.verificationOutcomeQuality * fVerify,
    recency: weights.recencyDecay * fRecency,
  };

  const verifiedFloor = caps.VERIFIED_BAND_MIN; // 95
  const learnedFloor = caps.FINDER_BILLABLE_MIN; // 70
  const learnedCeil = caps.VERIFIED_BAND_MIN - 1; // 94 (derived, not a cap literal)
  const priorCeil = caps.FINDER_BILLABLE_MIN - 1; // 69 (derived, not a cap literal)

  let tentativeTier: TentativeTier;
  let rawScore: number;

  if (input.verifyVerdict === 'valid') {
    tentativeTier = 'verified';
    rawScore = verifiedFloor + fRecency * (100 - verifiedFloor);
  } else if (input.verifiedCount > 0) {
    tentativeTier = 'learned_pattern';
    const span = learnedCeil - learnedFloor;
    // Support dominates; a positive-ish verify nudges within the band.
    const nudge = 0.7 + 0.3 * fVerify;
    rawScore = learnedFloor + span * clamp01(fSupport * nudge);
  } else {
    tentativeTier = 'prior_only';
    const span = priorCeil - PRIOR_ONLY_FLOOR;
    rawScore = PRIOR_ONLY_FLOOR + span * fPrior;
  }

  // Derivation down-weights (not applied to a confirmed valid address).
  if (tentativeTier !== 'verified') {
    if (input.isNicknameVariant) rawScore *= 0.92;
    if (input.isCjk) rawScore *= 0.9;
    if (input.collisionRisk) rawScore *= 0.9;
  }

  return { rawScore: clampScore(rawScore), tentativeTier, components };
}
