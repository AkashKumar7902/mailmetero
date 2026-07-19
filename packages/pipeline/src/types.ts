// @mailmetero/pipeline — canonical INTERNAL result types (camelCase).
//
// These are the pipeline's own output vocabulary. `@mailmetero/api` and `@mailmetero/worker`
// import them verbatim and never re-declare them; only `src/wire.ts` maps them to the
// snake_case wire shapes (MODULE_CONTRACTS §7.2). Wire shapes come from `@mailmetero/contracts`.

import type {
  EmailAddress,
  Domain,
  Status,
  SubStatus,
  ReasonCode,
  Provider,
  Backend,
  EvidenceTier,
  Candidate,
  VerificationEvidence,
  BillingInput,
  ErrorCode,
} from '@mailmetero/contracts';

/** Which endpoint the orchestrator is serving. */
export type PipelineMode = 'finder' | 'verifier';

/** The single winning candidate the finder chose (null when nothing derivable / filtered). */
export interface ResolvedCandidate {
  readonly email: EmailAddress;
  readonly score: number;
  readonly status: Status;
  readonly reasonCodes: ReasonCode[];
  readonly collisionRisk: boolean;
}

/** Canonical finder result — the derivation product for one (name, domain) request. */
export interface InternalFinderResult {
  email: EmailAddress | null;
  score: number;
  status: Status;
  subStatus: SubStatus | null;
  domain: Domain;
  firstName: string | null;
  lastName: string | null;
  reasonCodes: ReasonCode[];
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  collisionRisk: boolean;
  chosen: ResolvedCandidate | null;
  candidates: Candidate[];
  /** Carries verifiedAt, stale, raw SMTP codes, producing stage. */
  verification: VerificationEvidence;
}

/** Canonical verifier result — the verdict for one address. */
export interface InternalVerifierResult {
  email: EmailAddress;
  status: Status;
  score: number;
  subStatus: SubStatus | null;
  acceptAll: boolean;
  disposable: boolean;
  webmail: boolean;
  mxRecords: boolean;
  smtpCheck: boolean;
  reasonCodes: ReasonCode[];
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  rawSmtpCode: string | null;
  verification: VerificationEvidence;
}

/** Finder pipeline output: the result plus everything api/worker need to persist + bill. */
export type PipelineFinderOutput =
  | { kind: 'ok'; result: InternalFinderResult; billingInput: BillingInput; deferrable: false }
  | { kind: 'input_error'; code: Extract<ErrorCode, 'invalid_domain' | 'validation_error'>; details: string }
  | { kind: 'unavailable' };

/** Verifier pipeline output (adds the sync-budget deferral case). */
export type PipelineVerifierOutput =
  | { kind: 'ok'; result: InternalVerifierResult; billingInput: BillingInput }
  | { kind: 'deferred' }
  | { kind: 'input_error'; code: Extract<ErrorCode, 'invalid_email' | 'validation_error'>; details: string }
  | { kind: 'unavailable' };
