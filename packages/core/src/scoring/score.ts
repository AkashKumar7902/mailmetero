// @mailmetero/core — scoring/score.ts
//
// The single `scoreDerivation` entry point (the CI cap-ceiling target). Composes blend →
// caps and resolves the derivation-path verdict (VerifyVerdict ONLY — webmail/disposable/
// role and DNS terminals are set by pipeline stages, per the Status-terminal split).
//
// INVARIANTS (CI §9.5) — all ceilings read from the injected ScoringConfig, no literals:
//   - m365 || isCatchAll        ⇒ status 'accept_all', score ≤ caps.M365_ACCEPT_ALL_MAX, never 'valid'
//   - prior-only on those       ⇒ score ≤ caps.M365_PRIOR_ONLY_MAX
//   - IMPLICIT_MX_FALLBACK       ⇒ score ≤ caps.IMPLICIT_MX_MAX
//   - NULL_MX                    ⇒ status 'invalid', sub 'null_mx'
//   - verify.valid, verifiable, non-catch-all ⇒ 'valid', 'verified', score ≥ caps.VERIFIED_BAND_MIN
//   - backend 'none'            ⇒ never 'valid'
//   - reasonCodes               ⇒ always ≥ 1

import type {
  Backend,
  BandId,
  Candidate,
  EvidenceTier,
  HardCapId,
  MxEnum,
  Provider,
  ReasonCode,
  ScoringConfig,
  SizeBracket,
  SubStatus,
  VerifiabilityClass,
  VerifyOutcome,
  VerifyVerdict,
} from '@mailmetero/contracts';
import { blendScore } from './blend.ts';
import { applyCaps, resolveBand } from './caps.ts';

export interface ScoreDerivationInput {
  candidate: Candidate;
  priorWeight: number;
  verifiedCount: number;
  observedCount: number;
  sizeBracket: SizeBracket | null;
  provider: Provider | null;
  mx: MxEnum;
  verifiabilityClass: VerifiabilityClass | null;
  isCatchAll: boolean | null;
  verify: VerifyOutcome | null;
  recencyAgeDays: number | null;
  backend: Backend;
  isNicknameVariant: boolean;
  isCjk: boolean;
  config: ScoringConfig;
}

export interface ScoredResult {
  score: number;
  status: VerifyVerdict;
  subStatus: SubStatus;
  band: BandId;
  evidence: EvidenceTier;
  reasonCodes: ReasonCode[];
  capsApplied: HardCapId[];
}

const VERIFIABLE_CLASSES: ReadonlySet<VerifiabilityClass> = new Set<VerifiabilityClass>([
  'VERIFIABLE_WITH_CATCHALL_GUARD',
  'VERIFIABLE_GREYLIST_RETRY',
  'GATEWAY_CONFIG_DEPENDENT',
]);

function priorReason(bracket: SizeBracket | null): ReasonCode {
  switch (bracket) {
    case 'micro':
      return 'pattern_prior_micro_company';
    case 'small':
      return 'pattern_prior_small_company';
    case 'medium':
      return 'pattern_prior_midsize_company';
    case 'large':
    case 'enterprise':
      return 'pattern_prior_enterprise';
    default:
      return 'pattern_prior_unknown_size';
  }
}

function dedupe(codes: ReadonlyArray<ReasonCode>): ReasonCode[] {
  const out: ReasonCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}

/** Derivation-provenance reason codes shared by the non-terminal paths. */
function derivationReasons(input: ScoreDerivationInput): ReasonCode[] {
  const codes: ReasonCode[] = [];
  if (input.verifiedCount > 0) codes.push('pattern_learned_domain');
  else codes.push(priorReason(input.sizeBracket));
  if (input.isNicknameVariant) codes.push('nickname_variant');
  if (input.isCjk) codes.push('cjk_ambiguous_downweight');
  if (input.candidate.collisionRisk) codes.push('collision_risk_high');
  if (input.mx === 'EXPLICIT_MX') codes.push('dns_explicit_mx');
  else if (input.mx === 'IMPLICIT_MX_FALLBACK') codes.push('dns_implicit_mx_only');
  return codes;
}

export function scoreDerivation(input: ScoreDerivationInput): ScoredResult {
  const caps = input.config.caps;
  const bands = input.config.bands;

  // ── DNS terminals (definitive; short-circuit the blend) ───────────────────
  if (input.mx === 'NULL_MX') {
    return {
      score: 0,
      status: 'invalid',
      subStatus: 'null_mx',
      band: resolveBand(0, bands),
      evidence: 'dns',
      reasonCodes: ['dns_null_mx'],
      capsApplied: [],
    };
  }
  if (input.mx === 'NO_MAIL_HOST') {
    return {
      score: 0,
      status: 'invalid',
      subStatus: 'no_mail_host',
      band: resolveBand(0, bands),
      evidence: 'dns',
      reasonCodes: ['dns_no_mail_host'],
      capsApplied: [],
    };
  }

  const m365 = input.provider === 'microsoft365' || input.verifiabilityClass === 'UNVERIFIABLE';
  const catchAll = input.isCatchAll === true;
  const degraded = input.backend === 'none';
  const verifiable =
    input.verifiabilityClass !== null && VERIFIABLE_CLASSES.has(input.verifiabilityClass);

  const blend = blendScore({
    patternPriorWeight: input.priorWeight,
    verifiedCount: input.verifiedCount,
    observedCount: input.observedCount,
    verifyVerdict: input.verify?.verdict ?? null,
    recencyAgeDays: input.recencyAgeDays,
    isNicknameVariant: input.isNicknameVariant,
    isCjk: input.isCjk,
    collisionRisk: input.candidate.collisionRisk,
    weights: input.config.blendWeights,
    caps,
  });

  const capRes = applyCaps({
    rawScore: blend.rawScore,
    tentativeTier: blend.tentativeTier,
    provider: input.provider,
    mx: input.mx,
    verifiabilityClass: input.verifiabilityClass,
    isCatchAll: input.isCatchAll,
    hasDomainSupport: input.observedCount > 0 || input.verifiedCount > 0,
    backend: input.backend,
    caps,
    bands,
  });

  // ── 1. Confirmed VALID: only on a verifiable, non-catch-all, non-M365, live, EXPLICIT-MX
  //       backend. An implicit-MX (A-record fallback) domain must not take the 95 fast path —
  //       it falls through to the capped path below so applyCaps' IMPLICIT_MX_MAX ceiling
  //       applies (keeping the result non-billable for finder). ──
  if (
    input.verify?.verdict === 'valid' &&
    verifiable &&
    !catchAll &&
    !m365 &&
    !degraded &&
    input.mx === 'EXPLICIT_MX'
  ) {
    const score = Math.max(caps.VERIFIED_BAND_MIN, Math.round(blend.rawScore));
    return {
      score,
      status: 'valid',
      subStatus: 'ok',
      band: resolveBand(score, bands),
      evidence: 'verified',
      reasonCodes: dedupe(['verifier_confirmed_valid', ...derivationReasons(input)]),
      capsApplied: [],
    };
  }

  // ── 2. M365 / catch-all ⇒ accept_all (capped; never valid, never invalid-from-550) ──
  if (m365 || catchAll) {
    const subStatus: SubStatus = m365 ? 'provider_unverifiable' : 'catch_all_confirmed';
    const reasonCodes = dedupe([
      ...capRes.capReasonCodes,
      ...(catchAll ? (['catch_all_confirmed'] as ReasonCode[]) : []),
      ...derivationReasons(input),
    ]);
    return {
      score: capRes.score,
      status: 'accept_all',
      subStatus,
      band: capRes.band,
      evidence: capRes.evidence,
      reasonCodes,
      capsApplied: capRes.capsApplied,
    };
  }

  // ── 3. Confirmed INVALID (honest provider) ────────────────────────────────
  if (input.verify?.verdict === 'invalid') {
    const subStatus: SubStatus = input.verify.subStatus;
    const codes: ReasonCode[] = ['verifier_confirmed_invalid'];
    if (input.verify.enhancedCode === '5.1.1') codes.push('smtp_5_1_1');
    if (subStatus === 'disabled') codes.push('mailbox_disabled');
    return {
      score: 0,
      status: 'invalid',
      subStatus,
      band: resolveBand(0, bands),
      evidence: 'verified',
      reasonCodes: dedupe(codes),
      capsApplied: capRes.capsApplied,
    };
  }

  // ── 4. Gateway policy block (5.7.1) ⇒ unknown ─────────────────────────────
  if (input.verify?.verdict === 'unknown' && input.verify.subStatus === 'gateway_blocked') {
    return {
      score: capRes.score,
      status: 'unknown',
      subStatus: 'gateway_blocked',
      band: capRes.band,
      evidence: capRes.evidence,
      reasonCodes: dedupe(['gateway_policy_block', ...derivationReasons(input)]),
      capsApplied: capRes.capsApplied,
    };
  }

  // ── 5. Everything else ⇒ unknown (pattern-only derivation / degraded / timeout) ──
  let subStatus: SubStatus;
  if (input.mx === 'IMPLICIT_MX_FALLBACK') subStatus = 'implicit_mx_only';
  else if (input.verify?.verdict === 'unknown' && input.verify.subStatus === 'timeout') {
    subStatus = 'timeout';
  } else subStatus = 'backend_unavailable';

  const reasonCodes = dedupe([
    ...derivationReasons(input),
    ...capRes.capReasonCodes,
    ...(degraded ? (['backend_degraded'] as ReasonCode[]) : []),
  ]);

  return {
    score: capRes.score,
    status: 'unknown',
    subStatus,
    band: capRes.band,
    evidence: capRes.evidence,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ['pattern_prior_unknown_size'],
    capsApplied: capRes.capsApplied,
  };
}
