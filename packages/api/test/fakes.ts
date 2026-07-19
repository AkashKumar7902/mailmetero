// In-memory fake ApiDeps for route tests — no DB, no network, deterministic.

import {
  DEFAULT_SCORING_CONFIG,
  type TenantId,
  type EmailAddress,
  type Domain,
  type JobId,
  type VerificationEvidence,
  type AccountInfo,
  type UsageInfo,
  type VerifierResult,
} from '@mailmetero/contracts';
import { normalizeName, classifyDomainInput, ROLE_LOCALS_BUILTIN } from '@mailmetero/core';
import type {
  InternalFinderResult,
  InternalVerifierResult,
  FinderRequest,
  VerifierRequest,
} from '@mailmetero/pipeline';
import type { ApiDeps, AuthPrincipal, StoredResponse } from '../src/deps.ts';
import type { EndpointId } from '../src/types.ts';
import { createSandboxRouter } from '../src/sandbox/router.ts';

const LIVE_PRINCIPAL: AuthPrincipal = {
  tenantId: 't-live' as TenantId,
  keyId: 'key-live',
  keyPrefix: 'sk_live_00000000',
  environment: 'live',
  scopes: [],
  planName: 'free',
};
const TEST_PRINCIPAL: AuthPrincipal = {
  ...LIVE_PRINCIPAL,
  tenantId: 't-test' as TenantId,
  keyId: 'key-test',
  keyPrefix: 'sk_test_00000000',
  environment: 'test',
};

const EVIDENCE: VerificationEvidence = {
  tier: 'verified',
  backend: 'api',
  producedByStage: 'score_and_writeback',
  mx: 'EXPLICIT_MX',
  provider: 'google_workspace',
  verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
  isCatchAll: false,
  rawSmtpCode: null,
  enhancedCode: null,
  capsApplied: [],
  verifiedAt: '2026-07-19T00:00:00.000Z' as VerificationEvidence['verifiedAt'],
  stale: false,
};

// Canonical not-found / suppressed evidence (mirrors pipeline stage.ts baseEvidence + degraded tier).
const DEGRADED_EVIDENCE: VerificationEvidence = {
  tier: 'degraded',
  backend: 'none',
  producedByStage: 'score_and_writeback',
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

/** The canonical not-found finder shape a suppressed subject collapses into (email null). */
function notFoundFinderResult(req: FinderRequest): InternalFinderResult {
  return {
    email: null,
    score: 0,
    status: 'unknown',
    subStatus: 'backend_unavailable',
    domain: req.domain.domain,
    firstName: req.name.normalized.firstName ?? null,
    lastName: req.name.normalized.lastName ?? null,
    reasonCodes: ['backend_degraded'],
    provider: null,
    backend: 'none',
    evidence: 'degraded',
    collisionRisk: false,
    chosen: null,
    candidates: [],
    verification: DEGRADED_EVIDENCE,
  };
}

/** The canonical not-found verifier shape a suppressed address collapses into. */
function notFoundVerifierResult(req: VerifierRequest): InternalVerifierResult {
  return {
    email: req.email,
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
    verification: DEGRADED_EVIDENCE,
  };
}

function finderResult(req: FinderRequest): InternalFinderResult {
  const first = req.name.normalized.firstName ?? 'jane';
  const last = req.name.normalized.lastName ?? 'doe';
  const email = `${first}.${last}@${req.domain.domain}` as EmailAddress;
  return {
    email,
    score: 96,
    status: 'valid',
    subStatus: 'ok',
    domain: req.domain.domain,
    firstName: first,
    lastName: last,
    reasonCodes: ['pattern_learned_domain', 'verifier_confirmed_valid'],
    provider: 'google_workspace',
    backend: 'api',
    evidence: 'verified',
    collisionRisk: false,
    chosen: null,
    candidates: [],
    verification: EVIDENCE,
  };
}

function verifierResult(req: VerifierRequest): InternalVerifierResult {
  return {
    email: req.email,
    status: 'valid',
    score: 97,
    subStatus: 'ok',
    acceptAll: false,
    disposable: false,
    webmail: false,
    mxRecords: true,
    smtpCheck: true,
    reasonCodes: ['verifier_confirmed_valid'],
    provider: 'google_workspace',
    backend: 'api',
    evidence: 'verified',
    rawSmtpCode: null,
    verification: EVIDENCE,
  };
}

const SAMPLE_VERIFIER_WIRE: VerifierResult = {
  email: 'done@example.com',
  status: 'valid',
  score: 97,
  accept_all: false,
  disposable: false,
  webmail: false,
  mx_records: true,
  smtp_check: true,
  sub_status: 'ok',
  reason_codes: ['verifier_confirmed_valid'],
  provider: 'google_workspace',
  backend: 'api',
  evidence: 'verified',
  raw_smtp_code: null,
  verified_at: '2026-07-19T00:00:00.000Z',
};

export interface FakeOptions {
  deferVerify?: boolean;
  jobDone?: boolean;
}

export function buildFakeDeps(opts: FakeOptions = {}): ApiDeps {
  const getStore = new Map<string, StoredResponse>();
  const postStore = new Map<string, StoredResponse>();

  // Objection → confirm → suppression state, modeling the real hash-only intake (B1). A confirmed
  // objection adds the address to `suppressed`; the fake pipeline then collapses any find/verify for
  // that address into the canonical not-found shape — exactly as the real SuppressionRepo path does.
  const suppressed = new Set<string>();
  const pendingObjections = new Map<string, { email: string; confirmed: boolean }>();
  const objectionToken = (email: string) => `obj-token:${email.toLowerCase()}`;

  const account: AccountInfo = {
    email: 'owner@example.com',
    plan_name: 'free',
    requests: { searches: { used: 1, available: 50 }, verifications: { used: 0, available: 50 } },
    reset_date: '2026-08-19T00:00:00.000Z',
  };
  const usage: UsageInfo = {
    credits_used: 1,
    credits_remaining: 49,
    attempts: 1,
    billable: 1,
    credit_backs: 0,
    by_day: [],
  };

  return {
    config: {
      port: 0,
      bodyLimitBytes: 1_500_000,
      bulkMaxRows: 1000,
      jobPendingRetryAfterSeconds: 2,
      trustProxy: true,
      openApiVersion: '1.0.0',
    },
    auth: {
      authenticate: async (raw: string) => {
        if (raw.startsWith('sk_live_')) return LIVE_PRINCIPAL;
        if (raw.startsWith('sk_test_')) return TEST_PRINCIPAL;
        return null;
      },
    },
    scoring: { current: async () => DEFAULT_SCORING_CONFIG },
    rateLimiter: {
      consumeAttempt: async () => ({
        limit: 120,
        remaining: 119,
        resetEpochSeconds: Math.floor(Date.now() / 1000) + 60,
        exceeded: false,
      }),
      peek: async () => ({
        limit: 120,
        remaining: 120,
        resetEpochSeconds: Math.floor(Date.now() / 1000) + 60,
      }),
    },
    ledger: {
      settle: async () => ({ billed: true, creditsRemaining: 49, resultId: 'res-1' }),
      creditsRemaining: async () => 49,
    },
    idempotency: {
      reservePost: async ({ tenantId, endpoint, idempotencyKey }) => {
        const key = `${tenantId}:${endpoint}:${idempotencyKey}`;
        const stored = postStore.get(key);
        return stored ? { kind: 'replay', stored } : { kind: 'fresh' };
      },
      finalizePost: async ({ tenantId, endpoint, idempotencyKey, stored }) => {
        postStore.set(`${tenantId}:${endpoint}:${idempotencyKey}`, stored);
      },
      lookupGet: async (tenantId, requestHash, endpoint) => getStore.get(`${tenantId}:${endpoint}:${requestHash}`) ?? null,
      recordGet: async (tenantId, requestHash, endpoint, resp) => {
        getStore.set(`${tenantId}:${endpoint}:${requestHash}`, resp);
      },
    },
    account: {
      getAccount: async () => account,
      getUsage: async () => usage,
    },
    jobs: {
      enqueueBulkFinds: async (_t, _r, _k, rows) => ({ job_id: 'job-1' as JobId, status: 'queued', count: rows.length }),
      enqueueBulkVerifications: async (_t, _r, _k, emails) => ({ job_id: 'job-2' as JobId, status: 'queued', count: emails.length }),
      enqueueVerification: async () => ({ jobId: 'job-async' as JobId }),
      getJob: async () => ({ status: 'running', total: 2, done: 1, failed: 0, created_at: '2026-07-19T00:00:00.000Z', finished_at: null }),
      getJobResults: async () => ({ rows: [], total: 0, nextOffset: null }),
      getVerification: async () => (opts.jobDone === false ? { kind: 'pending' } : { kind: 'done', result: SAMPLE_VERIFIER_WIRE }),
    },
    email: {
      sendSignupConfirmation: async () => {},
      sendObjectionConfirmation: async () => {},
    },
    compliance: {
      createSignup: async (email: string, _clientIp: string) =>
        email.includes('mailinator.com') ? { blocked: 'disposable' } : { token: 'signup-token' },
      createObjection: async (email: string, _clientIp: string) => {
        const token = objectionToken(email);
        pendingObjections.set(token, { email: email.toLowerCase(), confirmed: false });
        return { token };
      },
      confirmObjection: async (token: string) => {
        const rec = pendingObjections.get(token);
        if (rec === undefined) return { kind: 'not_found' as const };
        if (rec.confirmed) return { kind: 'already_confirmed' as const };
        rec.confirmed = true;
        suppressed.add(rec.email);
        return { kind: 'confirmed' as const };
      },
      dsarExport: async () => [{ email: 'x@example.com' }],
      dsarDelete: async () => {},
      healthPing: async () => true,
    },
    sandbox: createSandboxRouter(),
    pipeline: {
      find: async (req: FinderRequest) => {
        const first = req.name.normalized.firstName ?? 'jane';
        const last = req.name.normalized.lastName ?? 'doe';
        const derived = `${first}.${last}@${req.domain.domain}`.toLowerCase();
        if (suppressed.has(derived)) {
          return {
            kind: 'ok',
            result: notFoundFinderResult(req),
            billingInput: { endpoint: 'finder', status: 'unknown', subStatus: 'backend_unavailable', score: 0, backend: 'none', evidence: 'degraded', hasEmail: false },
            deferrable: false,
          };
        }
        return {
          kind: 'ok',
          result: finderResult(req),
          billingInput: { endpoint: 'finder', status: 'valid', subStatus: 'ok', score: 96, backend: 'api', evidence: 'verified', hasEmail: true },
          deferrable: false,
        };
      },
      verify: async (req: VerifierRequest) => {
        if (opts.deferVerify) return { kind: 'deferred' };
        if (suppressed.has(req.email.toLowerCase())) {
          return {
            kind: 'ok',
            result: notFoundVerifierResult(req),
            billingInput: { endpoint: 'verifier', status: 'unknown', subStatus: 'backend_unavailable', score: 0, backend: 'none', evidence: 'degraded', hasEmail: false },
          };
        }
        return {
          kind: 'ok',
          result: verifierResult(req),
          billingInput: { endpoint: 'verifier', status: 'valid', subStatus: 'ok', score: 97, backend: 'api', evidence: 'verified', hasEmail: true },
        };
      },
    },
    core: {
      normalizeName,
      classifyDomainInput,
      nicknameMap: { forward: new Map<string, readonly string[]>(), reverse: new Map<string, readonly string[]>() },
      classificationTables: {
        freemail: new Set<string>(),
        disposable: new Set<string>(['mailinator.com']),
        roleLocals: ROLE_LOCALS_BUILTIN,
        typoDomains: new Map<string, Domain>(),
      },
    },
  };
}

export const KEYS = {
  live: 'sk_live_00000000deadbeef',
  test: 'sk_test_00000000deadbeef',
} as const;

export const ENDPOINTS: readonly EndpointId[] = ['email_finder', 'email_verifier'];
