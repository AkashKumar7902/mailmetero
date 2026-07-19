# mailmetero — FILE_MANIFEST (every source file + implementation unit)

**Implementation units (U0–U12)** are disjoint in file ownership: all files in a unit can be built by one
agent without editing another unit's files. `parallel_group` = units in the same group may run
concurrently. `(exists)` = already scaffolded on disk (reconcile, don't recreate blindly).

The DB two-domain split from the source designs is **collapsed into a single `@mailmetero/db` unit (U4)** —
the mechanical resolution of the table-ownership blocker. `core/tables.ts` and `core/billing.ts` are
**deliberately absent** (removed per verifier fixes).

| Unit | parallel_group | Title | depends_on |
|---|---|---|---|
| U0 | 0 | Root scaffolding & workspace | — |
| U1 | 0 | `@mailmetero/contracts` | — |
| U2 | 1 | `@mailmetero/config` | U1 |
| U3 | 1 | `@mailmetero/core` (pure derivation) | U1 |
| U4 | 2 | `@mailmetero/db` (sole Postgres owner) | U1, U2 |
| U5 | 2 | `@mailmetero/dns` | U1, U2 |
| U6 | 2 | `@mailmetero/verifier` | U1, U2 |
| U7 | 2 | `@mailmetero/email` | U1, U2 |
| U8 | 3 | `@mailmetero/pipeline` | U1, U2, U3, U4, U5, U6 |
| U9 | 4 | `@mailmetero/api` | U1, U2, U3, U4, U5, U6, U7, U8 |
| U10 | 4 | `@mailmetero/worker` | U1, U2, U3, U4, U5, U6, U8 |
| U11 | 4 | `@mailmetero/cron` | U1, U2, U4, U5, U7, U8 |
| U12 | 5 | CI compliance tests (`tools/`) | U0, U1, U2, U4, U8 |

---

## U0 — Root scaffolding & workspace (parallel_group 0)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `pnpm-workspace.yaml` *(exists)* | `packages: ["packages/*"]` | — | — |
| `package.json` *(exists)* | Private root; scripts build/test/lint/migrate/depgraph:check/ci:*; engines Node≥26; pnpm pin | — | — |
| `tsconfig.base.json` *(exists)* | Strict shared compilerOptions, project refs | — | — |
| `tsconfig.json` *(exists)* | Solution file: refs over all 11 packages | — | — |
| `.npmrc` | pnpm strictness (node-linker=isolated, engine-strict) | — | — |
| `dependency-cruiser.config.cjs` *(exists)* | Enforces §2 DAG; exports `ALLOWED` edge table | `ALLOWED` | — |
| `eslint.config.js` *(exists)* | Egress `no-restricted-imports/globals`; no scoring magic-number literals | — | — |
| `.node-pg-migraterc.json` | node-pg-migrate config (unpooled DSN, `packages/db/migrations`, schemas public/kb/ops) | — | U4 migrations |
| `render.yaml` *(exists; UPDATE)* | web+worker + **all 7** crons on Starter; migrations in web.preDeployCommand | — | — |
| `.env.example` | Documented non-secret template mirroring the `Env` contract (+ new fields) | — | — |
| `.github/workflows/ci.yml` | build+DAG+lint+typecheck+unit → 6 compliance invariants; opt-in integration on `DATABASE_URL_TEST` | — | U12 |

> **render.yaml fix:** add cron services `credit-back-sweep`, `quota-alert`, `objection-expiry` (P0-9 /
> P0-14 / objection-expiry were previously unscheduled). Rename `quota-reset` → `quota-spend-reset`. Seven
> cron services total.

## U1 — `@mailmetero/contracts` (parallel_group 0)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/contracts/package.json` *(exists)* | Manifest; no internal deps | — | — |
| `packages/contracts/tsconfig.json` *(exists)* | Build config | — | — |
| `packages/contracts/src/index.ts` *(exists; UPDATE barrel)* | Re-exports all member modules | `*` | member modules |
| `packages/contracts/src/enums.ts` | CONTRACTS_CORE §1 verbatim + `JOB_KINDS`, `JOB_ITEM_STATUSES` | `STATUSES`,`Status`,`SUB_STATUSES`,…,`JOB_KINDS`,`JobKind`,`JOB_ITEM_STATUSES`,`JobItemStatus` | — |
| `packages/contracts/src/reason-codes.ts` | §2 frozen `REASON_CODES` | `REASON_CODES`,`ReasonCode` | — |
| `packages/contracts/src/error-codes.ts` | §3 frozen `ERROR_CODES` | `ERROR_CODES`,`ErrorCode` | — |
| `packages/contracts/src/primitives.ts` | §4 branded primitives | `EmailAddress`,`Domain`,`LocalPart`,… | — |
| `packages/contracts/src/domain-types.ts` | §4 internal types + `DomainPatternObservation` + `BillingInput` | `NameInput`,`Candidate`,`VerificationEvidence`,`VerifierBackend`,`DomainPatternObservation`,`BillingInput`,… | enums, primitives, reason-codes |
| `packages/contracts/src/wire.ts` | §4.1/§4.2 wire shapes + envelopes/headers/job/account/usage/bulk | `FinderResult`,`VerifierResult`,`SuccessEnvelope`,`ErrorEnvelope`,`JOB_STATUSES`,`BulkAccepted`,… | enums, primitives, error-codes, reason-codes |
| `packages/contracts/src/scoring.ts` | §5 `ScoringConfig` + `DEFAULT_SCORING_CONFIG` | `ScoringConfig`,`HardCaps`,`ConfidenceBand`,`DEFAULT_SCORING_CONFIG` | — |

## U2 — `@mailmetero/config` (parallel_group 1)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/config/package.json` *(exists)* | Manifest (deps contracts, pino) | — | U1 |
| `packages/config/tsconfig.json` *(exists)* | Build config | — | — |
| `packages/config/src/env.ts` *(exists; UPDATE)* | Env + fail-fast loader; **USD→cents at load**; add vendorDir/api/pool fields | `Env`,`EnvError`,`loadEnv`,`verifierEnabled` | — |
| `packages/config/src/app-config.ts` *(NEW)* | Structured `AppConfig` (database/api/spend) — fixes B2 | `AppConfig`,`DatabaseConfig`,`ApiConfig`,`SpendConfig`,`loadAppConfig` | env |
| `packages/config/src/egress.ts` *(exists)* | Code-level egress allowlist + per-redirect re-validation; **no github host** | `EgressPolicy`,`buildEgressPolicy`,`EgressFetch`,`createEgressFetch`,`EgressBlockedError` | env, logger |
| `packages/config/src/logger.ts` *(exists)* | The ONE pino Logger + redaction | `Logger`,`REDACT_PATHS`,`redactString`,`createLogger` | env |
| `packages/config/src/scoring.ts` *(exists)* | `validateScoringConfig` + re-export DEFAULT | `validateScoringConfig`,`ScoringConfigError`,`DEFAULT_SCORING_CONFIG` | U1 |
| `packages/config/src/index.ts` *(exists; UPDATE)* | Barrel + `boot()`; export app-config | `boot`,`BootContext`,`*` | all above |

## U3 — `@mailmetero/core` (parallel_group 1)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/core/package.json` | Manifest (deps contracts, tldts) | — | U1, tldts |
| `packages/core/tsconfig.json` | Build config | — | — |
| `packages/core/src/index.ts` | Barrel | `*` | all below |
| `packages/core/src/canonicalize.ts` | Brand constructors + syntax gate (tldts, node:url) | `canonicalizeEmail`,`canonicalizeDomain`,`canonicalizeLocalPart`,`validateEmailSyntax` | U1, tldts, node:url |
| `packages/core/src/name/normalize.ts` | NFKD fold, script/CJK detect | `nfkdAsciiFold`,`detectScript`,`isCjkName`,`CJK_SURNAMES_BUILTIN` | U1 |
| `packages/core/src/name/german.ts` | ue/oe/ae/ss variants | `germanFoldVariants`,`isGermanicContext` | normalize |
| `packages/core/src/name/surname.ts` | Compound surname expansion (cap 2) | `expandSurnameVariants`,`SURNAME_VARIANT_CAP` | normalize |
| `packages/core/src/name/nicknames.ts` | Triple-CSV parser + bidirectional expand | `parseNicknamesCsv`,`expandGivenName`,`NicknameMap` | U1 |
| `packages/core/src/name/parse.ts` | `normalizeName`/`splitFullName` orchestrator | `normalizeName`,`splitFullName` | normalize, german, surname, nicknames |
| `packages/core/src/patterns.ts` | Pattern-token grammar + render | `renderPattern`,`KNOWN_PATTERN_TOKENS`,`isKnownPatternToken` | U1 |
| `packages/core/src/candidates.ts` | Candidate/permutation gen + dual collision (D9) | `generateCandidates`,`shouldEmitCollisionCandidates`,`DomainPatternSupport`,`PatternPriorTable` | patterns, canonicalize, scoring/* |
| `packages/core/src/classify.ts` | Role/freemail/disposable/typo over injected sets + `classifyDomainInput` | `classifyRoleLocal`,`correctTypoDomain`,`classifyDomainInput`,`ClassificationTables`,`ROLE_LOCALS_BUILTIN` | canonicalize |
| `packages/core/src/scoring/blend.ts` | Blend (verified support + verify + recency + prior) | `blendScore` | U1 |
| `packages/core/src/scoring/caps.ts` | Provider/catch-all/implicit caps + band map (reads ScoringConfig.caps) | `applyCaps`,`resolveBand` | blend |
| `packages/core/src/scoring/score.ts` | Single `scoreDerivation` (CI cap-ceiling target) | `scoreDerivation` | blend, caps |
| `packages/core/test/*.test.ts` | Unit tests: nicknames, canonicalize, candidates, caps property test | — | src |

> Removed vs source design: `core/tables.ts` (vendor parsing → db seed) and `core/billing.ts` (→ db `decideBilling`).

## U4 — `@mailmetero/db` (parallel_group 2) — sole Postgres owner

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/db/package.json` | Manifest (deps contracts, config, pg, node-pg-migrate) | — | U1, U2 |
| `packages/db/tsconfig.json` | Build config | — | — |
| `packages/db/src/index.ts` | Barrel (pools, repos, policy, seed, ci) | `*` | all below |
| `packages/db/src/pool.ts` | `createWebPool`/`createDirectPool` from `DatabaseConfig` (timeouts via DSN options) | `createWebPool`,`createDirectPool`,`createPools`,`closePools`,`healthCheck`,`DbPools` | pg, U2 |
| `packages/db/src/client.ts` | `Queryable`, `withTransaction`, row mappers | `Queryable`,`withTransaction` | pg |
| `packages/db/src/types.ts` | All camelCase row types + enums | `Tenant`,`ApiKeyRow`,`ResultRow`,`UsageLedgerRow`,`JobRow`,`JobItemRow`,`Kb*Row`,… | U1 |
| `packages/db/src/scoring-config.ts` | Live `ScoringConfig` loader (active-row + fallback; tx activate) | `ScoringConfigRepo`,`createScoringConfigRepo` | client, U1 |
| `packages/db/src/hash.ts` | Salted suppression hash + opaque sha256 | `computeSuppressionHash`,`sha256Hex` | U1, U2 |
| `packages/db/src/billing/policy.ts` | **The ONE `decideBilling`** (pure) | `decideBilling`,`BillingDecision`,`BilledReason`,`LedgerEndpoint` | U1 |
| `packages/db/src/auth/key-authenticator.ts` | HMAC prefix lookup + constant-time compare (pepper stays here) | `KeyAuthenticator`,`createKeyAuthenticator` | api-keys repo, U2 |
| `packages/db/src/repositories/tenants.ts` | TenantsRepo (+ `resetQuotas`, `tryDebitCredit`, `creditBack`) | `TenantsRepo`,`createTenantsRepo` | client, U1 |
| `packages/db/src/repositories/api-keys.ts` | ApiKeysRepo | `ApiKeysRepo`,`createApiKeysRepo` | client, U1 |
| `packages/db/src/repositories/results.ts` | ResultsRepo (insert/cache/DSAR/purge/countOverdue) | `ResultsRepo`,`createResultsRepo` | client, U1 |
| `packages/db/src/repositories/usage-ledger.ts` | LedgerRepo (attempt idempotent/credit-back/usage/redact) | `LedgerRepo`,`createLedgerRepo` | client, policy, U1 |
| `packages/db/src/repositories/rate-counters.ts` | RateCountersRepo (atomic UPDATE) | `RateCountersRepo`,`createRateCountersRepo` | client, U1 |
| `packages/db/src/repositories/idempotency.ts` | IdempotencyRepo (header + request_hash) | `IdempotencyRepo`,`createIdempotencyRepo` | client, U1 |
| `packages/db/src/repositories/jobs.ts` | JobsRepo (createJob/claim SKIP LOCKED/heartbeat/complete/sweep/reads) | `JobsRepo`,`createJobsRepo` | client, U1 |
| `packages/db/src/repositories/kb-domains.ts` | KbDomainsRepo | `KbDomainsRepo`,`createKbDomainsRepo` | client, U1 |
| `packages/db/src/repositories/kb-patterns.ts` | KbDomainPatternsRepo (D7 `bumpVerified` write-guard) | `KbDomainPatternsRepo`,`createKbDomainPatternsRepo` | client, U1 |
| `packages/db/src/repositories/kb-provider-fingerprints.ts` | KbProviderFingerprintsRepo | `KbProviderFingerprintsRepo`,… | client, U1 |
| `packages/db/src/repositories/kb-priors.ts` | PatternPriorsRepo | `PatternPriorsRepo`,… | client, U1 |
| `packages/db/src/repositories/kb-classification.ts` | KbClassificationRepo (lookups + replace/upsert loaders) | `KbClassificationRepo`,… | client, U1 |
| `packages/db/src/repositories/suppression.ts` | SuppressionRepo (isSuppressed + CLOSED writeSuppression) | `SuppressionRepo`,`createSuppressionRepo` | client, hash, U1 |
| `packages/db/src/repositories/objections.ts` | ObjectionsRepo (hash-only createPending/confirm/expire/recentByIp) | `ObjectionsRepo`,`createObjectionsRepo` | client, hash, suppression, U1 |
| `packages/db/src/repositories/dsar.ts` | DsarRepo (tenant-scoped export/delete) | `DsarRepo`,`createDsarRepo` | client, U1 |
| `packages/db/src/repositories/verifier-spend.ts` | SpendGuard + VerifierPolicyRepo (cents; single kill switch) | `SpendGuard`,`VerifierPolicyRepo`,`makeSpendGuard`,`makeVerifierPolicyRepo` | client, U1 |
| `packages/db/src/seed/normalize.ts` | Sole vendor-file normalizer (junk-filter, punycode) | `normalizeDomainForSeed`,`FREEMAIL_JUNK_TOKENS` | node:url |
| `packages/db/src/seed/seed-classification.ts` | `seedClassificationTables`/`refreshClassificationTables`/loaders (no egress) | `seedClassificationTables`,`refreshClassificationTables`,`loadFreemailFromFile`,`loadDisposableUnionFromFiles` | normalize, kb-classification, U1 |
| `packages/db/src/seed/seed-scoring.ts` | `seedScoringAndFingerprints` + seed constants | `seedScoringAndFingerprints`,`SEED_ROLE_LOCALS`,`SEED_TYPO_DOMAINS` | kb-priors, kb-provider-fingerprints, scoring-config, U1 |
| `packages/db/src/ci/kb-invariant.ts` | D7 allowlist/denylist + `assertKbHasNoPersonColumns` | `KB_COLUMN_ALLOWLIST`,`PERSON_COLUMN_DENYLIST`,`assertKbHasNoPersonColumns` | client |
| `packages/db/migrations/0000_extensions_schemas.ts` | pgcrypto/citext + schemas kb/ops | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0001_tenant_core.ts` | tenants/api_keys/results/rate_counters | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0002_kb_schema.ts` | kb.* 9 tables | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0003_jobs_queue.ts` | jobs/job_items | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0004_billing.ts` | usage_ledger/idempotency_keys | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0005_ops_spend_policy.ts` | ops.verifier_spend/ops.verifier_policy | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0006_compliance.ts` | suppression_global/objection_requests | `up`,`down` | node-pg-migrate |
| `packages/db/migrations/0007_seed_scoring_fingerprints.ts` | data seed (scoring/fingerprints/roles/typos) | `up`,`down` | seed-scoring |
| `packages/db/migrations/0008_seed_classification.ts` | data seed (freemail/disposable from vendored dir) | `up`,`down` | seed-classification |
| `packages/db/test/kb-no-person-columns.test.ts` | D7 runtime invariant (authoritative) + source grep backstop | — | ci/kb-invariant |
| `packages/db/test/migrations-roundtrip.test.ts` | up→down reversibility + seed idempotency | — | migrations |

## U5 — `@mailmetero/dns` (parallel_group 2)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/dns/package.json` | Manifest (deps contracts, config) | — | U1, U2 |
| `packages/dns/tsconfig.json` | Build config | — | — |
| `packages/dns/src/types.ts` | `MxHost`,`MxResolution`,`DohEndpointId` | those | U1 |
| `packages/dns/src/doh-transport.ts` | DohTransport + `createFetchDohTransport` (EgressFetch) | `DohTransport`,`createFetchDohTransport`,`DohResponse` | U1, U2, types |
| `packages/dns/src/mx-classify.ts` | Pure `classifyMx` (Null-MX/implicit/no-host) | `classifyMx` | types |
| `packages/dns/src/resolver.ts` | `createDnsResolver` (Google→Cloudflare fallback) | `DnsResolver`,`createDnsResolver` | doh-transport, mx-classify |
| `packages/dns/src/fingerprint.ts` | `fingerprintProvider` + `SEED_FINGERPRINT_RULES` | `fingerprintProvider`,`FingerprintRule`,`SEED_FINGERPRINT_RULES` | types |
| `packages/dns/src/index.ts` | Barrel | `*` | all above |
| `packages/dns/test/{mx-classify,resolver,fingerprint}.test.ts` | Unit tests (stub transport) | — | src |

## U6 — `@mailmetero/verifier` (parallel_group 2)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/verifier/package.json` | Manifest (deps contracts, config) | — | U1, U2 |
| `packages/verifier/tsconfig.json` | Build config | — | — |
| `packages/verifier/src/status-codes.ts` | `classifySmtpCode` (5.1.1/5.7.1/5.4.1) | `classifySmtpCode`,`SmtpCodeClassification` | U1 |
| `packages/verifier/src/vendor-client.ts` | `createFetchVendorClient` (EgressFetch) | `HttpsVerifierVendorClient`,`createFetchVendorClient`,`VendorVerifyResponse` | U1, U2 |
| `packages/verifier/src/https-api-backend.ts` | `createHttpsApiBackend` (UNVERIFIABLE clamp, D10) | `createHttpsApiBackend`,`DEFAULT_MILLIONVERIFIER_RESULT_MAP` | vendor-client, status-codes |
| `packages/verifier/src/null-backend.ts` | `createNullBackend` (degradation) | `createNullBackend` | U1 |
| `packages/verifier/src/catch-all.ts` | Catch-all probe (random local) | `createCatchAllProbe`,`randomProbeLocalPart`,`CatchAllProbe` | U1 |
| `packages/verifier/src/index.ts` | Barrel | `*` | all above |
| `packages/verifier/test/{status-codes,https-api-backend,catch-all}.test.ts` | Unit tests (stub client) | — | src |

## U7 — `@mailmetero/email` (parallel_group 2)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/email/package.json` | Manifest (deps contracts, config) | — | U1, U2 |
| `packages/email/tsconfig.json` | Build config | — | — |
| `packages/email/src/backend.ts` | `EmailBackend` + message types | `EmailBackend`,`OutboundEmail`,`SendReceipt`,`EmailMessageKind` | U1 |
| `packages/email/src/postmark.backend.ts` | Postmark HTTPS backend (EgressFetch) | `makePostmarkBackend` | backend, U2 |
| `packages/email/src/noop.backend.ts` | No-op backend (dev/test/sandbox) | `makeNoopBackend` | backend |
| `packages/email/src/templates.ts` | Typed template builders | `buildSignupKeyEmail`,`buildObjectionConfirmationEmail`,`buildQuotaAlertEmail` | backend |
| `packages/email/src/index.ts` | Barrel (+ `EMAIL_EGRESS_HOSTS` reference const) | `*`,`EMAIL_EGRESS_HOSTS` | all above |

## U8 — `@mailmetero/pipeline` (parallel_group 3)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/pipeline/package.json` | Manifest (deps contracts, config, core, db, dns, verifier) | — | U1,U2,U3,U4,U5,U6 |
| `packages/pipeline/tsconfig.json` | Build config | — | — |
| `packages/pipeline/src/types.ts` | Internal results + outputs | `InternalFinderResult`,`InternalVerifierResult`,`PipelineFinderOutput`,`PipelineVerifierOutput`,`ResolvedCandidate`,`PipelineMode` | U1 |
| `packages/pipeline/src/ports.ts` | Structural ports (suppression/classification/kb/tenant-cache/writeback/candidate/scorer) | `SuppressionPort`,`ClassificationPort`,`KbFactsPort`,`TenantCachePort`,`KbWritebackPort`,`CandidateGeneratorPort`,`ScorerPort`,`ScoreInput`,`ScoreOutput` | U1, U5(dns types) |
| `packages/pipeline/src/adapter.ts` | Core adapter (`createCoreAdapter`: injects priors/config; decomposes evidence; narrows status) | `createCoreAdapter` | U3, ports, types |
| `packages/pipeline/src/wire.ts` | **Internal→wire mapper** (api+worker import) | `toFinderResult`,`toVerifierResult`,`toWireCandidate`,`toBulkFinderRow`,`toBulkVerifierRow`,`toVerificationSummary` | U1, types |
| `packages/pipeline/src/budget.ts` | Budget (deadline/remaining/expired) | `Budget`,`createBudget` | U1 |
| `packages/pipeline/src/stage.ts` | Stage/StageContext/StageState/PipelineDeps | `Stage`,`StageContext`,`PipelineDeps`,`StageDecision`,`StageState` | dns, verifier, ports, types, budget |
| `packages/pipeline/src/stages/canonicalize-syntax.ts` | Stage 0 | `makeCanonicalizeSyntaxStage` | stage |
| `packages/pipeline/src/stages/suppression.ts` | Stage 1 (finder domain + verifier address+domain) | `makeSuppressionStage` | stage |
| `packages/pipeline/src/stages/classification.ts` | Stage 2 (webmail/disposable/role terminal) | `makeClassificationStage` | stage |
| `packages/pipeline/src/stages/tenant-cache.ts` | Stage 3 (verdict reuse; free_cache_dedupe) | `makeTenantCacheStage` | stage |
| `packages/pipeline/src/stages/kb-facts.ts` | Stage 4 (Null-MX terminal; KB catch-all/M365 skip verify; candidate gen for finder) | `makeKbFactsStage` | stage, adapter |
| `packages/pipeline/src/stages/dns-enum.ts` | Stage 5 (DoH → MxResolution) | `makeDnsEnumStage` | stage, dns |
| `packages/pipeline/src/stages/provider-fingerprint.ts` | Stage 6 (M365/catch-all short-circuit, D10) | `makeProviderFingerprintStage` | stage, dns |
| `packages/pipeline/src/stages/verifier-backend.ts` | Stage 7 (top-N verify + catch-all guard + budget degrade) | `makeVerifierBackendStage` | stage, verifier |
| `packages/pipeline/src/stages/score-writeback.ts` | Stage 8 (scorer; finder ADDRESS-suppression filter; kb writeback; BillingInput) | `makeScoreWritebackStage` | stage, adapter |
| `packages/pipeline/src/orchestrator.ts` | `createPipeline`/`buildStages` (finder candidate-gen placement) | `Pipeline`,`FinderRequest`,`VerifierRequest`,`createPipeline`,`buildStages` | stages, budget, types |
| `packages/pipeline/src/index.ts` | Barrel | `*` | all above |
| `packages/pipeline/test/{orchestrator,stages}.test.ts` | E2E with faked ports (M365 short-circuit; Null-MX; budget degrade; suppression equivalence; ≥1 reason) | — | src |

## U9 — `@mailmetero/api` (parallel_group 4)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/api/package.json` | Manifest (deps contracts, config, core, db, dns, verifier, email, pipeline, fastify) | — | U1–U8 |
| `packages/api/tsconfig.json` | Build config | — | — |
| `packages/api/src/deps.ts` | Ports api consumes; imports pipeline result types (no re-declare) | `ApiDeps`,`AuthPrincipal`,`RateLimiterPort`,`LedgerApiPort`,`IdempotencyApiPort`,`AccountPort`,`JobsApiPort`,`ScoringConfigLoader`,`EmailPort`,`ComplianceIntakePort` | U8, U4, U2 |
| `packages/api/src/types.ts` | RequestContext, EndpointId, fastify augmentation | `ENDPOINT_IDS`,`EndpointId`,`RequestContext`,`KeyPresentation` | U1, deps, fastify |
| `packages/api/src/envelope.ts` | Success/error envelope builders | `successEnvelope`,`errorEnvelope`,`apiError`,`makeMeta` | U1 |
| `packages/api/src/headers.ts` | Standard/conditional header setters | `HEADER`,`applyStandardHeaders`,`applyDeprecationHeader` | U1, types |
| `packages/api/src/errors.ts` | `ERROR_HTTP_STATUS`, `ApiException`, error/notFound handlers | `ERROR_HTTP_STATUS`,`ApiException`,`errorHandler`,`notFoundHandler`,factories | U1, envelope, headers |
| `packages/api/src/plugins/request-id.ts` | onRequest ctx + onSend headers | `requestIdPlugin` | types, headers |
| `packages/api/src/plugins/auth.ts` | Bearer/api_key= extract + KeyAuthenticator + Deprecation | `authPlugin`,`extractKey`,`logRedactionPaths` | deps, errors |
| `packages/api/src/plugins/rate-limit.ts` | preHandler attempt limiter | `rateLimitPlugin` | deps, errors |
| `packages/api/src/plugins/idempotency.ts` | GET 24h + POST header idempotency | `getIdempotencyPlugin`,`postIdempotencyPlugin`,`computeGetRequestHash`,`computePostRequestHash` | deps, errors, headers |
| `packages/api/src/plugins/billing.ts` | `settleBilling` (uses db `decideBilling`; no local predicate) | `settleBilling` | deps, U4(decideBilling) |
| `packages/api/src/adapters.ts` | Concrete port impls wrapping db repos/email/pipeline into `ApiDeps` | `buildApiDeps` | U4, U7, U8, deps |
| `packages/api/src/sandbox/fixtures.ts` | Fixture catalog (every Status + 202 + errors) | `FIXTURES`,`FIXTURE_STATUS_COVERAGE`,`FixtureCase` | U1, types, errors |
| `packages/api/src/sandbox/router.ts` | `SandboxRouter` (0-credit deterministic) | `SandboxRouter` | fixtures, types |
| `packages/api/src/schemas/enums.ts` | `enumSchema` | `enumSchema` | U1 |
| `packages/api/src/schemas/index.ts` | `SHARED_SCHEMAS` + `registerSchemas` | `SHARED_SCHEMAS`,`registerSchemas` | U1, enums |
| `packages/api/src/schemas/routes.ts` | Per-route Fastify schemas | route schema consts | schemas/index |
| `packages/api/src/mapping/wire.ts` | Re-exports pipeline wire mapper for route use | `toFinderResult`,`toVerifierResult`,… (re-export) | U8 |
| `packages/api/src/routes/finder.ts` | GET /v2/email-finder (canonicalize→pipeline→settle) | `finderRoutes` | deps, mapping, billing, pipeline |
| `packages/api/src/routes/verifier.ts` | GET /v2/email-verifier (sync→202) + /verifications/{id} | `verifierRoutes` | deps, mapping, billing |
| `packages/api/src/routes/bulk.ts` | POST bulk finds/verifications + GET status/results | `bulkRoutes` | deps, idempotency |
| `packages/api/src/routes/account.ts` | GET /v2/account, /v2/usage | `accountRoutes` | deps |
| `packages/api/src/routes/compliance.ts` | signup/objections/DSAR export+delete | `complianceRoutes` | deps, email |
| `packages/api/src/routes/meta.ts` | GET /v2/openapi.json, /healthz | `metaRoutes` | openapi/spec, deps |
| `packages/api/src/routes/index.ts` | `registerRoutes` (hook subset wiring) | `registerRoutes` | route modules |
| `packages/api/src/openapi/spec.ts` | Hand-written OpenAPI 3.1 (enum-driven) | `OPENAPI_DOCUMENT` | U1, schemas |
| `packages/api/src/openapi/validate.ts` | `validateResponseAgainstSpec` (CI response validation) | `validateResponseAgainstSpec` | openapi/spec |
| `packages/api/src/server.ts` | `buildServer` (hook chain, schemas, routes, handlers) | `buildServer` | all above |
| `packages/api/src/index.ts` | Composition root `main()` (assemble ApiDeps, listen) | `main` | server, adapters |
| `packages/api/test/*.test.ts` | Route tests with faked ports; fixture coverage; response validation | — | src |

## U10 — `@mailmetero/worker` (parallel_group 4)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/worker/package.json` | Manifest (deps contracts, config, core, db, dns, verifier, pipeline) | — | U1–U6, U8 |
| `packages/worker/tsconfig.json` | Build config | — | — |
| `packages/worker/src/deps.ts` | `WorkerConfig`/`WorkerDeps` + loaders | `WorkerConfig`,`WorkerDeps`,`loadWorkerConfig`,`buildWorkerDeps` | U2, U4, U8 |
| `packages/worker/src/loop.ts` | `runWorkerLoop` (claim→dispatch→heartbeat; random idle backoff) | `runWorkerLoop` | deps, processors |
| `packages/worker/src/processors/registry.ts` | `PROCESSORS` map | `JobProcessor`,`PROCESSORS` | processor modules |
| `packages/worker/src/processors/bulk-find.processor.ts` | bulk_find items (pipeline.find→decideBilling→ledger→wire→recordItemResult) | `bulkFindProcessor` | U8, U4(decideBilling), pipeline wire |
| `packages/worker/src/processors/bulk-verify.processor.ts` | bulk_verify items | `bulkVerifyProcessor` | U8, U4 |
| `packages/worker/src/processors/async-verify.processor.ts` | async_verify single item (202 path) | `asyncVerifyProcessor` | U8, U4 |
| `packages/worker/src/index.ts` | `bootstrapWorker` (unpooled pool, SIGTERM drain) | `bootstrapWorker` | deps, loop |
| `packages/worker/test/*.test.ts` | Loop/claim + per-item request_id idempotency (faked repos) | — | src |

## U11 — `@mailmetero/cron` (parallel_group 4)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `packages/cron/package.json` | Manifest (deps contracts, config, db, dns, email, pipeline) | — | U1,U2,U4,U5,U7,U8 |
| `packages/cron/tsconfig.json` | Build config | — | — |
| `packages/cron/src/job.ts` | CronJob types + timing/error harness + `CronDeps` | `CronJob`,`CronJobContext`,`CronJobReport`,`CronJobName`,`CronDeps` | U2 |
| `packages/cron/src/index.ts` | Dispatcher `runCron(name)` (argv; non-zero exit) | `runCron` | job, jobs/* |
| `packages/cron/src/jobs/ttl-purge.job.ts` | Batched purge + null ledger.result_id + zero-overdue assert | `ttlPurgeJob` | U4 |
| `packages/cron/src/jobs/stuck-job-sweep.job.ts` | `JobsRepo.sweepStuck` | `stuckJobSweepJob` | U4 |
| `packages/cron/src/jobs/quota-spend-reset.job.ts` | `TenantsRepo.resetQuotas` + prune spend rows | `quotaSpendResetJob` | U4 |
| `packages/cron/src/jobs/credit-back-sweep.job.ts` | `findCreditBackCandidates(30)`→`issueCreditBack` | `creditBackSweepJob` | U4 |
| `packages/cron/src/jobs/quota-alert.job.ts` | 80%/100% alert emails | `quotaAlertJob` | U4, U7 |
| `packages/cron/src/jobs/blocklist-sync.job.ts` | `refreshClassificationTables(q, vendorDir)` — no egress | `blocklistSyncJob` | U4 |
| `packages/cron/src/jobs/objection-expiry.job.ts` | `ObjectionsRepo.expireStale` | `objectionExpiryJob` | U4 |
| `packages/cron/test/*.test.ts` | Job unit tests (faked repos) | — | src |

## U12 — CI compliance tests `tools/` (parallel_group 5)

| Path | Purpose | Key exports | Depends-on |
|---|---|---|---|
| `tools/ci/check-kb-no-pii.test.ts` | Secondary source grep of db migrations (runtime db test is authoritative) | — | U4 |
| `tools/ci/check-no-suppression-leak.test.ts` | Grep contracts registries for suppress/object/blocked_contact | — | U1 |
| `tools/ci/check-egress-allowlist.test.ts` | No raw network APIs outside config; allowlist has only configured hosts (no LinkedIn/github) | — | U2 |
| `tools/ci/check-suppression-paths.test.ts` | `buildStages()[1]===makeSuppressionStage`, `appliesTo⊇{finder,verifier}`, stage 8 uses SuppressionPort | — | U8 |
| `tools/ci/check-frozen-registries.test.ts` | Snapshot every enum/registry member | — | U1 |
| `tools/ci/check-dag.test.ts` | Every `@mailmetero/*` edge ∈ ALLOWED (§2) | — | U0(dependency-cruiser) |
| `tools/test/setup-integration.ts` | Gate Neon suites on `DATABASE_URL_TEST`; skip (not fail) when absent | `INTEGRATION_DSN`,`hasDb`,`requireDb` | — |

---

## Totals

11 packages + root scaffolding + tools. ~150 source/config files across 13 implementation units (U0–U12).
Every DB table has exactly one owner (U4) and one migration; every cross-package type is declared once
(see `MODULE_CONTRACTS.md §11`).
