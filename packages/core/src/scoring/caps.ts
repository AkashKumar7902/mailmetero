// @mailmetero/core — scoring/caps.ts
//
// Provider / catch-all / implicit-MX / collision hard caps + confidence-band resolution.
// Every ceiling is read from the injected ScoringConfig.caps (D8) — this file contains NO
// cap-literal numbers. Caps are ceilings: they only ever LOWER a score.

import type {
  BandId,
  Backend,
  EvidenceTier,
  HardCapId,
  MxEnum,
  Provider,
  ReasonCode,
  ScoringConfig,
  VerifiabilityClass,
} from '@mailmetero/contracts';
import type { TentativeTier } from './blend.ts';

export interface CapInput {
  rawScore: number;
  tentativeTier: TentativeTier;
  provider: Provider | null;
  mx: MxEnum;
  verifiabilityClass: VerifiabilityClass | null;
  isCatchAll: boolean | null;
  hasDomainSupport: boolean;
  backend: Backend;
  caps: ScoringConfig['caps'];
  bands: ScoringConfig['bands'];
}

export interface CapResult {
  score: number;
  band: BandId;
  evidence: EvidenceTier;
  capsApplied: HardCapId[];
  capReasonCodes: ReasonCode[];
}

/** Resolve a numeric score to its band via the injected band table (inclusive bounds). */
export function resolveBand(score: number, bands: ScoringConfig['bands']): BandId {
  for (const band of bands) {
    if (score >= band.min && score <= band.max) return band.id;
  }
  // Below the lowest floor (e.g. a definitive 0) — treat as the risky/capped floor band.
  return 'risky_capped';
}

/** True when the domain's provider is M365-class (never trustworthy per-address). */
function isM365Class(provider: Provider | null, vClass: VerifiabilityClass | null): boolean {
  return provider === 'microsoft365' || vClass === 'UNVERIFIABLE';
}

/**
 * Apply hard caps to a blended raw score. Ceilings, in precedence:
 *   - M365 / confirmed catch-all: accept_all ceiling, or the tighter prior-only ceiling
 *     when there is no domain-local support (prior-only guess on an unverifiable domain).
 *   - IMPLICIT_MX_FALLBACK: implicit-MX ceiling (a downgrade, not a reject).
 *   - degraded backend (kind 'none'): evidence tier flips to `degraded` (never billable).
 */
export function applyCaps(input: CapInput): CapResult {
  const { caps } = input;
  const capsApplied: HardCapId[] = [];
  const capReasonCodes: ReasonCode[] = [];
  let score = input.rawScore;

  const m365 = isM365Class(input.provider, input.verifiabilityClass);
  const catchAll = input.isCatchAll === true;
  const priorOnly = !input.hasDomainSupport && input.tentativeTier !== 'verified';

  // 1. M365 / catch-all ceilings.
  if (m365 || catchAll) {
    if (priorOnly) {
      const ceiling = m365 ? caps.M365_PRIOR_ONLY_MAX : caps.CATCH_ALL_PRIOR_ONLY_MAX;
      score = Math.min(score, ceiling);
      capsApplied.push(m365 ? 'm365_prior_only' : 'catch_all_prior_only');
      capReasonCodes.push('prior_only_catch_all_cap');
    } else {
      const ceiling = m365 ? caps.M365_ACCEPT_ALL_MAX : caps.CATCH_ALL_ACCEPT_ALL_MAX;
      score = Math.min(score, ceiling);
      capsApplied.push(m365 ? 'm365_accept_all' : 'catch_all_accept_all');
    }
    capReasonCodes.push(m365 ? 'provider_m365_cap' : 'catch_all_cap');
  }

  // 2. Implicit-MX-only downgrade.
  if (input.mx === 'IMPLICIT_MX_FALLBACK') {
    score = Math.min(score, caps.IMPLICIT_MX_MAX);
    capsApplied.push('implicit_mx');
    capReasonCodes.push('implicit_mx_cap');
  }

  // 3. Degraded backend.
  const degraded = input.backend === 'none';
  if (degraded) {
    capsApplied.push('degraded_backend');
    capReasonCodes.push('backend_degraded');
  }

  const finalScore = Math.round(Math.max(0, Math.min(100, score)));
  const band = resolveBand(finalScore, input.bands);

  let evidence: EvidenceTier;
  if (degraded) {
    evidence = 'degraded';
  } else if (capsApplied.length > 0) {
    evidence = 'capped';
  } else if (input.tentativeTier === 'verified') {
    evidence = 'verified';
  } else if (input.tentativeTier === 'learned_pattern') {
    evidence = 'learned_pattern';
  } else {
    evidence = 'prior_only';
  }

  return { score: finalScore, band, evidence, capsApplied, capReasonCodes };
}
