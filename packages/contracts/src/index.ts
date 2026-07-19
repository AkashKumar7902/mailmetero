// @mailmetero/contracts — the CONTRACTS_CORE.md canonical vocabulary, as code.
// This barrel is the ONLY import surface; downstream packages import from
// '@mailmetero/contracts', never from a deep path. The source below is the exact
// TypeScript in CONTRACTS_CORE.md, mechanically split into cohesive modules.
// Splitting is presentation-only: adding/removing a member is still a spec change
// that bumps the OpenAPI version and updates the frozen-registry snapshots (§9.2).

export * from './enums.js';          // §1  STATUSES, SUB_STATUSES, STATUS_SUBSTATUS, MX_ENUMS,
                                     //     PROVIDERS, VERIFIABILITY_CLASSES, PROVIDER_VERIFIABILITY,
                                     //     EVIDENCE_TIERS, BACKENDS, PIPELINE_STAGES, SIZE_BRACKETS, SOURCE_TAGS
export * from './reason-codes.js';   // §2  REASON_CODES + ReasonCode
export * from './error-codes.js';    // §3  ERROR_CODES + ErrorCode
export * from './primitives.js';     // §4  branded primitives (Domain, EmailAddress, TenantId, ...)
export * from './domain-types.js';   // §4  NameInput, DomainInput, Candidate, VerificationEvidence,
                                     //     VerifyContext, VerifyOutcome, VerifierBackend, HardCapId
export * from './wire.js';           // §4.1/§4.2 FinderResult, VerifierResult, envelopes, headers,
                                     //     job/account/usage/bulk shapes, JOB_STATUSES, RESPONSE_HEADERS
export * from './scoring.js';        // §5  ScoringConfig shape + DEFAULT_SCORING_CONFIG + band/cap types
