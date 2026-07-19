// @mailmetero/contracts — §4 internal domain value types (camelCase) + MODULE_CONTRACTS §0
// additions (DomainPatternObservation, BillingInput).
//
// Internal domain types are camelCase; everything upstream of `@mailmetero/api` works in
// camelCase. `@mailmetero/pipeline` (src/wire.ts) is the ONLY place that maps internal → wire.

import type {
  EmailAddress, Domain, LocalPart, PatternToken, IsoTimestamp,
} from './primitives.js';
import type {
  Status, SubStatus, SizeBracket, EvidenceTier, Backend, PipelineStage,
  MxEnum, Provider, VerifiabilityClass,
} from './enums.js';
import type { ReasonCode } from './reason-codes.js';

// ── NameInput (parsed + normalized person name; consumed by @mailmetero/core) ─
export type NameScript = 'latin' | 'cjk' | 'cyrillic' | 'other';

export interface NameInput {
  /** Verbatim caller input echoed back for provenance/DSAR. */
  raw: {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    fullName?: string;   // split when first/last absent
  };
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  /** NFKD-stripped ASCII fold used to build local parts. */
  normalized: {
    firstName: string | null;
    middleName: string | null;
    lastName: string | null;
  };
  script: NameScript;
  isCjk: boolean;              // → cjk_ambiguous_downweight
  nicknameExpansions: string[];// from nicknames.csv (has_nickname triples), reduced weight
  surnameVariants: string[];   // compound/punctuated expansion, capped at 2 (PRD P0-2)
}

// ── DomainInput (canonicalized + classified target domain) ──────────────────
export interface DomainInput {
  raw: string;
  domain: Domain;
  isFreemail: boolean;         // → status 'webmail', not a derivation target
  isDisposable: boolean;       // → status 'disposable'
  sizeBracket: SizeBracket | null; // user-supplied or null (drives priors)
}

// ── Candidate (internal, camelCase — EXACT shape per task spec) ─────────────
export interface Candidate {
  email: EmailAddress;
  localPart: LocalPart;
  patternToken: PatternToken;
  score: number;              // 0–100, after caps
  reasonCodes: ReasonCode[];  // ≥1
  collisionRisk: boolean;
}

// ── VerificationEvidence (internal provenance attached to every result) ─────
export type HardCapId =
  | 'm365_accept_all'
  | 'catch_all_accept_all'
  | 'm365_prior_only'
  | 'catch_all_prior_only'
  | 'implicit_mx'
  | 'collision_risk'
  | 'degraded_backend';

export interface VerificationEvidence {
  tier: EvidenceTier;
  backend: Backend;
  producedByStage: PipelineStage;   // which cheapest-first stage decided the result
  mx: MxEnum | null;
  provider: Provider | null;
  verifiabilityClass: VerifiabilityClass | null;
  isCatchAll: boolean | null;
  rawSmtpCode: string | null;       // e.g. '550'
  enhancedCode: string | null;      // e.g. '5.1.1', '5.7.1'
  capsApplied: HardCapId[];
  verifiedAt: IsoTimestamp | null;
  stale: boolean;                   // verifiedAt older than staleness window (~90d)
}

// ── VerifierBackend contract (PRD §6; implemented in @mailmetero/verifier) ──
export type VerifyVerdict = Extract<Status, 'valid' | 'invalid' | 'accept_all' | 'unknown'>;

export interface VerifyContext {
  domain: Domain;
  mx: MxEnum;
  provider: Provider | null;
  verifiabilityClass: VerifiabilityClass;
  isCatchAll: boolean | null;
}

export interface VerifyOutcome {
  verdict: VerifyVerdict;
  subStatus: SubStatus;
  rawSmtpCode?: string;
  enhancedCode?: string;
}

export interface VerifierBackend {
  readonly kind: Backend;           // 'api' | 'smtp' | 'none'
  verify(email: EmailAddress, ctx: VerifyContext): Promise<VerifyOutcome>;
}

// ── MODULE_CONTRACTS §0 additions ────────────────────────────────────────────
/** ONE canonical per-row KB pattern observation. core aggregates it into a Map;
 *  pipeline/db pass it as an array. Resolves the DomainPatternSupport shape clash. */
export interface DomainPatternObservation {
  patternToken: PatternToken;
  observedCount: number;
  verifiedCount: number;
  lastSeenAt: IsoTimestamp | null;
  winningFold: string | null;
}

/** The raw fields decideBilling needs. Produced by pipeline, consumed by decideBilling (db). */
export interface BillingInput {
  endpoint: 'finder' | 'verifier';
  status: Status;
  subStatus: SubStatus | null;
  score: number;
  backend: Backend;
  evidence: EvidenceTier;   // 'degraded' ⇒ never billable (the corrected degradation signal)
  hasEmail: boolean;        // finder: an email was returned
}
