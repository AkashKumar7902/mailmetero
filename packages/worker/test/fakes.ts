// Shared in-memory fakes for the worker unit tests. No Postgres, no network: the real core
// canonicalizers, the real decideBilling/withTransaction/sha256Hex, the real wire mapper and the
// real loop/processors run against these fakes.

import type { DbPools } from '@mailmetero/db';
import { DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
import type {
  JobRow,
  JobItemRow,
} from '@mailmetero/db';
import type {
  Pipeline,
  InternalFinderResult,
  InternalVerifierResult,
  PipelineFinderOutput,
  PipelineVerifierOutput,
} from '@mailmetero/pipeline';
import type {
  TenantId,
  JobId,
  RequestId,
  Domain,
  EmailAddress,
  IsoTimestamp,
  VerificationEvidence,
  BillingInput,
} from '@mailmetero/contracts';
import type { WorkerConfig, WorkerDeps } from '../src/deps.ts';

export const TENANT = '11111111-1111-1111-1111-111111111111' as TenantId;

export function fakeLogger(): WorkerDeps['logger'] {
  const noop = (): void => {};
  const l = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
  // pino Logger has more surface; the worker only uses the level methods.
  return l as unknown as WorkerDeps['logger'];
}

export function fakePools(): DbPools {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  return { web: pool, direct: pool } as unknown as DbPools;
}

function evidence(): VerificationEvidence {
  return {
    tier: 'learned_pattern',
    backend: 'api',
    producedByStage: 'score_and_writeback',
    mx: 'EXPLICIT_MX',
    provider: 'google_workspace',
    verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
    isCatchAll: false,
    rawSmtpCode: null,
    enhancedCode: null,
    capsApplied: [],
    verifiedAt: '2026-07-19T00:00:00.000Z' as IsoTimestamp,
    stale: false,
  };
}

export function finderResult(domain: string, email: string): InternalFinderResult {
  return {
    email: email as EmailAddress,
    score: 92,
    status: 'valid',
    subStatus: 'ok',
    domain: domain as Domain,
    firstName: 'jane',
    lastName: 'doe',
    reasonCodes: ['pattern_learned_domain'],
    provider: 'google_workspace',
    backend: 'api',
    evidence: 'learned_pattern',
    collisionRisk: false,
    chosen: null,
    candidates: [],
    verification: evidence(),
  };
}

export function finderOk(domain: string, email: string): PipelineFinderOutput {
  const billingInput: BillingInput = {
    endpoint: 'finder',
    status: 'valid',
    subStatus: 'ok',
    score: 92,
    backend: 'api',
    evidence: 'learned_pattern',
    hasEmail: true,
  };
  return { kind: 'ok', result: finderResult(domain, email), billingInput, deferrable: false };
}

export function verifierResult(email: string): InternalVerifierResult {
  return {
    email: email as EmailAddress,
    status: 'valid',
    score: 96,
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
    rawSmtpCode: '250',
    verification: evidence(),
  };
}

export function verifierOk(email: string): PipelineVerifierOutput {
  const billingInput: BillingInput = {
    endpoint: 'verifier',
    status: 'valid',
    subStatus: 'ok',
    score: 96,
    backend: 'api',
    evidence: 'verified',
    hasEmail: true,
  };
  return { kind: 'ok', result: verifierResult(email), billingInput };
}

/** A configurable fake Pipeline; find/verify return whatever the test scripts. */
export function fakePipeline(overrides?: Partial<Pipeline>): Pipeline {
  return {
    find: overrides?.find ?? (async () => finderOk('example.com', 'jane.doe@example.com')),
    verify: overrides?.verify ?? (async () => verifierOk('jane.doe@example.com')),
  };
}

/** Records every credit-affecting call so tests can assert exactly-once billing. */
export interface LedgerSpy {
  attempts: Array<{ requestId: string; endpoint: string; delta: number }>;
  applied: number[]; // creditsDeltaApplied returned to the caller, in call order
}
export interface TenantSpy {
  debits: Array<{ tenantId: string; credits: number }>;
}

export interface JobsSpy {
  claims: number;
  markRunning: JobId[];
  completed: JobId[];
  released: Array<{ jobId: JobId; reason: string }>;
  failed: Array<{ jobId: JobId; error: string }>;
  itemResults: Array<{ itemId: string; resultId: string | null }>;
  itemErrors: Array<{ itemId: string }>;
  heartbeats: number;
}

export interface Fakes {
  deps: WorkerDeps;
  ledgerSpy: LedgerSpy;
  tenantSpy: TenantSpy;
  jobsSpy: JobsSpy;
}

export interface FakeOptions {
  claimScript?: JobRow[][]; // successive claim() return values; after exhaustion returns []
  pendingItems?: (jobId: JobId) => JobItemRow[];
  pipeline?: Pipeline;
  heartbeatHeld?: boolean; // default true
}

export function makeFakes(opts: FakeOptions = {}): Fakes {
  const ledgerSpy: LedgerSpy = { attempts: [], applied: [] };
  const tenantSpy: TenantSpy = { debits: [] };
  const jobsSpy: JobsSpy = {
    claims: 0,
    markRunning: [],
    completed: [],
    released: [],
    failed: [],
    itemResults: [],
    itemErrors: [],
    heartbeats: 0,
  };

  // Ledger: idempotent on (tenant, requestId). First attempt applies decision.creditsDelta;
  // any later attempt with the same key applies 0 (the ON CONFLICT DO NOTHING contract).
  const seen = new Map<string, string>();
  const ledger = {
    async recordAttempt(_q: unknown, input: {
      tenantId: string;
      requestId: string;
      endpoint: string;
      decision: { creditsDelta: number };
      resultId: string | null;
    }) {
      const key = `${input.tenantId}:${input.requestId}`;
      if (seen.has(key)) {
        ledgerSpy.applied.push(0);
        return { ledgerId: seen.get(key) as string, creditsDeltaApplied: 0 };
      }
      const ledgerId = `ledger-${key}`;
      seen.set(key, ledgerId);
      ledgerSpy.attempts.push({ requestId: input.requestId, endpoint: input.endpoint, delta: input.decision.creditsDelta });
      ledgerSpy.applied.push(input.decision.creditsDelta);
      return { ledgerId, creditsDeltaApplied: input.decision.creditsDelta };
    },
  };

  let balance = 1000;
  const tenants = {
    async byId(_q: unknown, id: TenantId) {
      return { id, retentionDays: 90, creditsRemaining: balance } as unknown;
    },
    async tryDebitCredit(_q: unknown, id: TenantId, credits: number) {
      tenantSpy.debits.push({ tenantId: id, credits });
      balance -= credits;
      return balance;
    },
  };

  let insertSeq = 0;
  const results = {
    async insert(_q: unknown, row: { requestId: RequestId }) {
      insertSeq += 1;
      return { id: `result-${row.requestId}`, requestId: row.requestId } as unknown;
    },
  };

  const claimScript = opts.claimScript ?? [];
  const jobs = {
    async claim() {
      const batch = claimScript[jobsSpy.claims] ?? [];
      jobsSpy.claims += 1;
      return batch;
    },
    async markRunning(_q: unknown, jobId: JobId) {
      jobsSpy.markRunning.push(jobId);
    },
    async listPendingItems(_q: unknown, jobId: JobId) {
      return opts.pendingItems ? opts.pendingItems(jobId) : [];
    },
    async recordItemResult(_q: unknown, itemId: string, _result: unknown, resultId: string | null) {
      jobsSpy.itemResults.push({ itemId, resultId });
    },
    async recordItemError(_q: unknown, itemId: string) {
      jobsSpy.itemErrors.push({ itemId });
    },
    async heartbeat() {
      jobsSpy.heartbeats += 1;
      return opts.heartbeatHeld ?? true;
    },
    async completeJob(_q: unknown, jobId: JobId) {
      jobsSpy.completed.push(jobId);
    },
    async releaseJob(_q: unknown, jobId: JobId, reason: string) {
      jobsSpy.released.push({ jobId, reason });
    },
    async failJob(_q: unknown, jobId: JobId, error: string) {
      jobsSpy.failed.push({ jobId, error });
    },
  };

  const deps: WorkerDeps = {
    pools: fakePools(),
    jobs: jobs as unknown as WorkerDeps['jobs'],
    ledger: ledger as unknown as WorkerDeps['ledger'],
    results: results as unknown as WorkerDeps['results'],
    tenants: tenants as unknown as WorkerDeps['tenants'],
    pipeline: opts.pipeline ?? fakePipeline(),
    billingCaps: DEFAULT_SCORING_CONFIG.caps,
    logger: fakeLogger(),
    itemConcurrency: 4,
  };

  return { deps, ledgerSpy, tenantSpy, jobsSpy };
}

export function makeJob(kind: JobRow['kind'], overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1' as JobId,
    tenantId: TENANT,
    kind,
    status: 'queued',
    total: 1,
    done: 0,
    failed: 0,
    attempts: 0,
    maxAttempts: 5,
    priority: 0,
    runAfter: '2026-07-19T00:00:00.000Z' as IsoTimestamp,
    lockedBy: null,
    lockedAt: null,
    visibilityDeadline: null,
    idempotencyKey: null,
    requestId: 'req-abc' as RequestId,
    lastError: null,
    createdAt: '2026-07-19T00:00:00.000Z' as IsoTimestamp,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

export function makeItem(rowIndex: number, input: unknown, job: JobRow): JobItemRow {
  return {
    id: `item-${rowIndex}`,
    jobId: job.id,
    tenantId: job.tenantId,
    rowIndex,
    requestId: `${job.requestId}:${rowIndex}` as RequestId,
    input,
    status: 'pending',
    result: null,
    resultId: null,
    error: null,
    processedAt: null,
  };
}

export const testWorkerConfig: WorkerConfig = {
  workerId: 'worker-test',
  batchSize: 5,
  idleBackoffMinMs: 1,
  idleBackoffMaxMs: 2,
  visibilityMs: 1000,
  heartbeatMs: 10_000,
  maxAttempts: 5,
  itemConcurrency: 4,
  shutdownGraceMs: 50,
};
