# mailmetero — MODULE_CONTRACTS (THE reconciled contract)

**Status:** BINDING. This is the single set of TypeScript interfaces/types/signatures every implementer
codes against. Every cross-domain mismatch the verifiers found is resolved here. Types from
`@mailmetero/contracts` (the `CONTRACTS_CORE.md` projection) are imported verbatim and NOT re-declared.

**Casing rule (CONTRACTS_CORE §0.1, amended):** wire types are `snake_case`; internal domain types are
`camelCase`. The internal→wire mapping lives in **`@mailmetero/pipeline` (`src/wire.ts`)** so that both
`@mailmetero/api` and `@mailmetero/worker` can import it. No package other than pipeline's `wire.ts`
constructs wire result types.

---

## 0. `@mailmetero/contracts` — additions to CONTRACTS_CORE.md

`contracts` is `CONTRACTS_CORE.md` split into member modules (verbatim). These **additions** resolve
shared-vocabulary gaps the verifiers found. They live in the noted modules.

```ts
// ── src/enums.ts (append) ───────────────────────────────────────────────────
export const JOB_KINDS = ['bulk_find', 'bulk_verify', 'async_verify'] as const;   // D4 unifies async_verify
export type JobKind = typeof JOB_KINDS[number];

export const JOB_ITEM_STATUSES = ['pending', 'done', 'failed'] as const;          // shared item enum
export type JobItemStatus = typeof JOB_ITEM_STATUSES[number];

// ── src/domain-types.ts (append) ────────────────────────────────────────────
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
```

> `JOB_STATUSES` (`queued/claimed/running/done/failed`) already exists in CONTRACTS_CORE §4.2 for the
> job-level status. `JOB_KINDS`/`JOB_ITEM_STATUSES`/`DomainPatternObservation`/`BillingInput` are the only
> new frozen additions and are covered by the frozen-registry snapshot.

---

## 1. `@mailmetero/config`

Resolves B2 (`AppConfig`), the ApiConfig-fields major, spend-unit (cents), `vendorDir`, and the
single `Logger`.

```ts
// ── src/env.ts (Env is unchanged EXCEPT spend caps become cents at load) ─────
export interface Env {
  // ... all existing fields (see packages/config/src/env.ts) ...
  // CHANGED: USD env vars are parsed → cents here (single unit, §6 of ARCHITECTURE):
  readonly globalDailyVerifierSpendCapCents: number;      // was ...Usd; ×100 at load
  readonly defaultTenantDailyVerifierSpendCapCents: number;
  // ADDED (absolute vendor-data anchor for seed/blocklist-sync; default new URL(...)):
  readonly vendorDir: string;
  // ADDED (static api tunables):
  readonly bodyLimitBytes: number;            // default 1_500_000
  readonly bulkMaxRows: number;               // default 1000
  readonly jobPendingRetryAfterSeconds: number; // default 2
  readonly trustProxy: boolean;               // default true (Render proxy)
  readonly openApiVersion: string;            // default '1.0.0'
  readonly poolMaxWeb: number;                // default 8
  readonly poolMaxWorker: number;             // default 4
  readonly statementTimeoutMs: number;        // default 8000
  readonly connTimeoutMs: number;             // default 5000
}
export class EnvError extends Error { readonly problems: readonly string[]; }
export function loadEnv(opts?: { source?: Record<string, string | undefined> }): Env;
export function verifierEnabled(env: Env): boolean;   // boot fail-safe: kill switch off && key present

// ── src/app-config.ts (NEW) — structured views db/api consume (fixes B2) ─────
export interface DatabaseConfig {
  pooledUrl: string; unpooledUrl: string; urlForRole: string; testUrl: string | null;
  poolMaxWeb: number; poolMaxWorker: number; statementTimeoutMs: number; connTimeoutMs: number;
}
export interface ApiConfig {
  port: number; bodyLimitBytes: number; bulkMaxRows: number;
  jobPendingRetryAfterSeconds: number; trustProxy: boolean; openApiVersion: string;
  // NOTE: finder/sync budgets are NOT here — read from ScoringConfig.caps (DB-tunable, D8).
}
export interface SpendConfig {
  killSwitchVerifierDefault: boolean;
  globalDailyVerifierSpendCapCents: number;
  defaultTenantDailyVerifierSpendCapCents: number;
}
export interface AppConfig {
  env: Env;
  database: DatabaseConfig;   // db.pool.ts consumes this (createWebPool/createDirectPool)
  api: ApiConfig;
  spend: SpendConfig;
  vendorDir: string;
}
export function loadAppConfig(source?: Record<string, string | undefined>): AppConfig;

// ── src/egress.ts ────────────────────────────────────────────────────────────
export interface EgressPolicy { readonly allowedHosts: ReadonlySet<string>; }
export class EgressBlockedError extends Error { readonly host: string; }
export function buildEgressPolicy(env: Env): EgressPolicy;   // hosts from DoH/verifier/ESP + egressExtraHosts; NO wildcard, NO github
export type EgressFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
export function createEgressFetch(policy: EgressPolicy, logger: Logger): EgressFetch;   // re-validates every redirect hop

// ── src/logger.ts (the ONE Logger; worker/cron/email import this) ────────────
import type { pino } from 'pino';
export type Logger = pino.Logger;
export const REDACT_PATHS: readonly string[];
export function redactString(s: string): string;   // scrubs sk_*, Bearer, api_key=, DSN pw
export function createLogger(env: Env): Logger;

// ── src/scoring.ts ────────────────────────────────────────────────────────────
export { DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
export type { ScoringConfig } from '@mailmetero/contracts';
export class ScoringConfigError extends Error { readonly problems: readonly string[]; }
export function validateScoringConfig(cfg: ScoringConfig): ScoringConfig;   // used by seed migration + db live loader

// ── src/index.ts ──────────────────────────────────────────────────────────────
export interface BootContext { readonly env: Env; readonly logger: Logger; readonly egressFetch: EgressFetch; readonly appConfig: AppConfig; }
export function boot(source?: Record<string, string | undefined>): BootContext;
```

---

## 2. `@mailmetero/core` (pure; imports only contracts + tldts + node:url)

Unchanged from the core design EXCEPT: **`src/tables.ts` and `src/billing.ts` are removed** (verifier
minors: vendor-list parsing belongs to db seed; billing has one home in db). Core keeps the
canonicalizers, name pipeline, classifiers (over injected sets), candidate generation, and scoring.

```ts
import type {
  EmailAddress, Domain, LocalPart, PatternToken, IsoTimestamp,
  NameInput, NameScript, DomainInput, Candidate, DomainPatternObservation,
  SizeBracket, Provider, MxEnum, VerifiabilityClass, Backend,
  EvidenceTier, Status, SubStatus, ReasonCode, ScoringConfig, BandId, HardCapId,
  VerifyOutcome, VerifyVerdict,
} from '@mailmetero/contracts';

// ── canonicalize.ts (ONLY place brands are minted) ───────────────────────────
export function canonicalizeLocalPart(raw: string): LocalPart;
export function canonicalizeDomain(raw: string): Domain | null;     // tldts eTLD+1, punycode, lowercase
export function canonicalizeEmail(raw: string): EmailAddress | null; // lowercase + strip one +tag
export type SyntaxVerdict =
  | { ok: true; email: EmailAddress; localPart: LocalPart; domain: Domain }
  | { ok: false; reasonCode: Extract<ReasonCode,'invalid_syntax'>; subStatus: Extract<SubStatus,'invalid_syntax'> };
export function validateEmailSyntax(raw: string): SyntaxVerdict;
export function isValidLocalPartSyntax(local: string): boolean;

// ── name/normalize.ts ─────────────────────────────────────────────────────────
export function nfkdAsciiFold(s: string): string;
export function detectScript(s: string): NameScript;
export const CJK_SURNAMES_BUILTIN: ReadonlySet<string>;
export function isCjkName(first: string | null, last: string | null, cjkSurnames?: ReadonlySet<string>): boolean;
// ── name/german.ts ──
export function germanFoldVariants(token: string): string[];
export function isGermanicContext(rawName: string, domain: Domain | null): boolean;
// ── name/surname.ts ──
export const SURNAME_VARIANT_CAP = 2 as const;
export function expandSurnameVariants(rawLastName: string): string[];
// ── name/nicknames.ts (parses the has_nickname TRIPLE csv) ──
export interface NicknameMap { readonly forward: ReadonlyMap<string, readonly string[]>; readonly reverse: ReadonlyMap<string, readonly string[]>; }
export function parseNicknamesCsv(csvText: string): NicknameMap;   // pure string→structure (db seed passes file text)
export interface NicknameExpandOptions { includeReverseCanonical?: boolean; includeSiblings?: boolean; maxExpansions?: number; }
export function expandGivenName(name: string, map: NicknameMap, opts?: NicknameExpandOptions): string[];
// ── name/parse.ts ──
export interface RawNameFields { firstName?: string; lastName?: string; middleName?: string; fullName?: string; }
export interface NormalizeNameOptions { domain?: Domain | null; cjkSurnames?: ReadonlySet<string>; nickname?: NicknameExpandOptions; emitGermanVariants?: boolean; }
export function splitFullName(fullName: string): { firstName: string | null; middleName: string | null; lastName: string | null };
export function normalizeName(raw: RawNameFields, nicknameMap: NicknameMap, opts?: NormalizeNameOptions): NameInput;

// ── patterns.ts ──
export interface PatternVars { first: string|null; last: string|null; middle: string|null; f: string|null; l: string|null; m: string|null; }
export const KNOWN_PATTERN_TOKENS: ReadonlySet<string>;
export function renderPattern(token: PatternToken, vars: PatternVars): string | null;
export function isKnownPatternToken(token: string): token is PatternToken;

// ── candidates.ts ──
export interface PatternPrior { token: PatternToken; weight: number; }
export type PatternPriorTable = Readonly<Record<SizeBracket, readonly PatternPrior[]>>;
export type DomainPatternSupport = ReadonlyMap<PatternToken, DomainPatternObservation>;   // Map keyed by token
export interface CollisionPolicy { emitOnMiddleName: boolean; emitOnLargeCompany: boolean; numericSuffixes: readonly number[]; middleInitialTokens: readonly PatternToken[]; }
export const DEFAULT_COLLISION_POLICY: Readonly<CollisionPolicy>;
export interface GenerateCandidatesInput {
  name: NameInput; domain: DomainInput; priors: PatternPriorTable; config: ScoringConfig;
  domainSupport?: DomainPatternSupport | null; fallbackBracket?: SizeBracket; collisionPolicy?: CollisionPolicy;
}
export function generateCandidates(input: GenerateCandidatesInput): Candidate[];   // ≤ caps.MAX_CANDIDATES, deduped, ≥1 reasonCode, dual collision candidates (D9)
export function shouldEmitCollisionCandidates(name: NameInput, domain: DomainInput, policy?: CollisionPolicy): boolean;

// ── classify.ts ──
export const ROLE_LOCALS_BUILTIN: ReadonlySet<string>;
export interface ClassificationTables { freemail: ReadonlySet<string>; disposable: ReadonlySet<string>; roleLocals: ReadonlySet<string>; typoDomains: ReadonlyMap<string, Domain>; }
export function classifyRoleLocal(localPart: LocalPart | string, roleLocals?: ReadonlySet<string>): boolean;
export function correctTypoDomain(domain: Domain, typoDomains: ReadonlyMap<string, Domain>): Domain | null;
export function classifyDomainInput(raw: string, tables: Pick<ClassificationTables,'freemail'|'disposable'>, sizeBracket?: SizeBracket | null): DomainInput | null;

// ── scoring/blend.ts ──
export interface BlendInput {
  patternPriorWeight: number; verifiedCount: number; observedCount: number;
  verifyVerdict: VerifyVerdict | null; recencyAgeDays: number | null;
  isNicknameVariant: boolean; isCjk: boolean; collisionRisk: boolean;
  weights: ScoringConfig['blendWeights']; caps: ScoringConfig['caps'];
}
export interface BlendOutput { rawScore: number; tentativeTier: Extract<EvidenceTier,'verified'|'learned_pattern'|'prior_only'|'degraded'>; components: { prior: number; support: number; verification: number; recency: number }; }
export function blendScore(input: BlendInput): BlendOutput;

// ── scoring/caps.ts (reads ceilings ONLY from injected ScoringConfig.caps) ──
export interface CapInput { rawScore: number; tentativeTier: BlendOutput['tentativeTier']; provider: Provider|null; mx: MxEnum; verifiabilityClass: VerifiabilityClass|null; isCatchAll: boolean|null; hasDomainSupport: boolean; backend: Backend; caps: ScoringConfig['caps']; bands: ScoringConfig['bands']; }
export interface CapResult { score: number; band: BandId; evidence: EvidenceTier; capsApplied: HardCapId[]; capReasonCodes: ReasonCode[]; }
export function applyCaps(input: CapInput): CapResult;
export function resolveBand(score: number, bands: ScoringConfig['bands']): BandId;

// ── scoring/score.ts (the single scoreDerivation entry — CI cap-ceiling target) ──
export interface ScoreDerivationInput {
  candidate: Candidate; priorWeight: number; verifiedCount: number; observedCount: number;
  sizeBracket: SizeBracket | null; provider: Provider | null; mx: MxEnum;
  verifiabilityClass: VerifiabilityClass | null; isCatchAll: boolean | null;
  verify: VerifyOutcome | null; recencyAgeDays: number | null; backend: Backend;
  isNicknameVariant: boolean; isCjk: boolean; config: ScoringConfig;
}
export interface ScoredResult {
  score: number; status: VerifyVerdict;   // derivation path returns VerifyVerdict ONLY (Status-terminal split)
  subStatus: SubStatus; band: BandId; evidence: EvidenceTier; reasonCodes: ReasonCode[]; capsApplied: HardCapId[];
}
/** INVARIANTS (CI §9.5): m365||isCatchAll ⇒ status 'accept_all', score ≤ caps.M365_ACCEPT_ALL_MAX (84), never 'valid';
 *  prior-only on those ⇒ ≤ caps.M365_PRIOR_ONLY_MAX (55); IMPLICIT_MX_FALLBACK ⇒ ≤ caps.IMPLICIT_MX_MAX (60);
 *  NULL_MX ⇒ 'invalid'/'null_mx'; verify.valid on verifiable non-catch-all ⇒ 'valid', 'verified', ≥ VERIFIED_BAND_MIN;
 *  backend 'none' never 'valid'; reasonCodes always ≥1. */
export function scoreDerivation(input: ScoreDerivationInput): ScoredResult;
```

**Status-terminal split (documented once):** `core.scoreDerivation` owns only the derivation verdict
(`valid|invalid|accept_all|unknown`). Terminal statuses `webmail`/`disposable`/`role` (classification) and
`invalid/null_mx`, `invalid/no_mail_host` (DNS) are set by **pipeline stages**, not core.

---

## 3. `@mailmetero/dns` (imports contracts, config)

```ts
export type DohEndpointId = 'google' | 'cloudflare';
export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'TXT';
export interface MxHost { readonly exchange: string; readonly preference: number; }
export interface MxResolution {
  readonly domain: Domain; readonly mx: MxEnum; readonly hosts: readonly MxHost[];
  readonly hasAddress: boolean; readonly spfPresent: boolean; readonly dmarcPresent: boolean;
  readonly resolvedVia: DohEndpointId; readonly resolvedAt: IsoTimestamp;
}
export interface DohAnswer { readonly name: string; readonly type: number; readonly TTL: number; readonly data: string; }
export interface DohResponse { readonly Status: number; readonly Answer?: readonly DohAnswer[]; }
export interface DohTransport { query(endpoint: DohEndpointId, name: string, type: DnsRecordType, signal?: AbortSignal): Promise<DohResponse>; }
export function createFetchDohTransport(deps: { fetch: EgressFetch; allowlist: readonly string[] }): DohTransport;   // uses config EgressFetch
export function classifyMx(input: { mxAnswers: readonly DohAnswer[]; hasAddress: boolean }): { mx: MxEnum; hosts: MxHost[] };
export interface DnsResolverOptions { readonly perEndpointTimeoutMs: number; readonly endpointOrder: readonly DohEndpointId[]; }
export interface DnsResolver { resolve(domain: Domain, signal?: AbortSignal): Promise<MxResolution>; }   // NXDOMAIN ⇒ NO_MAIL_HOST, never throws
export function createDnsResolver(transport: DohTransport, clock: () => number, opts?: Partial<DnsResolverOptions>): DnsResolver;
export interface FingerprintRule { readonly suffix: string; readonly provider: Provider; }
export interface ProviderFingerprint { readonly provider: Provider; readonly verifiabilityClass: VerifiabilityClass; readonly matchedSuffix: string | null; }
export function fingerprintProvider(domain: Domain, hosts: readonly MxHost[], rules: readonly FingerprintRule[], verifiabilityOverrides?: Readonly<Partial<Record<Provider, VerifiabilityClass>>>): ProviderFingerprint;   // longest-suffix wins; gmail.com→gmail_consumer
export const SEED_FINGERPRINT_RULES: readonly FingerprintRule[];
```

---

## 4. `@mailmetero/verifier` (imports contracts, config)

```ts
export interface SmtpCodeClassification { readonly verdict: VerifyVerdict; readonly subStatus: SubStatus; readonly rawSmtpCode: string | null; readonly enhancedCode: string | null; }
export function classifySmtpCode(input: { rawCode?: string; enhancedCode?: string; provider: Provider | null; verifiabilityClass: VerifiabilityClass }): SmtpCodeClassification;   // 5.1.1→invalid; 5.7.1→gateway_blocked; lone 550 5.4.1 on UNVERIFIABLE→accept_all
export interface HttpsVerifierVendorClient { verify(email: EmailAddress, signal?: AbortSignal): Promise<VendorVerifyResponse>; }
export interface VendorVerifyResponse { readonly resultCode: string; readonly rawSmtpCode?: string; readonly enhancedCode?: string; readonly subResult?: string; }
export function createFetchVendorClient(deps: { fetch: EgressFetch; baseUrl: string; apiKey: string; allowlist: readonly string[] }): HttpsVerifierVendorClient;
export type VendorResultMap = Readonly<Record<string, { verdict: VerifyVerdict; subStatus: SubStatus }>>;
export const DEFAULT_MILLIONVERIFIER_RESULT_MAP: VendorResultMap;
export interface HttpsApiBackendOptions { readonly timeoutMs: number; readonly resultMap: VendorResultMap; }
export function createHttpsApiBackend(client: HttpsVerifierVendorClient, opts: HttpsApiBackendOptions): VerifierBackend;   // CLAMPS: UNVERIFIABLE/UNKNOWN never 'valid' (D10 defense-in-depth)
export function createNullBackend(subStatus?: Extract<SubStatus,'backend_unavailable'|'timeout'|'gateway_blocked'>): VerifierBackend;   // kind 'none'
export interface CatchAllVerdict { readonly isCatchAll: boolean; readonly rawSmtpCode: string | null; readonly probedLocalPart: LocalPart; }
export interface CatchAllProbe { probe(domain: Domain, ctx: VerifyContext): Promise<CatchAllVerdict>; }
export function randomProbeLocalPart(rng?: () => number): LocalPart;
export function createCatchAllProbe(backend: VerifierBackend, rng?: () => number): CatchAllProbe;
```

---

## 5. `@mailmetero/db` — SOLE Postgres owner

`db` imports `AppConfig`/`DatabaseConfig` from config (B2). Repos are **free functions taking a shared
`Queryable`** so billing/results/ledger/debit compose in one `withTransaction`. Row types are camelCase.

### 5.1 Pools, client, billing policy, hash

```ts
import type { Pool, PoolClient } from 'pg';
import type { AppConfig, DatabaseConfig, Logger } from '@mailmetero/config';
import type { HardCaps, BillingInput, /* + all branded/enum types */ } from '@mailmetero/contracts';

export type Queryable = Pick<Pool | PoolClient, 'query'>;
export interface DbPools { web: Pool; direct: Pool; }
export function createWebPool(cfg: DatabaseConfig): Pool;     // pooled; unnamed prepared stmts; timeouts via DSN options, never SET
export function createDirectPool(cfg: DatabaseConfig): Pool;  // unpooled; SKIP LOCKED + long tx + session SET ok
export function createPools(cfg: AppConfig): DbPools;
export function closePools(pools: DbPools): Promise<void>;
export function healthCheck(q: Queryable): Promise<boolean>;
export function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T>;

// ── billing/policy.ts — THE ONE billing definition (pure; imported by api + worker) ──
export type LedgerEndpoint = 'finder' | 'verifier';
export type BilledReason =
  | 'finder_score_ge_min' | 'verifier_definitive'
  | 'free_invalid_syntax' | 'free_degraded' | 'free_non_definitive';
export interface BillingDecision { billable: boolean; creditsDelta: number; reason: BilledReason; }
/** PURE (§5 ARCHITECTURE). Verifier: status∈{valid,invalid} && sub≠invalid_syntax && evidence≠degraded.
 *  Finder: hasEmail && score≥caps.FINDER_BILLABLE_MIN && status≠accept_all && evidence≠degraded.
 *  Reads ONLY caps.FINDER_BILLABLE_MIN — no literals. */
export function decideBilling(input: BillingInput, caps: HardCaps): BillingDecision;

// ── hash.ts ──
export function computeSuppressionHash(canonicalValue: string, salt: string): SuppressionHash;   // salted SHA-256; SUPPRESSION_SALT (≠ pepper)
export function sha256Hex(value: string): string;   // opaque token/ip fingerprints
```

### 5.2 Row types (pinned column contracts)

```ts
export type Environment = 'live' | 'test';
export type ResultEndpoint = 'finder' | 'verifier';
export type SuppressionScope = 'address' | 'domain';
export type ObjectionScope = 'address' | 'address_and_domain';
export type ObjectionStatus = 'pending' | 'confirmed' | 'expired' | 'revoked' | 'manual_review';

/** PINNED tenants contract (fixes the missing-columns major). billing/spend read
 *  credits_remaining, daily_verifier_spend_cap_cents, quota_period_start. */
export interface Tenant {
  id: TenantId; ownerEmail: string; planName: string;
  retentionDays: number;
  searchQuota: number; verifyQuota: number;       // AccountInfo display
  creditsRemaining: number;                        // materialized balance; insufficient_credits pre-check
  dailyVerifierSpendCapCents: number;              // CENTS (single unit)
  quotaPeriodStart: IsoTimestamp;                  // basis for reset_date + period billing
  status: 'active' | 'suspended';
  createdAt: IsoTimestamp; updatedAt: IsoTimestamp;
}
export interface ApiKeyRow { id: string; tenantId: TenantId; keyPrefix: string; keyHashHex: string; environment: Environment; scopes: string[]; label: string | null; createdAt: IsoTimestamp; revokedAt: IsoTimestamp | null; lastUsedAt: IsoTimestamp | null; }
export interface ResultRow {
  id: string; tenantId: TenantId; requestId: RequestId; endpoint: ResultEndpoint; requestHash: string;
  inputFirstName: string | null; inputLastName: string | null; inputMiddleName: string | null; inputFullName: string | null;
  inputDomain: Domain | null; inputEmail: EmailAddress | null;
  email: EmailAddress | null; status: Status; subStatus: SubStatus | null; score: number;
  reasonCodes: ReasonCode[]; provider: Provider | null; backend: Backend; evidence: EvidenceTier; collisionRisk: boolean;
  acceptAll: boolean | null; disposable: boolean | null; webmail: boolean | null; mxRecords: boolean | null; smtpCheck: boolean | null;
  rawSmtpCode: string | null; enhancedCode: string | null; candidates: WireCandidate[]; source: 'derivation';
  billed: boolean; verifiedAt: IsoTimestamp | null; createdAt: IsoTimestamp; expiresAt: IsoTimestamp;
}
export interface UsageLedgerRow {
  id: string; tenantId: TenantId; requestId: RequestId; kind: 'attempt' | 'credit_back';
  endpoint: LedgerEndpoint; billable: boolean; creditsDelta: number;
  resultStatus: Status | null; resultSubStatus: SubStatus | null; resultScore: number | null;
  backend: Backend | null; evidence: EvidenceTier | null; billedReason: string | null;
  resultId: string | null; originalLedgerId: string | null; downgradeReason: string | null;
  occurredOn: string; createdAt: IsoTimestamp;
}
export interface JobRow {
  id: JobId; tenantId: TenantId; kind: JobKind; status: JobStatus;
  total: number; done: number; failed: number; attempts: number; maxAttempts: number; priority: number;
  runAfter: IsoTimestamp; lockedBy: string | null; lockedAt: IsoTimestamp | null; visibilityDeadline: IsoTimestamp | null;
  idempotencyKey: string | null; requestId: RequestId; lastError: string | null;
  createdAt: IsoTimestamp; startedAt: IsoTimestamp | null; finishedAt: IsoTimestamp | null;
}
export interface JobItemRow {
  id: string; jobId: JobId; tenantId: TenantId; rowIndex: number; requestId: RequestId;   // = `${job.requestId}:${rowIndex}`
  input: unknown; status: JobItemStatus; result: FinderResult | VerifierResult | ErrorEnvelope | null; resultId: string | null; error: unknown | null; processedAt: IsoTimestamp | null;
}
export interface IdempotencyRow { id: string; tenantId: TenantId; scope: 'header' | 'request_hash'; idempotencyKey: string | null; endpoint: string; requestHash: string; responseRef: unknown | null; statusCode: number | null; expiresAt: IsoTimestamp | null; createdAt: IsoTimestamp; }
export interface VerifierSpendRow { scopeTenantId: TenantId | null; spendDate: string; spendCents: number; updatedAt: IsoTimestamp; }  // NULL scopeTenantId = global
export interface SuppressionRow { hash: SuppressionHash; scope: SuppressionScope; createdAt: IsoTimestamp; }
export interface ObjectionRow { id: string; tokenHash: string; subjectSuppressionHash: SuppressionHash; domainSuppressionHash: SuppressionHash | null; scope: ObjectionScope; status: ObjectionStatus; requestIpHash: string | null; expiresAt: IsoTimestamp; confirmedAt: IsoTimestamp | null; createdAt: IsoTimestamp; }
// kb rows (NO person columns — CI-enforced)
export interface KbDomainRow { domain: Domain; mxEnum: MxEnum | null; provider: Provider | null; verifiabilityClass: VerifiabilityClass | null; isCatchAll: boolean | null; hasSpf: boolean | null; hasDmarc: boolean | null; sizeBracket: SizeBracket | null; mxHosts: string[]; observedCount: number; lastProbedAt: IsoTimestamp | null; expiresAt: IsoTimestamp; createdAt: IsoTimestamp; updatedAt: IsoTimestamp; }
export interface KbDomainPatternRow { id: string; domain: Domain; patternToken: PatternToken; observedCount: number; verifiedCount: number; winningFold: string | null; lastSeenAt: IsoTimestamp; createdAt: IsoTimestamp; }
export interface KbProviderFingerprintRow { id: number; mxSuffix: string; provider: Provider; verifiabilityClass: VerifiabilityClass; priority: number; notes: string | null; }
export interface KbPatternPriorRow { sizeBracket: SizeBracket; patternToken: PatternToken; share: number; rank: number; }
export interface KbTypoDomainRow { typo: string; correction: Domain; }
export interface KbRoleLocalRow { localPart: LocalPart; rfc2142: boolean; }
export interface UsageAggregate { creditsUsed: number; creditsRemaining: number; attempts: number; billable: number; creditBacks: number; byDay: Array<{ date: string; attempts: number; billable: number; creditBacks: number }>; }
```

### 5.3 Repositories

```ts
export interface TenantsRepo {
  create(q: Queryable, input: { ownerEmail: string; planName?: string; retentionDays?: number; searchQuota?: number; verifyQuota?: number; creditsRemaining?: number; dailyVerifierSpendCapCents?: number }): Promise<Tenant>;
  byId(q: Queryable, id: TenantId): Promise<Tenant | null>;
  byOwnerEmail(q: Queryable, email: string): Promise<Tenant | null>;
  tryDebitCredit(q: Queryable, id: TenantId, credits: number): Promise<number | null>;  // atomic; null if insufficient
  creditBack(q: Queryable, id: TenantId, credits: number): Promise<number>;
  setStatus(q: Queryable, id: TenantId, status: Tenant['status']): Promise<void>;
  updateRetention(q: Queryable, id: TenantId, days: number): Promise<void>;
  resetQuotas(q: Queryable, now: IsoTimestamp): Promise<number>;   // ADDED (quota-spend-reset cron); returns tenants reset
}
export interface ApiKeysRepo {
  insert(q: Queryable, input: { tenantId: TenantId; keyPrefix: string; keyHashHex: string; environment: Environment; scopes: string[]; label?: string }): Promise<ApiKeyRow>;
  byPrefix(q: Queryable, keyPrefix: string): Promise<ApiKeyRow | null>;
  touchLastUsed(q: Queryable, id: string, at: IsoTimestamp): Promise<void>;
  revoke(q: Queryable, id: string, at: IsoTimestamp): Promise<void>;
  listForTenant(q: Queryable, tenantId: TenantId): Promise<ApiKeyRow[]>;
}
/** api KeyAuthenticator wraps ApiKeysRepo.byPrefix + HMAC recompute + constant-time compare (pepper stays in db). */
export interface KeyAuthenticator { authenticate(rawKey: string): Promise<{ tenantId: TenantId; keyId: string; keyPrefix: string; environment: Environment; scopes: string[]; planName: string } | null>; }
export function createKeyAuthenticator(pools: DbPools, cfg: AppConfig): KeyAuthenticator;

export interface ResultsRepo {
  insert(q: Queryable, row: Omit<ResultRow,'id'|'createdAt'>): Promise<ResultRow>;
  findFreshByRequestHash(q: Queryable, tenantId: TenantId, requestHash: string, notBefore: IsoTimestamp): Promise<ResultRow | null>;   // stage-3 tenant cache
  byId(q: Queryable, id: string): Promise<ResultRow | null>;
  listForTenantByEmail(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<ResultRow[]>;   // DSAR export
  deleteForTenantByEmail(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<number>;      // DSAR delete (tenant scope only; NO global suppression, D6)
  markDowngraded(q: Queryable, id: string): Promise<void>;
  purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>;
  countOverdue(q: Queryable, cutoff: IsoTimestamp): Promise<number>;   // Success Metric 10 monitor
}
export interface LedgerRepo {
  recordAttempt(q: Queryable, input: { tenantId: TenantId; requestId: RequestId; endpoint: LedgerEndpoint; decision: BillingDecision; resultStatus: Status; resultSubStatus: SubStatus | null; resultScore: number; backend: Backend; evidence: EvidenceTier; resultId: string | null }): Promise<{ ledgerId: string; creditsDeltaApplied: number }>;   // idempotent on (tenant,request_id) WHERE kind='attempt'; ON CONFLICT DO NOTHING
  issueCreditBack(q: Queryable, originalLedgerId: string, downgradeReason: string): Promise<{ creditBackId: string; applied: boolean }>;   // unique per attempt
  findCreditBackCandidates(q: Queryable, withinDays: number, limit: number): Promise<Array<{ ledgerId: string; tenantId: TenantId; resultId: string | null; billedOn: string; reason: string }>>;   // joins results + kb.domains
  getUsage(q: Queryable, tenantId: TenantId, from: string | null, to: string | null): Promise<UsageInfo>;
  getPeriodBillable(q: Queryable, tenantId: TenantId, periodStart: string): Promise<{ billed: number; creditBacks: number }>;
  redactPastTtl(q: Queryable, cutoff: IsoTimestamp, limit: number): Promise<number>;
}
export interface IdempotencyRepo {
  lookupOrReserveHeaderKey(q: Queryable, input: { tenantId: TenantId; endpoint: string; idempotencyKey: string; requestHash: string }): Promise<{ kind: 'fresh'; id: string } | { kind: 'replay'; responseRef: unknown; statusCode: number } | { kind: 'conflict' }>;
  finalizeHeaderKey(q: Queryable, id: string, responseRef: unknown, statusCode: number): Promise<void>;
  lookupRequestHash(q: Queryable, tenantId: TenantId, endpoint: string, requestHash: string): Promise<{ responseRef: unknown; statusCode: number } | null>;   // 24h GET dedupe (THE single GET replay store)
  storeRequestHash(q: Queryable, input: { tenantId: TenantId; endpoint: string; requestHash: string; responseRef: unknown; statusCode: number; ttlSeconds: number }): Promise<void>;
  purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>;
}
export interface JobsRepo {
  createJob(q: Queryable, input: { tenantId: TenantId; kind: JobKind; requestId: RequestId; idempotencyKey?: string; expiresHint?: IsoTimestamp; items: Array<{ rowIndex: number; input: unknown }> }): Promise<BulkAccepted>;
  enqueueVerification(q: Queryable, tenantId: TenantId, email: string, requestId: RequestId): Promise<{ jobId: JobId }>;   // async_verify single-item
  claim(q: Queryable, workerId: string, batch: number, visibilityMs: number): Promise<JobRow[]>;   // UPDATE…FROM(SELECT…FOR UPDATE SKIP LOCKED)
  markRunning(q: Queryable, jobId: JobId): Promise<void>;
  listPendingItems(q: Queryable, jobId: JobId): Promise<JobItemRow[]>;
  recordItemResult(q: Queryable, itemId: string, result: FinderResult | VerifierResult, resultId: string | null): Promise<void>;   // WIRE result stored
  recordItemError(q: Queryable, itemId: string, error: ErrorEnvelope): Promise<void>;
  heartbeat(q: Queryable, jobId: JobId, workerId: string, visibilityMs: number): Promise<boolean>;
  completeJob(q: Queryable, jobId: JobId): Promise<void>;
  releaseJob(q: Queryable, jobId: JobId, reason: string, backoffMs: number): Promise<void>;
  failJob(q: Queryable, jobId: JobId, error: string): Promise<void>;
  getJobStatus(q: Queryable, tenantId: TenantId, jobId: JobId): Promise<BulkJobStatus | null>;
  getJobResults(q: Queryable, tenantId: TenantId, jobId: JobId, limit: number, offset: number): Promise<{ rows: Array<BulkFinderRow | BulkVerifierRow>; total: number; nextOffset: number | null }>;   // WIRE rows
  getVerificationResult(q: Queryable, tenantId: TenantId, jobId: JobId): Promise<{ kind: 'done'; result: VerifierResult } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'not_found' }>;   // WIRE
  sweepStuck(q: Queryable, now: IsoTimestamp, maxAttempts: number, backoffMs: number): Promise<{ requeued: number; failed: number }>;
}
export interface KbDomainsRepo { get(q: Queryable, domain: Domain): Promise<KbDomainRow | null>; upsertFacts(q: Queryable, row: Partial<KbDomainRow> & { domain: Domain; expiresAt: IsoTimestamp }): Promise<KbDomainRow>; setCatchAll(q: Queryable, domain: Domain, isCatchAll: boolean): Promise<void>; purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>; }
export interface KbDomainPatternsRepo {
  listForDomain(q: Queryable, domain: Domain): Promise<KbDomainPatternRow[]>;
  bumpObserved(q: Queryable, domain: Domain, pattern: PatternToken, winningFold?: string): Promise<void>;
  bumpVerified(q: Queryable, domain: Domain, pattern: PatternToken, domainIsAcceptAll: boolean): Promise<void>;   // D7 WRITE-GUARD: acceptAll ⇒ verified_count NOT incremented
}
export interface KbProviderFingerprintsRepo { loadAll(q: Queryable): Promise<KbProviderFingerprintRow[]>; upsert(q: Queryable, rows: Array<Omit<KbProviderFingerprintRow,'id'>>): Promise<void>; }
export interface PatternPriorsRepo { loadAll(q: Queryable): Promise<KbPatternPriorRow[]>; forBracket(q: Queryable, bracket: SizeBracket): Promise<KbPatternPriorRow[]>; upsert(q: Queryable, rows: KbPatternPriorRow[]): Promise<void>; }
export interface KbClassificationRepo {
  isFreemail(q: Queryable, domain: Domain): Promise<boolean>;
  isDisposable(q: Queryable, domain: Domain): Promise<boolean>;
  isRoleLocal(q: Queryable, localPart: LocalPart): Promise<boolean>;
  typoCorrection(q: Queryable, domain: string): Promise<Domain | null>;
  replaceFreemail(q: Queryable, domains: string[]): Promise<number>;
  replaceDisposable(q: Queryable, domains: string[]): Promise<number>;
  upsertRoleLocals(q: Queryable, rows: KbRoleLocalRow[]): Promise<number>;
  upsertTypos(q: Queryable, rows: KbTypoDomainRow[]): Promise<number>;
}
export interface SuppressionRepo {
  isSuppressed(q: Queryable, hashes: SuppressionHash[]): Promise<boolean>;   // boolean only; stage-1
  writeSuppression(q: Queryable, entries: Array<{ hash: SuppressionHash; scope: SuppressionScope }>, tx: PoolClient): Promise<void>;   // CLOSED: only ObjectionRepo.confirm calls this
}
export interface ObjectionsRepo {
  createPending(q: Queryable, input: { email: EmailAddress; domain: Domain; scope: ObjectionScope; requestIp: string; ttlSeconds: number }): Promise<{ objectionId: string; token: string }>;   // stores hashes + token_hash; NO plaintext; returns raw token for the email
  confirm(q: Queryable, token: string): Promise<{ kind: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' }>;   // writes suppression in same tx
  expireStale(q: Queryable, now: IsoTimestamp): Promise<number>;
  recentByIp(q: Queryable, requestIp: string, windowSeconds: number): Promise<number>;
}
export interface DsarRepo {
  exportForSubject(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<Array<{ email: string; domain: string; status: Status; subStatus: SubStatus | null; score: number; backend: Backend; evidence: EvidenceTier; source: 'derivation'; requestId: string; verifiedAt: string | null; createdAt: string }>>;
  deleteForSubject(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<{ removed: number }>;   // tenant scope only; NO global suppression (D6)
}
export interface SpendGuard {
  check(q: Queryable, tenantId: TenantId, tenantDailyCapCents: number | null, day: Date): Promise<{ allowed: true } | { allowed: false; reason: 'kill_switch' | 'global_cap' | 'tenant_cap' }>;
  record(q: Queryable, tenantId: TenantId, cents: number, day: Date): Promise<void>;   // upsert tenant + global (CENTS)
}
export interface VerifierPolicyRepo {
  getPolicy(q: Queryable): Promise<{ killSwitchEnabled: boolean; globalDailyCapCents: number | null }>;   // ops.verifier_policy singleton
  setKillSwitch(q: Queryable, enabled: boolean, updatedBy: string): Promise<void>;
  setGlobalDailyCap(q: Queryable, capCents: number | null, updatedBy: string): Promise<void>;
}
export interface RateCountersRepo { incrementAndGet(q: Queryable, input: { apiKeyId: string; windowStart: IsoTimestamp; windowSeconds: number; limitMax: number }): Promise<{ count: number; limitMax: number; resetAt: IsoTimestamp }>; purgeOld(q: Queryable, before: IsoTimestamp): Promise<number>; }

// each repo has a create*Repo() factory, e.g. export function createLedgerRepo(): LedgerRepo;
```

### 5.4 Live ScoringConfig loader, seed loaders, CI invariant, classification refresh

```ts
export interface ScoringConfigRepo {
  loadActive(q: Queryable): Promise<ScoringConfig>;   // from active kb.blend_weights row (weights+caps+bands jsonb); DEFAULT_SCORING_CONFIG only when zero active
  insertVersion(q: Queryable, cfg: ScoringConfig, activate: boolean): Promise<void>;
  activate(q: Queryable, version: string): Promise<void>;   // ONE tx: clear is_active then set (partial-unique safe)
}
export function createScoringConfigRepo(): ScoringConfigRepo;

// ── seed/normalize.ts (SOLE vendor-file parser; core has none) ──
export const FREEMAIL_JUNK_TOKENS: ReadonlySet<string>;   // '404: not found', asean-mail, housefancom, multiplechoices
export function normalizeDomainForSeed(raw: string): string | null;   // lowercase + url.domainToASCII + must-contain-a-dot
// ── seed/seed-classification.ts (idempotent; reused by blocklist-sync cron) ──
export function loadFreemailFromFile(path: string): string[];
export function loadDisposableUnionFromFiles(paths: { primary: string; freemailDisposable: string }): string[];
export function seedClassificationTables(q: Queryable, vendorDir: string): Promise<{ freemail: number; disposable: number; roles: number; typos: number }>;
export function refreshClassificationTables(q: Queryable, vendorDir: string): Promise<{ freemail: number; disposable: number; roles: number; typos: number }>;   // thin wrapper; NO egress (re-seeds from vendored files) — injected into blocklist-sync
// ── seed/seed-scoring.ts ──
export function seedScoringAndFingerprints(q: Queryable): Promise<void>;
export const SEED_ROLE_LOCALS: ReadonlyArray<KbRoleLocalRow>;
export const SEED_TYPO_DOMAINS: ReadonlyArray<KbTypoDomainRow>;
// ── ci/kb-invariant.ts (AUTHORITATIVE D7 gate) ──
export const KB_COLUMN_ALLOWLIST: ReadonlySet<string>;
export const PERSON_COLUMN_DENYLIST: RegExp;
export function assertKbHasNoPersonColumns(q: Queryable): Promise<void>;   // introspects information_schema; throws listing offenders
```

---

## 6. `@mailmetero/email` (imports contracts, config)

```ts
import type { Logger } from '@mailmetero/config';   // the ONE Logger (no re-declaration)
export type EmailMessageKind = 'signup_key' | 'objection_confirmation' | 'quota_alert';
export interface OutboundEmail { to: string; kind: EmailMessageKind; subject: string; html: string; text: string; tag: EmailMessageKind; messageStream?: string; }
export interface SendReceipt { providerMessageId: string; accepted: boolean; }
export interface EmailBackend { readonly kind: 'postmark' | 'noop'; send(msg: OutboundEmail): Promise<SendReceipt>; }
export function makePostmarkBackend(deps: { fetch: EgressFetch; baseUrl: string; apiKey: string; fromEmail: string; messageStream: string; logger: Logger }): EmailBackend;
export function makeNoopBackend(logger?: Logger): EmailBackend;
export function buildSignupKeyEmail(input: { to: string; apiKeyPlaintext: string; docsUrl: string }): OutboundEmail;
export function buildObjectionConfirmationEmail(input: { to: string; confirmUrl: string; expiresAt: string }): OutboundEmail;
export function buildQuotaAlertEmail(input: { to: string; planName: string; usedPct: number; resetDate: string }): OutboundEmail;
export const EMAIL_EGRESS_HOSTS: readonly string[];   // e.g. ['api.postmarkapp.com'] — contributed to config allowlist via env, not imported by config
```

> **Egress note:** `config.buildEgressPolicy` derives hosts from env (`ESP_API_BASE_URL` host etc.), NOT by
> importing `@mailmetero/email` (that would be a config→email DAG cycle). `EMAIL_EGRESS_HOSTS` is a
> reference constant only. blocklist-sync does NO egress (re-seeds from vendored files), so there is no
> `CRON_SYNC_EGRESS_HOSTS`.

---

## 7. `@mailmetero/pipeline` — canonical internal results + wire mapper + orchestrator

Pipeline OWNS the canonical internal result types (api imports them), the internal→wire mapper (api and
worker import it), the core adapter, and the stage orchestrator.

### 7.1 Ports the pipeline consumes (impls injected from db/dns/verifier/core adapter)

```ts
// provided by @mailmetero/core (via pipeline's adapter that injects priors/config/domainSupport)
export interface CandidateGeneratorPort { generate(name: NameInput, domain: DomainInput, domainSupport: DomainPatternObservation[] | null): Candidate[]; }
export interface ScorerPort { score(input: ScoreInput): ScoreOutput; }   // wraps core.scoreDerivation; status narrowed below
export interface ScoreInput { candidate: Candidate; evidence: VerificationEvidence; domainSupport: DomainPatternObservation | null; sizeBracket: SizeBracket | null; verify: VerifyOutcome | null; config: ScoringConfig; }
export interface ScoreOutput { score: number; status: VerifyVerdict; subStatus: SubStatus | null; reasonCodes: ReasonCode[]; evidenceTier: EvidenceTier; capsApplied: HardCapId[]; }   // status is VerifyVerdict (derivation path only)
// provided by @mailmetero/db
export interface SuppressionPort { isSuppressed(hashes: SuppressionHash[]): Promise<boolean>; }
export interface ClassificationPort { isFreemail(domain: Domain): Promise<boolean>; isDisposable(domain: Domain): Promise<boolean>; isRoleLocal(local: LocalPart): Promise<boolean>; correctTypoDomain(domain: Domain): Promise<Domain | null>; }
export interface KbDomainFacts { readonly mx: MxEnum | null; readonly provider: Provider | null; readonly verifiabilityClass: VerifiabilityClass | null; readonly isCatchAll: boolean | null; readonly lastProbedAt: IsoTimestamp | null; readonly ttlFresh: boolean; }
export interface KbFactsPort { getDomainFacts(domain: Domain): Promise<KbDomainFacts | null>; getDomainPatterns(domain: Domain): Promise<DomainPatternObservation[]>; }
export interface TenantCachePort { lookup(tenantId: TenantId, key: ResultCacheKey): Promise<{ result: InternalFinderResult | InternalVerifierResult; cachedAt: IsoTimestamp } | null>; }   // read-only (api/worker write via ResultsRepo)
export interface ResultCacheKey { readonly kind: 'find' | 'verify'; readonly hash: string; }
export interface KbWritebackPort {
  upsertDomainFacts(facts: { domain: Domain; mx: MxEnum; provider: Provider; verifiabilityClass: VerifiabilityClass; isCatchAll: boolean | null; spfPresent: boolean; dmarcPresent: boolean; probedAt: IsoTimestamp }): Promise<void>;
  recordPatternObservation(obs: { domain: Domain; pattern: PatternToken; verified: boolean; acceptAllDomain: boolean }): Promise<void>;   // acceptAllDomain ⇒ db MUST NOT bump verified_count (D7)
}
```

### 7.2 Canonical internal results (api imports these — NOT re-declared)

```ts
export type PipelineMode = 'finder' | 'verifier';
export interface ResolvedCandidate { readonly email: EmailAddress; readonly score: number; readonly status: Status; readonly reasonCodes: ReasonCode[]; readonly collisionRisk: boolean; }

export interface InternalFinderResult {
  email: EmailAddress | null; score: number; status: Status; subStatus: SubStatus | null;
  domain: Domain; firstName: string | null; lastName: string | null;
  reasonCodes: ReasonCode[]; provider: Provider | null; backend: Backend; evidence: EvidenceTier;
  collisionRisk: boolean; chosen: ResolvedCandidate | null; candidates: Candidate[];
  verification: VerificationEvidence;   // carries verifiedAt, stale, sub_status source
}
export interface InternalVerifierResult {
  email: EmailAddress; status: Status; score: number; subStatus: SubStatus | null;
  acceptAll: boolean; disposable: boolean; webmail: boolean; mxRecords: boolean; smtpCheck: boolean;
  reasonCodes: ReasonCode[]; provider: Provider | null; backend: Backend; evidence: EvidenceTier;
  rawSmtpCode: string | null; verification: VerificationEvidence;
}
/** Pipeline output carries what api AND worker need: the result, resultId hint, BillingInput, deferrable. */
export type PipelineFinderOutput =
  | { kind: 'ok'; result: InternalFinderResult; billingInput: BillingInput; deferrable: false }
  | { kind: 'input_error'; code: Extract<ErrorCode,'invalid_domain'|'validation_error'>; details: string }
  | { kind: 'unavailable' };
export type PipelineVerifierOutput =
  | { kind: 'ok'; result: InternalVerifierResult; billingInput: BillingInput }
  | { kind: 'deferred' }   // sync budget exceeded on a verifiable provider ⇒ api/worker 202-enqueue
  | { kind: 'input_error'; code: Extract<ErrorCode,'invalid_email'|'validation_error'>; details: string }
  | { kind: 'unavailable' };
```

> **Persistence boundary:** pipeline does NOT insert `results`/`usage_ledger` nor debit credits. It writes
> `kb.*` in stage 8 and returns the output above. api/worker persist `results` + ledger (see §8/§9). The
> `resultId` linking is produced by the api/worker `ResultsRepo.insert`, not the pipeline.

### 7.3 Budget, stage, orchestrator, wire mapper

```ts
export interface Budget { readonly deadline: number; remaining(clock: () => number): number; expired(clock: () => number): boolean; }
export function createBudget(clock: () => number, budgetMs: number, callerMaxMs?: number): Budget;

export interface PipelineDeps {
  resolver: DnsResolver; backend: VerifierBackend; catchAllProbe: CatchAllProbe;
  fingerprintRules: readonly FingerprintRule[]; verifiabilityOverrides?: Readonly<Partial<Record<Provider, VerifiabilityClass>>>;
  scoringConfig: ScoringConfig; clock: () => number;
  suppression: SuppressionPort; classification: ClassificationPort; tenantCache: TenantCachePort;
  kbFacts: KbFactsPort; kbWriteback: KbWritebackPort;
  candidates: CandidateGeneratorPort; scorer: ScorerPort;
}
export interface StageState { candidates: Candidate[]; mx: MxResolution | null; fingerprint: ProviderFingerprint | null; domainFacts: KbDomainFacts | null; patternSupport: DomainPatternObservation[]; isCatchAll: boolean | null; verifyOutcomes: Map<EmailAddress, VerifyOutcome>; evidence: Partial<VerificationEvidence>; }
export interface StageContext { readonly mode: PipelineMode; readonly tenantId: TenantId; readonly requestId: RequestId; readonly deps: PipelineDeps; readonly budget: Budget; readonly cacheKey: ResultCacheKey; readonly name?: NameInput; readonly domainInput: DomainInput; readonly email?: EmailAddress; readonly localPart?: LocalPart; readonly state: StageState; }
export type StageDecision = { readonly kind: 'continue' } | { readonly kind: 'terminal'; readonly output: PipelineFinderOutput | PipelineVerifierOutput };
export interface Stage { readonly id: PipelineStage; readonly appliesTo: readonly PipelineMode[]; run(ctx: StageContext): Promise<StageDecision>; }

export function makeCanonicalizeSyntaxStage(): Stage;     // 0
export function makeSuppressionStage(): Stage;           // 1  (appliesTo ['finder','verifier'] — CI-checked)
export function makeClassificationStage(): Stage;        // 2
export function makeTenantCacheStage(): Stage;           // 3
export function makeKbFactsStage(): Stage;               // 4  (finder: candidate generation runs before this via orchestrator)
export function makeDnsEnumStage(): Stage;               // 5
export function makeProviderFingerprintStage(): Stage;   // 6  (M365/catch-all short-circuit)
export function makeVerifierBackendStage(): Stage;       // 7  (top-VERIFY_TOP_N; catch-all guard)
export function makeScoreWritebackStage(): Stage;        // 8  (finder ADDRESS-suppression filter here; kb writeback; terminal)
export function buildStages(): Stage[];                  // ordered 0..8; buildStages()[1] === makeSuppressionStage()

export interface FinderRequest { tenantId: TenantId; requestId: RequestId; name: NameInput; domain: DomainInput; cacheKey: ResultCacheKey; maxDurationMs?: number; }
export interface VerifierRequest { tenantId: TenantId; requestId: RequestId; email: EmailAddress; domain: DomainInput; cacheKey: ResultCacheKey; budgetMs?: number; }
export interface Pipeline { find(req: FinderRequest): Promise<PipelineFinderOutput>; verify(req: VerifierRequest): Promise<PipelineVerifierOutput>; }
export function createPipeline(deps: PipelineDeps): Pipeline;
/** The pipeline adapter binding core to the ports (injects priors + config + domainSupport). */
export function createCoreAdapter(deps: { priors: PatternPriorTable; config: ScoringConfig }): { candidates: CandidateGeneratorPort; scorer: ScorerPort };

// ── src/wire.ts — the ONLY internal→wire boundary (api + worker import) ──
export function toWireCandidate(c: Candidate): WireCandidate;
export function toVerificationSummary(status: Status, ev: VerificationEvidence): VerificationSummary;
export function toFinderResult(r: InternalFinderResult): FinderResult;
export function toVerifierResult(r: InternalVerifierResult): VerifierResult;
export function toBulkFinderRow(input: { first_name: string; last_name: string; domain: string }, r: InternalFinderResult | ApiError): BulkFinderRow;
export function toBulkVerifierRow(input: { email: string }, r: InternalVerifierResult | ApiError): BulkVerifierRow;
```

---

## 8. `@mailmetero/api` — Fastify `/v2` surface

api imports the canonical `Pipeline`/results/outputs from pipeline, the wire mapper from pipeline,
`decideBilling` from db, budgets from `ScoringConfig.caps` (not ApiConfig), and `ApiConfig` from config.
It re-declares no pipeline result type.

```ts
import type { Pipeline, FinderRequest, VerifierRequest, PipelineFinderOutput, PipelineVerifierOutput, InternalFinderResult, InternalVerifierResult } from '@mailmetero/pipeline';
import { toFinderResult, toVerifierResult } from '@mailmetero/pipeline';
import { decideBilling } from '@mailmetero/db';
import type { ApiConfig } from '@mailmetero/config';

// ── ports (auth/rate/idem/ledger/account/jobs/scoring/email/compliance) ──
export interface AuthPrincipal { tenantId: TenantId; keyId: string; keyPrefix: string; environment: 'live'|'test'; scopes: string[]; planName: string; }
export interface RateLimiterPort { consumeAttempt(principal: AuthPrincipal, now: IsoTimestamp): Promise<{ limit: number; remaining: number; resetEpochSeconds: number; exceeded: boolean }>; }
export interface LedgerApiPort {   // thin api view over db LedgerRepo + TenantsRepo, runs the atomic tx
  settle(input: { principal: AuthPrincipal; requestId: RequestId; endpoint: EndpointId; result: InternalFinderResult | InternalVerifierResult; billingInput: BillingInput }): Promise<{ billed: boolean; creditsRemaining: number; resultId: string | null }>;
  creditsRemaining(tenantId: TenantId): Promise<number>;
}
export interface IdempotencyApiPort {
  reservePost(a: { tenantId: TenantId; idempotencyKey: string; endpoint: EndpointId; requestHash: string }): Promise<{ kind: 'fresh' } | { kind: 'replay'; stored: StoredResponse } | { kind: 'conflict' }>;
  finalizePost(a: { tenantId: TenantId; idempotencyKey: string; endpoint: EndpointId; stored: StoredResponse }): Promise<void>;
  lookupGet(tenantId: TenantId, requestHash: string, endpoint: EndpointId): Promise<StoredResponse | null>;
  recordGet(tenantId: TenantId, requestHash: string, endpoint: EndpointId, resp: StoredResponse): Promise<void>;
}
export interface StoredResponse { httpStatus: number; body: unknown; billed: boolean; locationHeader?: string; }
export interface AccountPort { getAccount(tenantId: TenantId): Promise<AccountInfo>; getUsage(tenantId: TenantId, from?: string, to?: string): Promise<UsageInfo>; }
export interface JobsApiPort {   // WIRE in/out (job_items store wire)
  enqueueBulkFinds(tenantId: TenantId, requestId: RequestId, idempotencyKey: string, rows: Array<{ first_name: string; last_name: string; domain: string }>): Promise<BulkAccepted>;
  enqueueBulkVerifications(tenantId: TenantId, requestId: RequestId, idempotencyKey: string, emails: string[]): Promise<BulkAccepted>;
  enqueueVerification(tenantId: TenantId, email: string, requestId: RequestId): Promise<{ jobId: JobId }>;
  getJob(tenantId: TenantId, jobId: JobId): Promise<BulkJobStatus | null>;
  getJobResults(tenantId: TenantId, jobId: JobId, limit: number, offset: number): Promise<{ rows: Array<BulkFinderRow | BulkVerifierRow>; total: number; nextOffset: number | null } | null>;
  getVerification(tenantId: TenantId, jobId: JobId): Promise<{ kind: 'done'; result: VerifierResult } | { kind: 'pending' } | { kind: 'failed' } | null>;   // WIRE VerifierResult (fixes internal-vs-wire major)
}
export interface ScoringConfigLoader { current(): Promise<ScoringConfig>; }   // budgets read from .caps
export interface EmailPort { sendSignupConfirmation(email: string, token: string): Promise<void>; sendObjectionConfirmation(email: string, token: string): Promise<void>; }
export interface ComplianceIntakePort {
  createSignup(email: string, clientIp: string): Promise<{ token: string } | { blocked: 'disposable' } | { rateLimited: true }>;
  createObjection(email: string): Promise<{ token: string }>;   // constant-shaped ack regardless
  dsarExport(tenantId: TenantId, email: string): Promise<unknown[]>;
  dsarDelete(tenantId: TenantId, email: string): Promise<void>;
  healthPing(): Promise<boolean>;
}
export interface ApiDeps {
  config: ApiConfig; auth: KeyAuthenticator; rateLimiter: RateLimiterPort; idempotency: IdempotencyApiPort;
  ledger: LedgerApiPort; account: AccountPort; jobs: JobsApiPort; pipeline: Pipeline;
  scoring: ScoringConfigLoader; email: EmailPort; compliance: ComplianceIntakePort; sandbox: SandboxRouter;
  core: { normalizeName: typeof normalizeName; classifyDomainInput: typeof classifyDomainInput; nicknameMap: NicknameMap; classificationTables: ClassificationTables };   // api canonicalizes inputs before pipeline.find
}

// ── request context, endpoints, envelope, headers, errors ──
export const ENDPOINT_IDS = ['email_finder','email_verifier','verifications_get','bulk_finds','bulk_verifications','bulk_status','bulk_results','account','usage','signup','objections','data_subjects_export','data_subjects_delete','openapi','healthz'] as const;
export type EndpointId = typeof ENDPOINT_IDS[number];
export type KeyPresentation = 'bearer' | 'query_param' | 'none';
export interface RequestContext { requestId: RequestId; principal: AuthPrincipal | null; keyPresentation: KeyPresentation; isSandbox: boolean; rateLimit: RateLimiterPort extends never ? never : { limit: number; remaining: number; resetEpochSeconds: number; exceeded: boolean } | null; creditsRemaining: number | null; billing: { billed: boolean } | null; billedApplied: boolean; startedAtMs: number; }
export function makeMeta(requestId: RequestId, pagination?: { total: number; nextOffset: number | null }): Meta;
export function successEnvelope<T>(data: T, meta: Meta): SuccessEnvelope<T>;
export function errorEnvelope(errors: ApiError[]): ErrorEnvelope;
export function apiError(code: ErrorCode, details: string, id?: string): ApiError;
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>>;   // exhaustive; job_pending:202 idempotency_conflict:409 payload_too_large:413 ...
export class ApiException extends Error { readonly code: ErrorCode; readonly httpStatus: number; readonly details: string; readonly retryAfterSeconds?: number; readonly locationHeader?: string; toEnvelope(): ErrorEnvelope; }
export const HEADER: { readonly requestId:'X-Request-Id'; readonly billed:'X-Billed'; readonly creditsRemaining:'X-Credits-Remaining'; readonly rlLimit:'X-RateLimit-Limit'; readonly rlRemaining:'X-RateLimit-Remaining'; readonly rlReset:'X-RateLimit-Reset'; readonly location:'Location'; readonly retryAfter:'Retry-After'; readonly deprecation:'Deprecation'; };
export function applyStandardHeaders(reply: FastifyReply, ctx: RequestContext): void;

// ── billing settle (api side; uses decideBilling from db) ──
/** Always recordAttempt; if decideBilling(...).billable → recordBillable + tryDebitCredit; stash
 *  creditsRemaining before reply.send; exactly-once via ctx.billedApplied. NO local billing predicate. */
export function settleBilling(deps: ApiDeps, ctx: RequestContext, endpoint: EndpointId, result: InternalFinderResult | InternalVerifierResult, billingInput: BillingInput): Promise<void>;

// ── sandbox, schemas, openapi, routes, server ──
export interface FixtureCase { name: string; endpoint: EndpointId; match: { query?: Record<string,string>; email?: string; domain?: string; firstName?: string; lastName?: string }; outcome: { kind:'finder'; result: FinderResult } | { kind:'verifier'; result: VerifierResult } | { kind:'async_202'; jobId: JobId } | { kind:'error'; error: ApiException }; }
export const FIXTURES: readonly FixtureCase[];
export const FIXTURE_STATUS_COVERAGE: Readonly<Record<Status, boolean>>;   // must be all-true (contract test)
export interface SandboxRouter { resolve(endpoint: EndpointId, req: FastifyRequest): FixtureCase['outcome'] | null; }
export function enumSchema<T extends readonly string[]>(xs: T): { type:'string'; enum: string[] };
export const SHARED_SCHEMAS: Record<string, object>;
export function registerSchemas(app: FastifyInstance): void;
export const OPENAPI_DOCUMENT: Readonly<Record<string, unknown>>;
export function validateResponseAgainstSpec(operationId: EndpointId, httpStatus: number, payload: unknown): { valid: boolean; errors: string[] };
export function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void>;
export function buildServer(deps: ApiDeps): Promise<FastifyInstance>;
export function main(): Promise<void>;   // composition root
```

**Hook chain (fixed):** `onRequest` request-id → auth · `preHandler` getIdempotency → rateLimit (bulk POST
uses postIdempotency) · handler (settleBilling inside) · `onSend` applyStandardHeaders (success AND error).

---

## 9. `@mailmetero/worker` (imports contracts, config, core, db, dns, verifier, pipeline)

Worker uses `Pipeline.find/verify` + `decideBilling` (db) + `toFinderResult/toVerifierResult` (pipeline).
No separate runner interface.

```ts
import type { Logger } from '@mailmetero/config';   // the ONE Logger
export interface WorkerConfig { workerId: string; batchSize: number; idleBackoffMinMs: number; idleBackoffMaxMs: number; visibilityMs: number; heartbeatMs: number; maxAttempts: number; itemConcurrency: number; shutdownGraceMs: number; }
export interface WorkerDeps { pools: DbPools; jobs: JobsRepo; ledger: LedgerRepo; results: ResultsRepo; tenants: TenantsRepo; pipeline: Pipeline; billingCaps: HardCaps; logger: Logger; }
export interface JobProcessor { readonly kind: JobKind; process(job: JobRow, deps: WorkerDeps, signal: AbortSignal): Promise<void>; }
export const PROCESSORS: Readonly<Record<JobKind, JobProcessor>>;
/** per item: requestId = `${job.requestId}:${rowIndex}`; pipeline.find/verify → decideBilling → tx(ResultsRepo.insert + LedgerRepo.recordAttempt[+debit]) → toWire → JobsRepo.recordItemResult(itemId, wire, resultId). */
export function runWorkerLoop(cfg: WorkerConfig, deps: WorkerDeps, signal: AbortSignal): Promise<void>;   // claim==0 ⇒ sleep random [min,max]; unpooled pool
export function loadWorkerConfig(env: Env): WorkerConfig;
export function buildWorkerDeps(boot: BootContext): Promise<WorkerDeps>;
export function bootstrapWorker(): Promise<void>;   // wires pools+repos+pipeline; SIGTERM/SIGINT → AbortController
```

---

## 10. `@mailmetero/cron` (imports contracts, config, db, dns, email, pipeline)

```ts
import type { Logger } from '@mailmetero/config';
export interface CronJobContext { now: Date; logger: Logger; deps: CronDeps; }
export interface CronDeps { pools: DbPools; results: ResultsRepo; ledger: LedgerRepo; jobs: JobsRepo; tenants: TenantsRepo; objections: ObjectionsRepo; idempotency: IdempotencyRepo; email: EmailBackend; vendorDir: string; }
export interface CronJobReport { job: string; ok: boolean; durationMs: number; metrics: Record<string, number>; error?: string; }
export interface CronJob { readonly name: CronJobName; run(ctx: CronJobContext): Promise<CronJobReport>; }
export type CronJobName = 'ttl-purge' | 'stuck-job-sweep' | 'quota-spend-reset' | 'credit-back-sweep' | 'quota-alert' | 'blocklist-sync' | 'objection-expiry';   // ALL 7 have a render.yaml service
export function runCron(name: CronJobName): Promise<CronJobReport>;   // dispatcher; exits non-zero on failure
```

Job behaviors: `ttl-purge` (batched DELETE results past `expires_at`, null `usage_ledger.result_id`,
ASSERT zero overdue — Success Metric 10) · `stuck-job-sweep` (`JobsRepo.sweepStuck`) · `quota-spend-reset`
(`TenantsRepo.resetQuotas` + prune `ops.verifier_spend`) · `credit-back-sweep`
(`LedgerRepo.findCreditBackCandidates(30)` → `issueCreditBack`) · `quota-alert`
(`LedgerRepo.getPeriodBillable` vs `Tenant` → `buildQuotaAlertEmail`) · `blocklist-sync`
(`refreshClassificationTables(q, vendorDir)` — **no egress**) · `objection-expiry`
(`ObjectionsRepo.expireStale`).

---

## 11. Cross-package type-ownership summary (who declares what — no duplicates)

| Type | Declared in | Imported by |
|---|---|---|
| All enums/registries/branded/wire/`ScoringConfig`/`BillingInput`/`DomainPatternObservation`/`JobKind`/`JobItemStatus` | `contracts` | everyone |
| `AppConfig`/`DatabaseConfig`/`ApiConfig`/`Logger`/`EgressFetch`/`Env` | `config` | db, api, worker, cron, dns, verifier, email |
| `decideBilling`/`BillingDecision`/all repos/all row types/`KeyAuthenticator`/pools | `db` | api, worker, cron, pipeline(ports only via interfaces) |
| `Pipeline`/`FinderRequest`/`InternalFinderResult`/`PipelineFinderOutput`/wire mapper | `pipeline` | api, worker |
| `DnsResolver`/`MxResolution`/`FingerprintRule` | `dns` | pipeline, api, worker, cron |
| `VerifierBackend` impls/`CatchAllProbe`/`classifySmtpCode` | `verifier` | pipeline, api, worker |
| `EmailBackend`/templates | `email` | api, cron |
| `ApiDeps`/`EndpointId`/`SandboxRouter`/`OPENAPI_DOCUMENT` | `api` | api only |
