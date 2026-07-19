// @mailmetero/api — the ports the Fastify service consumes (MODULE_CONTRACTS §8).
//
// api re-declares NO pipeline result type: it imports the canonical InternalFinderResult /
// InternalVerifierResult and the Pipeline from `@mailmetero/pipeline`, the wire shapes from
// `@mailmetero/contracts`, and `decideBilling`/`KeyAuthenticator` from `@mailmetero/db`. These
// port interfaces are the seam the route handlers call; `buildApiDeps` (adapters.ts) wires the
// real db/email/pipeline implementations, and the route tests inject fakes matching these shapes.

import type {
  TenantId,
  RequestId,
  JobId,
  IsoTimestamp,
  BillingInput,
  ScoringConfig,
  AccountInfo,
  UsageInfo,
  BulkAccepted,
  BulkJobStatus,
  BulkFinderRow,
  BulkVerifierRow,
  VerifierResult,
} from '@mailmetero/contracts';
import type { ApiConfig } from '@mailmetero/config';
import type { KeyAuthenticator } from '@mailmetero/db';
import type {
  Pipeline,
  InternalFinderResult,
  InternalVerifierResult,
} from '@mailmetero/pipeline';
import type {
  normalizeName,
  classifyDomainInput,
  NicknameMap,
  ClassificationTables,
} from '@mailmetero/core';
import type { EndpointId } from './types.ts';
import type { SandboxRouter } from './sandbox/router.ts';

/** The authenticated caller, resolved by the auth hook from a Bearer/api_key credential. */
export interface AuthPrincipal {
  tenantId: TenantId;
  keyId: string;
  keyPrefix: string;
  environment: 'live' | 'test';
  scopes: string[];
  planName: string;
}

/** Attempt-level rate limiter (D12). One atomic counter increment per billable attempt. */
export interface RateLimiterPort {
  consumeAttempt(
    principal: AuthPrincipal,
    now: IsoTimestamp,
  ): Promise<{ limit: number; remaining: number; resetEpochSeconds: number; exceeded: boolean }>;
  /**
   * Read-only snapshot of the current window — NEVER increments the counter. Used to populate the
   * X-RateLimit-* triple on responses that did not consume an attempt (M6). A null principal returns
   * the unauthenticated bucket, so the triple can still be emitted on a 401.
   */
  peek(
    principal: AuthPrincipal | null,
    now: IsoTimestamp,
  ): Promise<{ limit: number; remaining: number; resetEpochSeconds: number }>;
}

/** Thin api view over db LedgerRepo + TenantsRepo: records the attempt + conditional debit atomically. */
export interface LedgerApiPort {
  settle(input: {
    principal: AuthPrincipal;
    requestId: RequestId;
    endpoint: EndpointId;
    result: InternalFinderResult | InternalVerifierResult;
    billingInput: BillingInput;
  }): Promise<{ billed: boolean; creditsRemaining: number; resultId: string | null }>;
  creditsRemaining(tenantId: TenantId): Promise<number>;
}

/** A stored (idempotent) HTTP response — the unit of GET 24h dedupe + POST header idempotency. */
export interface StoredResponse {
  httpStatus: number;
  body: unknown;
  billed: boolean;
  locationHeader?: string;
}

export interface IdempotencyApiPort {
  reservePost(a: {
    tenantId: TenantId;
    idempotencyKey: string;
    endpoint: EndpointId;
    requestHash: string;
  }): Promise<{ kind: 'fresh' } | { kind: 'replay'; stored: StoredResponse } | { kind: 'conflict' }>;
  finalizePost(a: {
    tenantId: TenantId;
    idempotencyKey: string;
    endpoint: EndpointId;
    stored: StoredResponse;
  }): Promise<void>;
  lookupGet(tenantId: TenantId, requestHash: string, endpoint: EndpointId): Promise<StoredResponse | null>;
  recordGet(tenantId: TenantId, requestHash: string, endpoint: EndpointId, resp: StoredResponse): Promise<void>;
}

export interface AccountPort {
  getAccount(tenantId: TenantId): Promise<AccountInfo>;
  getUsage(tenantId: TenantId, from?: string, to?: string): Promise<UsageInfo>;
}

/** WIRE in/out — job_items store wire shapes, so the api never re-maps them on read. */
export interface JobsApiPort {
  enqueueBulkFinds(
    tenantId: TenantId,
    requestId: RequestId,
    idempotencyKey: string,
    rows: Array<{ first_name: string; last_name: string; domain: string }>,
  ): Promise<BulkAccepted>;
  enqueueBulkVerifications(
    tenantId: TenantId,
    requestId: RequestId,
    idempotencyKey: string,
    emails: string[],
  ): Promise<BulkAccepted>;
  enqueueVerification(tenantId: TenantId, email: string, requestId: RequestId): Promise<{ jobId: JobId }>;
  getJob(tenantId: TenantId, jobId: JobId): Promise<BulkJobStatus | null>;
  getJobResults(
    tenantId: TenantId,
    jobId: JobId,
    limit: number,
    offset: number,
  ): Promise<{ rows: Array<BulkFinderRow | BulkVerifierRow>; total: number; nextOffset: number | null } | null>;
  getVerification(
    tenantId: TenantId,
    jobId: JobId,
  ): Promise<{ kind: 'done'; result: VerifierResult } | { kind: 'pending' } | { kind: 'failed' } | null>;
}

/** Budgets are read from `.caps` (DB-tunable), never from ApiConfig. */
export interface ScoringConfigLoader {
  current(): Promise<ScoringConfig>;
}

export interface EmailPort {
  sendSignupConfirmation(email: string, token: string): Promise<void>;
  sendObjectionConfirmation(email: string, token: string): Promise<void>;
}

/** Compliance intake: signup, public objection, and tenant-scoped DSAR. Constant-shaped acks. */
export interface ComplianceIntakePort {
  createSignup(
    email: string,
    clientIp: string,
  ): Promise<{ token: string } | { blocked: 'disposable' } | { rateLimited: true }>;
  createObjection(email: string, clientIp: string): Promise<{ token: string } | { rateLimited: true }>;
  /** Verify an emailed objection token; writes global suppression atomically on first confirm (B1). */
  confirmObjection(
    token: string,
  ): Promise<{ kind: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' }>;
  dsarExport(tenantId: TenantId, email: string): Promise<unknown[]>;
  dsarDelete(tenantId: TenantId, email: string): Promise<void>;
  healthPing(): Promise<boolean>;
}

/** Core canonicalizers the api runs BEFORE `pipeline.find` (name normalization + domain classify). */
export interface CoreDeps {
  normalizeName: typeof normalizeName;
  classifyDomainInput: typeof classifyDomainInput;
  nicknameMap: NicknameMap;
  classificationTables: ClassificationTables;
}

/** Everything the Fastify server needs, injected once at boot (or faked in tests). */
export interface ApiDeps {
  config: ApiConfig;
  auth: KeyAuthenticator;
  rateLimiter: RateLimiterPort;
  idempotency: IdempotencyApiPort;
  ledger: LedgerApiPort;
  account: AccountPort;
  jobs: JobsApiPort;
  pipeline: Pipeline;
  scoring: ScoringConfigLoader;
  email: EmailPort;
  compliance: ComplianceIntakePort;
  sandbox: SandboxRouter;
  core: CoreDeps;
  /** Internal tenant that backs the public, no-key web finder page (`/` + `/app/find`). */
  webTenantId: TenantId;
}
