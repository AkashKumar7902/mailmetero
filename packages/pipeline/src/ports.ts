// @mailmetero/pipeline — structural ports the orchestrator consumes.
//
// The concrete implementations are injected from db (suppression/classification/kb/tenant-cache/
// writeback) and from the core adapter (candidate generator + scorer). These interfaces are
// STRUCTURAL: an impl need only match the shape, never import this module at runtime.
// (MODULE_CONTRACTS §7.1.)

import type {
  NameInput,
  DomainInput,
  Candidate,
  DomainPatternObservation,
  PatternToken,
  SizeBracket,
  VerifyOutcome,
  VerificationEvidence,
  ScoringConfig,
  ReasonCode,
  EvidenceTier,
  HardCapId,
  SubStatus,
  VerifyVerdict,
  Domain,
  LocalPart,
  MxEnum,
  Provider,
  VerifiabilityClass,
  IsoTimestamp,
  TenantId,
} from '@mailmetero/contracts';
import type { InternalFinderResult, InternalVerifierResult } from './types.ts';

// ── core adapter ports ───────────────────────────────────────────────────────

/** Wraps core.generateCandidates with priors/config already bound (see adapter.ts). */
export interface CandidateGeneratorPort {
  generate(
    name: NameInput,
    domain: DomainInput,
    domainSupport: DomainPatternObservation[] | null,
  ): Candidate[];
}

/** Input to the scorer — the pipeline decomposes it into core.ScoreDerivationInput. */
export interface ScoreInput {
  candidate: Candidate;
  evidence: VerificationEvidence;
  domainSupport: DomainPatternObservation | null;
  sizeBracket: SizeBracket | null;
  verify: VerifyOutcome | null;
  config: ScoringConfig;
}

/** Output of the scorer — status is a VerifyVerdict (derivation path only). */
export interface ScoreOutput {
  score: number;
  status: VerifyVerdict;
  subStatus: SubStatus | null;
  reasonCodes: ReasonCode[];
  evidenceTier: EvidenceTier;
  capsApplied: HardCapId[];
}

/** Wraps core.scoreDerivation; narrows status to the four derivation verdicts. */
export interface ScorerPort {
  score(input: ScoreInput): ScoreOutput;
}

// ── db-backed ports ──────────────────────────────────────────────────────────

/** Suppression membership check. Boolean only — never reveals which value matched (D5).
 *  Takes RAW canonical values (canonical email / domain strings). The concrete db-backed impl
 *  applies the deployment salt (computeSuppressionHash) so these reads reconcile with the salted
 *  hashes the objection-confirm path writes. */
export interface SuppressionPort {
  isSuppressed(values: readonly string[]): Promise<boolean>;
}

/** Freemail / disposable / role / typo classification over the live KB tables. */
export interface ClassificationPort {
  isFreemail(domain: Domain): Promise<boolean>;
  isDisposable(domain: Domain): Promise<boolean>;
  isRoleLocal(local: LocalPart): Promise<boolean>;
  correctTypoDomain(domain: Domain): Promise<Domain | null>;
}

/** Shared, domain-level KB facts (NO person data — D7). */
export interface KbDomainFacts {
  readonly mx: MxEnum | null;
  readonly provider: Provider | null;
  readonly verifiabilityClass: VerifiabilityClass | null;
  readonly isCatchAll: boolean | null;
  readonly lastProbedAt: IsoTimestamp | null;
  readonly ttlFresh: boolean;
}

export interface KbFactsPort {
  getDomainFacts(domain: Domain): Promise<KbDomainFacts | null>;
  getDomainPatterns(domain: Domain): Promise<DomainPatternObservation[]>;
}

/** Per-tenant TTL-fresh result cache key. */
export interface ResultCacheKey {
  readonly kind: 'find' | 'verify';
  readonly hash: string;
}

/** Read-only per-tenant verdict reuse (api/worker own the write side via ResultsRepo). */
export interface TenantCachePort {
  lookup(
    tenantId: TenantId,
    key: ResultCacheKey,
  ): Promise<{ result: InternalFinderResult | InternalVerifierResult; cachedAt: IsoTimestamp } | null>;
}

/** Stage-8 shared-KB writeback. acceptAllDomain ⇒ db MUST NOT bump verified_count (D7). */
export interface KbWritebackPort {
  upsertDomainFacts(facts: {
    domain: Domain;
    mx: MxEnum;
    provider: Provider;
    verifiabilityClass: VerifiabilityClass;
    isCatchAll: boolean | null;
    spfPresent: boolean;
    dmarcPresent: boolean;
    probedAt: IsoTimestamp;
  }): Promise<void>;
  recordPatternObservation(obs: {
    domain: Domain;
    pattern: PatternToken;
    verified: boolean;
    acceptAllDomain: boolean;
  }): Promise<void>;
}
