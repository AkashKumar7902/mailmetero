// @mailmetero/api — the sandbox fixture catalog.
//
// `sk_test_…` keys resolve to these deterministic fixtures at ZERO credits (never bill, never
// touch the pipeline). The catalog covers EVERY Status, the 202 async path, and the error codes —
// so integrators can exercise the whole taxonomy without spending credits. A contract test asserts
// `FIXTURE_STATUS_COVERAGE` is all-true.

import type {
  Status,
  FinderResult,
  VerifierResult,
  JobId,
  SubStatus,
  ReasonCode,
  Provider,
  Backend,
  EvidenceTier,
} from '@mailmetero/contracts';
import { STATUSES } from '@mailmetero/contracts';
import type { EndpointId } from '../types.ts';
import { ApiException, errors } from '../errors.ts';

export interface FixtureCase {
  name: string;
  endpoint: EndpointId;
  match: { query?: Record<string, string>; email?: string; domain?: string; firstName?: string; lastName?: string };
  outcome:
    | { kind: 'finder'; result: FinderResult }
    | { kind: 'verifier'; result: VerifierResult }
    | { kind: 'async_202'; jobId: JobId }
    | { kind: 'error'; error: ApiException };
}

interface VerifierSpec {
  status: Status;
  subStatus: SubStatus | null;
  reasonCodes: ReasonCode[];
  score: number;
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  acceptAll?: boolean;
  disposable?: boolean;
  webmail?: boolean;
  mxRecords?: boolean;
  smtpCheck?: boolean;
  rawSmtpCode?: string | null;
}

function verifier(email: string, s: VerifierSpec): VerifierResult {
  return {
    email,
    status: s.status,
    score: s.score,
    accept_all: s.acceptAll ?? false,
    disposable: s.disposable ?? false,
    webmail: s.webmail ?? false,
    mx_records: s.mxRecords ?? true,
    smtp_check: s.smtpCheck ?? false,
    sub_status: s.subStatus,
    reason_codes: s.reasonCodes,
    provider: s.provider,
    backend: s.backend,
    evidence: s.evidence,
    raw_smtp_code: s.rawSmtpCode ?? null,
    verified_at: '2026-07-19T00:00:00.000Z',
  };
}

function finder(
  email: string | null,
  domain: string,
  s: VerifierSpec & { firstName: string; lastName: string; collisionRisk?: boolean },
): FinderResult {
  return {
    email,
    score: s.score,
    status: s.status,
    domain,
    first_name: s.firstName,
    last_name: s.lastName,
    sources: ['derivation'],
    verification: { status: s.status, date: '2026-07-19T00:00:00.000Z' },
    sub_status: s.subStatus,
    reason_codes: s.reasonCodes,
    provider: s.provider,
    backend: s.backend,
    evidence: s.evidence,
    collision_risk: s.collisionRisk ?? false,
    candidates: email !== null ? [{ email, score: s.score, reason_codes: s.reasonCodes }] : [],
    verified_at: '2026-07-19T00:00:00.000Z',
    stale: false,
  };
}

const SANDBOX_JOB_ID = '00000000-0000-4000-8000-0000000000f2' as JobId;

/** Verifier fixtures — one per Status, keyed by a sentinel email. */
const VERIFIER_FIXTURES: FixtureCase[] = [
  {
    name: 'verifier_valid',
    endpoint: 'email_verifier',
    match: { email: 'valid@example.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('valid@example.com', {
        status: 'valid',
        subStatus: 'ok',
        reasonCodes: ['verifier_confirmed_valid'],
        score: 98,
        provider: 'google_workspace',
        backend: 'api',
        evidence: 'verified',
        smtpCheck: true,
      }),
    },
  },
  {
    name: 'verifier_invalid',
    endpoint: 'email_verifier',
    match: { email: 'invalid@example.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('invalid@example.com', {
        status: 'invalid',
        subStatus: 'invalid_mailbox',
        reasonCodes: ['smtp_5_1_1'],
        score: 2,
        provider: 'google_workspace',
        backend: 'api',
        evidence: 'verified',
        rawSmtpCode: '550',
      }),
    },
  },
  {
    name: 'verifier_accept_all',
    endpoint: 'email_verifier',
    match: { email: 'accept-all@example.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('accept-all@example.com', {
        status: 'accept_all',
        subStatus: 'provider_unverifiable',
        reasonCodes: ['provider_m365_cap'],
        score: 84,
        provider: 'microsoft365',
        backend: 'api',
        evidence: 'capped',
        acceptAll: true,
      }),
    },
  },
  {
    name: 'verifier_unknown',
    endpoint: 'email_verifier',
    match: { email: 'unknown@example.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('unknown@example.com', {
        status: 'unknown',
        subStatus: 'timeout',
        reasonCodes: ['backend_timeout'],
        score: 40,
        provider: 'other',
        backend: 'none',
        evidence: 'degraded',
      }),
    },
  },
  {
    name: 'verifier_disposable',
    endpoint: 'email_verifier',
    match: { email: 'user@mailinator.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('user@mailinator.com', {
        status: 'disposable',
        subStatus: null,
        reasonCodes: ['disposable_domain'],
        score: 5,
        provider: null,
        backend: 'none',
        evidence: 'classifier',
        disposable: true,
        mxRecords: true,
      }),
    },
  },
  {
    name: 'verifier_webmail',
    endpoint: 'email_verifier',
    match: { email: 'person@gmail.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('person@gmail.com', {
        status: 'webmail',
        subStatus: null,
        reasonCodes: ['freemail_domain'],
        score: 30,
        provider: 'gmail_consumer',
        backend: 'none',
        evidence: 'classifier',
        webmail: true,
      }),
    },
  },
  {
    name: 'verifier_role',
    endpoint: 'email_verifier',
    match: { email: 'info@example.com' },
    outcome: {
      kind: 'verifier',
      result: verifier('info@example.com', {
        status: 'role',
        subStatus: null,
        reasonCodes: ['role_account'],
        score: 10,
        provider: null,
        backend: 'none',
        evidence: 'classifier',
      }),
    },
  },
];

/** Finder fixtures — a valid derivation and an accept_all cap (cover finder-side shapes). */
const FINDER_FIXTURES: FixtureCase[] = [
  {
    name: 'finder_valid',
    endpoint: 'email_finder',
    match: { firstName: 'jane', lastName: 'doe', domain: 'example.com' },
    outcome: {
      kind: 'finder',
      result: finder('jane.doe@example.com', 'example.com', {
        firstName: 'jane',
        lastName: 'doe',
        status: 'valid',
        subStatus: 'ok',
        reasonCodes: ['pattern_learned_domain', 'verifier_confirmed_valid'],
        score: 96,
        provider: 'google_workspace',
        backend: 'api',
        evidence: 'verified',
      }),
    },
  },
  {
    name: 'finder_accept_all',
    endpoint: 'email_finder',
    match: { firstName: 'john', lastName: 'smith', domain: 'catchall.com' },
    outcome: {
      kind: 'finder',
      result: finder('john.smith@catchall.com', 'catchall.com', {
        firstName: 'john',
        lastName: 'smith',
        status: 'accept_all',
        subStatus: 'catch_all_confirmed',
        reasonCodes: ['catch_all_cap'],
        score: 72,
        provider: 'microsoft365',
        backend: 'api',
        evidence: 'capped',
        acceptAll: true,
      }),
    },
  },
];

/** Async 202 path — a verifier request that defers to a background job. */
const ASYNC_FIXTURES: FixtureCase[] = [
  {
    name: 'verifier_async_202',
    endpoint: 'email_verifier',
    match: { email: 'async@example.com' },
    outcome: { kind: 'async_202', jobId: SANDBOX_JOB_ID },
  },
];

/** Error fixtures — one per client-facing error code (sandbox never spends credits). */
const ERROR_FIXTURES: FixtureCase[] = [
  {
    name: 'error_insufficient_credits',
    endpoint: 'email_verifier',
    match: { email: 'nocredits@example.com' },
    outcome: { kind: 'error', error: errors.insufficientCredits() },
  },
  {
    name: 'error_rate_limited',
    endpoint: 'email_verifier',
    match: { email: 'ratelimited@example.com' },
    outcome: { kind: 'error', error: errors.rateLimited(30) },
  },
  {
    name: 'error_invalid_email',
    endpoint: 'email_verifier',
    match: { email: 'not-an-email' },
    outcome: { kind: 'error', error: errors.invalidEmail() },
  },
  {
    name: 'error_verification_unavailable',
    endpoint: 'email_verifier',
    match: { email: 'unavailable@example.com' },
    outcome: { kind: 'error', error: errors.verificationUnavailable() },
  },
  {
    name: 'error_invalid_domain',
    endpoint: 'email_finder',
    match: { firstName: 'jane', lastName: 'doe', domain: 'not a domain' },
    outcome: { kind: 'error', error: errors.invalidDomain() },
  },
  {
    name: 'error_domain_required',
    endpoint: 'email_finder',
    match: { firstName: 'jane', lastName: 'doe', domain: '' },
    outcome: { kind: 'error', error: errors.domainRequired() },
  },
];

export const FIXTURES: readonly FixtureCase[] = Object.freeze([
  ...VERIFIER_FIXTURES,
  ...FINDER_FIXTURES,
  ...ASYNC_FIXTURES,
  ...ERROR_FIXTURES,
]);

/** Every Status is produced by at least one finder/verifier fixture (contract-tested all-true). */
export const FIXTURE_STATUS_COVERAGE: Readonly<Record<Status, boolean>> = (() => {
  const seen = new Set<Status>();
  for (const f of FIXTURES) {
    if (f.outcome.kind === 'finder' || f.outcome.kind === 'verifier') seen.add(f.outcome.result.status);
  }
  const cov = {} as Record<Status, boolean>;
  for (const s of STATUSES) cov[s] = seen.has(s);
  return Object.freeze(cov);
})();
