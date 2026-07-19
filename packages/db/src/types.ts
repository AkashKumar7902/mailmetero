// @mailmetero/db — camelCase row types (the pinned column contracts).
//
// These are the INTERNAL (camelCase) projections of every Postgres table @mailmetero/db
// owns. Wire shapes are never re-declared here — cross-package wire types are imported
// from '@mailmetero/contracts'. Row mappers (snake_case column → camelCase field) live
// with each repository.

import type {
  TenantId, RequestId, JobId, IsoTimestamp,
  Domain, EmailAddress, LocalPart, PatternToken, SuppressionHash,
  Status, SubStatus, ReasonCode, Provider, Backend, EvidenceTier,
  MxEnum, VerifiabilityClass, SizeBracket,
  JobKind, JobItemStatus, JobStatus,
  WireCandidate, FinderResult, VerifierResult, ErrorEnvelope,
} from '@mailmetero/contracts';

// ── small string enums pinned to CHECK constraints ──────────────────────────
export type Environment = 'live' | 'test';
export type ResultEndpoint = 'finder' | 'verifier';
export type SuppressionScope = 'address' | 'domain';
export type ObjectionScope = 'address' | 'address_and_domain';
export type ObjectionStatus = 'pending' | 'confirmed' | 'expired' | 'revoked' | 'manual_review';
export type LedgerKind = 'attempt' | 'credit_back';
export type LedgerEndpoint = 'finder' | 'verifier';

/** PINNED tenants contract. billing/spend read credits_remaining,
 *  daily_verifier_spend_cap_cents, quota_period_start. */
export interface Tenant {
  id: TenantId;
  ownerEmail: string;
  planName: string;
  retentionDays: number;
  searchQuota: number;
  verifyQuota: number;
  creditsRemaining: number;
  dailyVerifierSpendCapCents: number;
  quotaPeriodStart: IsoTimestamp;
  status: 'active' | 'suspended';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ApiKeyRow {
  id: string;
  tenantId: TenantId;
  keyPrefix: string;
  keyHashHex: string;
  environment: Environment;
  scopes: string[];
  label: string | null;
  createdAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
  lastUsedAt: IsoTimestamp | null;
}

export interface ResultRow {
  id: string;
  tenantId: TenantId;
  requestId: RequestId;
  endpoint: ResultEndpoint;
  requestHash: string;
  inputFirstName: string | null;
  inputLastName: string | null;
  inputMiddleName: string | null;
  inputFullName: string | null;
  inputDomain: Domain | null;
  inputEmail: EmailAddress | null;
  email: EmailAddress | null;
  status: Status;
  subStatus: SubStatus | null;
  score: number;
  reasonCodes: ReasonCode[];
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  collisionRisk: boolean;
  acceptAll: boolean | null;
  disposable: boolean | null;
  webmail: boolean | null;
  mxRecords: boolean | null;
  smtpCheck: boolean | null;
  rawSmtpCode: string | null;
  enhancedCode: string | null;
  candidates: WireCandidate[];
  source: 'derivation';
  billed: boolean;
  verifiedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
}

export interface UsageLedgerRow {
  id: string;
  tenantId: TenantId;
  requestId: RequestId;
  kind: LedgerKind;
  endpoint: LedgerEndpoint;
  billable: boolean;
  creditsDelta: number;
  resultStatus: Status | null;
  resultSubStatus: SubStatus | null;
  resultScore: number | null;
  backend: Backend | null;
  evidence: EvidenceTier | null;
  billedReason: string | null;
  resultId: string | null;
  originalLedgerId: string | null;
  downgradeReason: string | null;
  occurredOn: string;
  createdAt: IsoTimestamp;
}

export interface JobRow {
  id: JobId;
  tenantId: TenantId;
  kind: JobKind;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  attempts: number;
  maxAttempts: number;
  priority: number;
  runAfter: IsoTimestamp;
  lockedBy: string | null;
  lockedAt: IsoTimestamp | null;
  visibilityDeadline: IsoTimestamp | null;
  idempotencyKey: string | null;
  requestId: RequestId;
  lastError: string | null;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
}

export interface JobItemRow {
  id: string;
  jobId: JobId;
  tenantId: TenantId;
  rowIndex: number;
  requestId: RequestId;
  input: unknown;
  status: JobItemStatus;
  result: FinderResult | VerifierResult | ErrorEnvelope | null;
  resultId: string | null;
  error: unknown | null;
  processedAt: IsoTimestamp | null;
}

export interface IdempotencyRow {
  id: string;
  tenantId: TenantId;
  scope: 'header' | 'request_hash';
  idempotencyKey: string | null;
  endpoint: string;
  requestHash: string;
  responseRef: unknown | null;
  statusCode: number | null;
  expiresAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export interface VerifierSpendRow {
  scopeTenantId: TenantId | null; // NULL = global aggregate
  spendDate: string;
  spendCents: number;
  updatedAt: IsoTimestamp;
}

export interface SuppressionRow {
  hash: SuppressionHash;
  scope: SuppressionScope;
  createdAt: IsoTimestamp;
}

export interface ObjectionRow {
  id: string;
  tokenHash: string;
  subjectSuppressionHash: SuppressionHash;
  domainSuppressionHash: SuppressionHash | null;
  scope: ObjectionScope;
  status: ObjectionStatus;
  requestIpHash: string | null;
  expiresAt: IsoTimestamp;
  confirmedAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

// ── kb rows (NO person columns — CI-enforced, D7) ───────────────────────────
export interface KbDomainRow {
  domain: Domain;
  mxEnum: MxEnum | null;
  provider: Provider | null;
  verifiabilityClass: VerifiabilityClass | null;
  isCatchAll: boolean | null;
  hasSpf: boolean | null;
  hasDmarc: boolean | null;
  sizeBracket: SizeBracket | null;
  mxHosts: string[];
  observedCount: number;
  lastProbedAt: IsoTimestamp | null;
  expiresAt: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface KbDomainPatternRow {
  id: string;
  domain: Domain;
  patternToken: PatternToken;
  observedCount: number;
  verifiedCount: number;
  winningFold: string | null;
  lastSeenAt: IsoTimestamp;
  createdAt: IsoTimestamp;
}

export interface KbProviderFingerprintRow {
  id: number;
  mxSuffix: string;
  provider: Provider;
  verifiabilityClass: VerifiabilityClass;
  priority: number;
  notes: string | null;
}

export interface KbPatternPriorRow {
  sizeBracket: SizeBracket;
  patternToken: PatternToken;
  share: number;
  rank: number;
}

export interface KbTypoDomainRow {
  typo: string;
  correction: Domain;
}

export interface KbRoleLocalRow {
  localPart: LocalPart;
  rfc2142: boolean;
}

export interface UsageAggregate {
  creditsUsed: number;
  creditsRemaining: number;
  attempts: number;
  billable: number;
  creditBacks: number;
  byDay: Array<{ date: string; attempts: number; billable: number; creditBacks: number }>;
}
