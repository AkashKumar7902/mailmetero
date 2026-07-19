// @mailmetero/db — SOLE Postgres owner. Public surface.
//
// Pools + client, camelCase row types, the live ScoringConfig loader, the ONE billing
// policy, HMAC key authentication (pepper stays here), every repository, seed loaders, and
// the D7 kb-invariant gate. api/worker/cron/pipeline import from '@mailmetero/db' only.

// ── pools / client / hash ───────────────────────────────────────────────────
export {
  createWebPool, createDirectPool, createPools, closePools, healthCheck,
  type DbPools,
} from './pool.ts';
export { withTransaction, rows, maybeOne, rowCount, type Queryable } from './client.ts';
export { computeSuppressionHash, sha256Hex } from './hash.ts';

// ── row types ───────────────────────────────────────────────────────────────
export type {
  Tenant, ApiKeyRow, ResultRow, UsageLedgerRow, JobRow, JobItemRow, IdempotencyRow,
  VerifierSpendRow, SuppressionRow, ObjectionRow,
  KbDomainRow, KbDomainPatternRow, KbProviderFingerprintRow, KbPatternPriorRow,
  KbTypoDomainRow, KbRoleLocalRow, UsageAggregate,
  Environment, ResultEndpoint, SuppressionScope, ObjectionScope, ObjectionStatus,
  LedgerKind, LedgerEndpoint,
} from './types.ts';

// ── billing policy (THE one definition) ─────────────────────────────────────
export {
  decideBilling,
  type BillingDecision, type BilledReason, type LedgerEndpoint as BillingLedgerEndpoint,
} from './billing/policy.ts';

// ── live scoring config ─────────────────────────────────────────────────────
export { createScoringConfigRepo, type ScoringConfigRepo } from './scoring-config.ts';

// ── auth ────────────────────────────────────────────────────────────────────
export {
  createKeyAuthenticator,
  type KeyAuthenticator, type AuthenticatedKey,
} from './auth/key-authenticator.ts';

// ── repositories ────────────────────────────────────────────────────────────
export { createTenantsRepo, type TenantsRepo } from './repositories/tenants.ts';
export { createApiKeysRepo, type ApiKeysRepo } from './repositories/api-keys.ts';
export { createResultsRepo, type ResultsRepo } from './repositories/results.ts';
export { createLedgerRepo, type LedgerRepo } from './repositories/usage-ledger.ts';
export { createRateCountersRepo, type RateCountersRepo } from './repositories/rate-counters.ts';
export { createIdempotencyRepo, type IdempotencyRepo, type ReserveResult } from './repositories/idempotency.ts';
export { createJobsRepo, type JobsRepo } from './repositories/jobs.ts';
export { createKbDomainsRepo, type KbDomainsRepo } from './repositories/kb-domains.ts';
export { createKbDomainPatternsRepo, type KbDomainPatternsRepo } from './repositories/kb-patterns.ts';
export { createKbProviderFingerprintsRepo, type KbProviderFingerprintsRepo } from './repositories/kb-provider-fingerprints.ts';
export { createPatternPriorsRepo, type PatternPriorsRepo } from './repositories/kb-priors.ts';
export { createKbClassificationRepo, type KbClassificationRepo } from './repositories/kb-classification.ts';
export { createSuppressionRepo, type SuppressionRepo } from './repositories/suppression.ts';
export { createObjectionsRepo, type ObjectionsRepo } from './repositories/objections.ts';
export { createDsarRepo, type DsarRepo, type DsarExportRow } from './repositories/dsar.ts';
export {
  makeSpendGuard, makeVerifierPolicyRepo,
  type SpendGuard, type VerifierPolicyRepo, type SpendDenyReason,
} from './repositories/verifier-spend.ts';

// ── seed loaders + normalizer ───────────────────────────────────────────────
export { normalizeDomainForSeed, FREEMAIL_JUNK_TOKENS } from './seed/normalize.ts';
export {
  seedClassificationTables, refreshClassificationTables,
  loadFreemailFromFile, loadDisposableUnionFromFiles,
  type ClassificationSeedCounts,
} from './seed/seed-classification.ts';
export {
  seedScoringAndFingerprints,
  SEED_ROLE_LOCALS, SEED_TYPO_DOMAINS, SEED_PATTERN_PRIORS, SEED_PROVIDER_FINGERPRINTS,
} from './seed/seed-scoring.ts';

// ── CI invariant (D7) ───────────────────────────────────────────────────────
export {
  KB_COLUMN_ALLOWLIST, PERSON_COLUMN_DENYLIST, assertKbHasNoPersonColumns, KbInvariantError,
} from './ci/kb-invariant.ts';
