// @mailmetero/pipeline — Stage protocol, PipelineDeps, StageContext/StageState, and the shared
// result/evidence builders every stage uses.
//
// A Stage is a pure-ish async step over a mutable StageContext.state; it either signals `continue`
// or returns a `terminal` output (a fully-formed PipelineFinderOutput/PipelineVerifierOutput with
// its BillingInput). Cheapest-first ordering + the finder candidate-generation placement live in
// orchestrator.ts. MODULE_CONTRACTS §7.3.

import type {
  TenantId,
  RequestId,
  EmailAddress,
  LocalPart,
  Domain,
  NameInput,
  DomainInput,
  Candidate,
  DomainPatternObservation,
  VerifyOutcome,
  VerificationEvidence,
  ScoringConfig,
  Provider,
  VerifiabilityClass,
  PipelineStage,
  Status,
  SubStatus,
  EvidenceTier,
  Backend,
  BillingInput,
} from '@mailmetero/contracts';
import type { DnsResolver, MxResolution, FingerprintRule, ProviderFingerprint } from '@mailmetero/dns';
import type { VerifierBackend } from '@mailmetero/contracts';
import type { CatchAllProbe } from '@mailmetero/verifier';
import type { Budget } from './budget.ts';
import type {
  SuppressionPort,
  ClassificationPort,
  TenantCachePort,
  KbFactsPort,
  KbWritebackPort,
  KbDomainFacts,
  CandidateGeneratorPort,
  ScorerPort,
  ResultCacheKey,
} from './ports.ts';
import type {
  PipelineMode,
  InternalFinderResult,
  InternalVerifierResult,
  PipelineFinderOutput,
  PipelineVerifierOutput,
} from './types.ts';

// ── injected dependencies ─────────────────────────────────────────────────────

export interface PipelineDeps {
  resolver: DnsResolver;
  backend: VerifierBackend;
  catchAllProbe: CatchAllProbe;
  fingerprintRules: readonly FingerprintRule[];
  verifiabilityOverrides?: Readonly<Partial<Record<Provider, VerifiabilityClass>>>;
  scoringConfig: ScoringConfig;
  clock: () => number;
  suppression: SuppressionPort;
  classification: ClassificationPort;
  tenantCache: TenantCachePort;
  kbFacts: KbFactsPort;
  kbWriteback: KbWritebackPort;
  candidates: CandidateGeneratorPort;
  scorer: ScorerPort;
}

// ── per-request mutable working state ──────────────────────────────────────────

export interface StageState {
  candidates: Candidate[];
  mx: MxResolution | null;
  fingerprint: ProviderFingerprint | null;
  domainFacts: KbDomainFacts | null;
  patternSupport: DomainPatternObservation[];
  isCatchAll: boolean | null;
  verifyOutcomes: Map<EmailAddress, VerifyOutcome>;
  evidence: Partial<VerificationEvidence>;
}

export function initialStageState(): StageState {
  return {
    candidates: [],
    mx: null,
    fingerprint: null,
    domainFacts: null,
    patternSupport: [],
    isCatchAll: null,
    verifyOutcomes: new Map(),
    evidence: {},
  };
}

export interface StageContext {
  readonly mode: PipelineMode;
  readonly tenantId: TenantId;
  readonly requestId: RequestId;
  readonly deps: PipelineDeps;
  readonly budget: Budget;
  readonly cacheKey: ResultCacheKey;
  readonly name?: NameInput;
  readonly domainInput: DomainInput;
  readonly email?: EmailAddress;
  readonly localPart?: LocalPart;
  readonly state: StageState;
}

export type StageDecision =
  | { readonly kind: 'continue' }
  | { readonly kind: 'terminal'; readonly output: PipelineFinderOutput | PipelineVerifierOutput };

export interface Stage {
  readonly id: PipelineStage;
  readonly appliesTo: readonly PipelineMode[];
  run(ctx: StageContext): Promise<StageDecision>;
}

export const BOTH_MODES: readonly PipelineMode[] = ['finder', 'verifier'];

export const CONTINUE: StageDecision = { kind: 'continue' };

// ── shared builders ────────────────────────────────────────────────────────────

// hashSuppressionValue removed: suppression hashing now lives ONLY in the db-backed
// SuppressionPort impl (keyed by the deployment SUPPRESSION_SALT via computeSuppressionHash),
// so the pipeline's read hashes reconcile with the salted hashes written on objection-confirm.

export function baseEvidence(stage: PipelineStage): VerificationEvidence {
  return {
    tier: 'prior_only',
    backend: 'none',
    producedByStage: stage,
    mx: null,
    provider: null,
    verifiabilityClass: null,
    isCatchAll: null,
    rawSmtpCode: null,
    enhancedCode: null,
    capsApplied: [],
    verifiedAt: null,
    stale: false,
  };
}

/** Assemble the final VerificationEvidence from whatever the stages accumulated. */
export function finalizeEvidence(
  stage: PipelineStage,
  state: StageState,
  overrides: Partial<VerificationEvidence> = {},
): VerificationEvidence {
  return { ...baseEvidence(stage), ...state.evidence, producedByStage: stage, ...overrides };
}

export function finderBillingInput(r: InternalFinderResult): BillingInput {
  return {
    endpoint: 'finder',
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    backend: r.backend,
    evidence: r.evidence,
    hasEmail: r.email !== null,
  };
}

export function verifierBillingInput(r: InternalVerifierResult): BillingInput {
  return {
    endpoint: 'verifier',
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    backend: r.backend,
    evidence: r.evidence,
    hasEmail: true,
  };
}

/** The canonical finder pipeline output for a fully-derived result. */
export function finderOutput(r: InternalFinderResult): PipelineFinderOutput {
  return { kind: 'ok', result: r, billingInput: finderBillingInput(r), deferrable: false };
}

export function finderOk(r: InternalFinderResult): StageDecision {
  return { kind: 'terminal', output: finderOutput(r) };
}

export function verifierOk(r: InternalVerifierResult): StageDecision {
  return { kind: 'terminal', output: { kind: 'ok', result: r, billingInput: verifierBillingInput(r) } };
}

/** A finder result carrying a terminal derivation-free verdict (classification/DNS/suppression). */
export function finderTerminal(
  ctx: StageContext,
  stage: PipelineStage,
  fields: {
    email: EmailAddress | null;
    status: Status;
    subStatus: SubStatus | null;
    score: number;
    reasonCodes: InternalFinderResult['reasonCodes'];
    evidence: EvidenceTier;
    backend?: Backend;
    provider?: Provider | null;
  },
): InternalFinderResult {
  const name = ctx.name;
  return {
    email: fields.email,
    score: fields.score,
    status: fields.status,
    subStatus: fields.subStatus,
    domain: ctx.domainInput.domain,
    firstName: name?.firstName ?? null,
    lastName: name?.lastName ?? null,
    reasonCodes: fields.reasonCodes,
    provider: fields.provider ?? null,
    backend: fields.backend ?? 'none',
    evidence: fields.evidence,
    collisionRisk: false,
    chosen: null,
    candidates: ctx.state.candidates,
    verification: finalizeEvidence(stage, ctx.state, {
      tier: fields.evidence,
      backend: fields.backend ?? 'none',
      provider: fields.provider ?? ctx.state.evidence.provider ?? null,
    }),
  };
}

export function verifierTerminal(
  ctx: StageContext,
  stage: PipelineStage,
  fields: {
    status: Status;
    subStatus: SubStatus | null;
    score: number;
    reasonCodes: InternalVerifierResult['reasonCodes'];
    evidence: EvidenceTier;
    backend?: Backend;
    provider?: Provider | null;
    acceptAll?: boolean;
    disposable?: boolean;
    webmail?: boolean;
    mxRecords?: boolean;
    smtpCheck?: boolean;
    rawSmtpCode?: string | null;
  },
): InternalVerifierResult {
  const email = ctx.email as EmailAddress;
  return {
    email,
    status: fields.status,
    score: fields.score,
    subStatus: fields.subStatus,
    acceptAll: fields.acceptAll ?? false,
    disposable: fields.disposable ?? false,
    webmail: fields.webmail ?? false,
    mxRecords: fields.mxRecords ?? ctx.state.mx !== null,
    smtpCheck: fields.smtpCheck ?? false,
    reasonCodes: fields.reasonCodes,
    provider: fields.provider ?? ctx.state.evidence.provider ?? null,
    backend: fields.backend ?? 'none',
    evidence: fields.evidence,
    rawSmtpCode: fields.rawSmtpCode ?? ctx.state.evidence.rawSmtpCode ?? null,
    verification: finalizeEvidence(stage, ctx.state, {
      tier: fields.evidence,
      backend: fields.backend ?? 'none',
    }),
  };
}

/**
 * The canonical "not found" shapes. Suppression terminals (stage 1) AND the stage-8 address filter
 * reuse these. They are built ENTIRELY from caller inputs (domain / echoed name / echoed email) and
 * carry NO accumulated derivation state — so a suppressed subject caught at any stage is byte-for-byte
 * identical to a genuine no-result: status 'unknown', degraded/unbilled, ≥1 non-revealing reason code,
 * no leaked provider/mx/verifiedAt. This is the D5/§7 observational-equivalence guarantee.
 */
export function notFoundFinderResult(ctx: StageContext): InternalFinderResult {
  return {
    email: null,
    score: 0,
    status: 'unknown',
    subStatus: 'backend_unavailable',
    domain: ctx.domainInput.domain,
    firstName: ctx.name?.firstName ?? null,
    lastName: ctx.name?.lastName ?? null,
    reasonCodes: ['backend_degraded'],
    provider: null,
    backend: 'none',
    evidence: 'degraded',
    collisionRisk: false,
    chosen: null,
    candidates: [],
    verification: { ...baseEvidence('score_and_writeback'), tier: 'degraded' },
  };
}

export function notFoundVerifierResult(ctx: StageContext): InternalVerifierResult {
  return {
    email: ctx.email as EmailAddress,
    status: 'unknown',
    score: 0,
    subStatus: 'backend_unavailable',
    acceptAll: false,
    disposable: false,
    webmail: false,
    mxRecords: false,
    smtpCheck: false,
    reasonCodes: ['backend_degraded'],
    provider: null,
    backend: 'none',
    evidence: 'degraded',
    rawSmtpCode: null,
    verification: { ...baseEvidence('score_and_writeback'), tier: 'degraded' },
  };
}
