// @mailmetero/worker — the per-item settlement engine (shared by all three processors).
//
// For each job item the worker:
//   1. derives a STABLE per-item requestId = `${job.requestId}:${rowIndex}` (survives requeue),
//   2. canonicalizes the raw input and runs Pipeline.find / Pipeline.verify,
//   3. on an `ok` output: decideBilling → ONE transaction { ResultsRepo.insert →
//      LedgerRepo.recordAttempt (idempotent ON CONFLICT) → TenantsRepo.tryDebitCredit for the
//      EXACT delta the ledger applied }, then maps internal→wire and records the item result,
//   4. on an `input_error`: records a permanent ErrorEnvelope on the item,
//   5. on `unavailable` / `deferred`: leaves the item pending and signals a retry.
//
// Double-bill safety: `recordAttempt` is idempotent on (tenant, request_id) and returns
// `creditsDeltaApplied = 0` on a conflicting retry, so the debit runs exactly once no matter how
// many times a requeued item is reprocessed. Under-bill safety: the debit is driven by the ledger's
// applied delta, not a recomputed predicate, so a fresh billable attempt always debits.

import type {
  RequestId,
  Domain,
  EmailAddress,
  LocalPart,
  IsoTimestamp,
  Status,
  ErrorCode,
} from '@mailmetero/contracts';
import {
  normalizeName,
  classifyDomainInput,
  canonicalizeEmail,
  canonicalizeDomain,
  type NicknameMap,
  type ClassificationTables,
} from '@mailmetero/core';
import type { JobRow, JobItemRow, ResultRow } from '@mailmetero/db';
import { decideBilling, withTransaction, sha256Hex } from '@mailmetero/db';
import type {
  Pipeline,
  InternalFinderResult,
  InternalVerifierResult,
  ResultCacheKey,
} from '@mailmetero/pipeline';
import { toFinderResult, toVerifierResult } from '@mailmetero/pipeline';
import type { WorkerDeps } from './deps.ts';

/** Outcome of settling one item, reported back to the processor. */
export type ItemOutcome = 'done' | 'failed' | 'retry';

/**
 * Thrown by a processor when one or more items could not be settled this pass (pipeline
 * `unavailable`/`deferred`). The loop RELEASES the job with backoff instead of completing it;
 * only the still-pending items are reprocessed on the next claim (settled items are idempotent).
 */
export class WorkerRetryableError extends Error {
  readonly pendingCount: number;
  constructor(pendingCount: number) {
    super(`worker: ${pendingCount} item(s) require retry`);
    this.name = 'WorkerRetryableError';
    this.pendingCount = pendingCount;
  }
}

const RESULT_TTL_FALLBACK_DAYS = 90;

// A single empty nickname map / classification-tables view: the pipeline re-classifies against the
// LIVE KB tables (stage 2) and re-corrects typos, so the worker only needs canonical brand
// construction here — not an in-memory copy of the freemail/disposable/role/typo tables.
const EMPTY_NICKNAME_MAP: NicknameMap = { forward: new Map(), reverse: new Map() };
const EMPTY_CLASSIFICATION: Pick<ClassificationTables, 'freemail' | 'disposable'> = {
  freemail: new Set<string>(),
  disposable: new Set<string>(),
};

/** STABLE per-item requestId — the ledger/results exactly-once key that survives requeue. */
export function itemRequestId(job: JobRow, rowIndex: number): RequestId {
  return `${job.requestId}:${rowIndex}` as RequestId;
}

interface FinderItemInput {
  first_name: string;
  last_name: string;
  middle_name?: string;
  full_name?: string;
  domain: string;
}
interface VerifierItemInput {
  email: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function ttlFromRetention(deps: WorkerDeps, retentionDays: number): IsoTimestamp {
  const days = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : RESULT_TTL_FALLBACK_DAYS;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() as IsoTimestamp;
}

/**
 * ONE transaction: insert the person-level result, record the (idempotent) ledger attempt, and
 * debit credits for exactly the delta the ledger applied. Returns the stable result id.
 */
async function persistAndBill(
  deps: WorkerDeps,
  args: {
    tenantId: JobRow['tenantId'];
    requestId: RequestId;
    endpoint: 'finder' | 'verifier';
    resultRow: Omit<ResultRow, 'id' | 'createdAt'>;
    billing: ReturnType<typeof decideBilling>;
    status: Status;
    subStatus: ResultRow['subStatus'];
    score: number;
    backend: ResultRow['backend'];
    evidence: ResultRow['evidence'];
  },
): Promise<string> {
  return withTransaction(deps.pools.direct, async (tx) => {
    const inserted = await deps.results.insert(tx, args.resultRow);
    const { creditsDeltaApplied } = await deps.ledger.recordAttempt(tx, {
      tenantId: args.tenantId,
      requestId: args.requestId,
      endpoint: args.endpoint,
      decision: args.billing,
      resultStatus: args.status,
      resultSubStatus: args.subStatus,
      resultScore: args.score,
      backend: args.backend,
      evidence: args.evidence,
      resultId: inserted.id,
    });
    // creditsDeltaApplied is negative ONLY on a fresh billable attempt; 0 on a requeue conflict.
    if (creditsDeltaApplied < 0) {
      await deps.tenants.tryDebitCredit(tx, args.tenantId, -creditsDeltaApplied);
    }
    return inserted.id;
  });
}

/** Settle one bulk_find item. */
export async function settleFinderItem(deps: WorkerDeps, job: JobRow, item: JobItemRow, retentionDays: number): Promise<ItemOutcome> {
  const requestId = itemRequestId(job, item.rowIndex);
  const raw = asRecord(item.input);
  const parsed: FinderItemInput = {
    first_name: str(raw['first_name']),
    last_name: str(raw['last_name']),
    domain: str(raw['domain']),
    ...(optStr(raw['middle_name']) !== undefined ? { middle_name: optStr(raw['middle_name']) as string } : {}),
    ...(optStr(raw['full_name']) !== undefined ? { full_name: optStr(raw['full_name']) as string } : {}),
  };

  const domainInput = classifyDomainInput(parsed.domain, EMPTY_CLASSIFICATION);
  if (domainInput === null) {
    await recordItemError(deps, item, 'invalid_domain', `unresolvable domain: ${parsed.domain}`);
    return 'failed';
  }
  const name = normalizeName(
    {
      ...(parsed.first_name ? { firstName: parsed.first_name } : {}),
      ...(parsed.last_name ? { lastName: parsed.last_name } : {}),
      ...(parsed.middle_name !== undefined ? { middleName: parsed.middle_name } : {}),
      ...(parsed.full_name !== undefined ? { fullName: parsed.full_name } : {}),
    },
    EMPTY_NICKNAME_MAP,
    { domain: domainInput.domain },
  );

  const hash = sha256Hex(`find:${domainInput.domain}:${parsed.first_name}:${parsed.last_name}:${parsed.middle_name ?? ''}`);
  const cacheKey: ResultCacheKey = { kind: 'find', hash };

  const out = await deps.pipeline.find({ tenantId: job.tenantId, requestId, name, domain: domainInput, cacheKey });

  if (out.kind === 'input_error') {
    await recordItemError(deps, item, out.code, out.details);
    return 'failed';
  }
  if (out.kind === 'unavailable') {
    return 'retry';
  }

  const r: InternalFinderResult = out.result;
  const billing = decideBilling(out.billingInput, deps.billingCaps);
  const resultRow: Omit<ResultRow, 'id' | 'createdAt'> = {
    tenantId: job.tenantId,
    requestId,
    endpoint: 'finder',
    requestHash: hash,
    inputFirstName: parsed.first_name || null,
    inputLastName: parsed.last_name || null,
    inputMiddleName: parsed.middle_name ?? null,
    inputFullName: parsed.full_name ?? null,
    inputDomain: domainInput.domain,
    inputEmail: null,
    email: r.email,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    reasonCodes: r.reasonCodes,
    provider: r.provider,
    backend: r.backend,
    evidence: r.evidence,
    collisionRisk: r.collisionRisk,
    acceptAll: null,
    disposable: null,
    webmail: null,
    mxRecords: r.verification.mx !== null ? r.verification.mx !== 'NO_MAIL_HOST' && r.verification.mx !== 'NULL_MX' : null,
    smtpCheck: null,
    rawSmtpCode: r.verification.rawSmtpCode,
    enhancedCode: r.verification.enhancedCode,
    candidates: r.candidates.map((c) => ({ email: c.email, score: c.score, reason_codes: c.reasonCodes })),
    source: 'derivation',
    billed: billing.billable,
    verifiedAt: r.verification.verifiedAt,
    expiresAt: ttlFromRetention(deps, retentionDays),
  };

  const resultId = await persistAndBill(deps, {
    tenantId: job.tenantId,
    requestId,
    endpoint: 'finder',
    resultRow,
    billing,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    backend: r.backend,
    evidence: r.evidence,
  });

  await deps.jobs.recordItemResult(deps.pools.direct, item.id, toFinderResult(r), resultId);
  return 'done';
}

/** Settle one bulk_verify / async_verify item. */
export async function settleVerifierItem(deps: WorkerDeps, job: JobRow, item: JobItemRow, retentionDays: number): Promise<ItemOutcome> {
  const requestId = itemRequestId(job, item.rowIndex);
  const raw = asRecord(item.input);
  const rawEmail = str(raw['email']);

  const email = canonicalizeEmail(rawEmail);
  if (email === null) {
    await recordItemError(deps, item, 'invalid_email', `unparseable email: ${rawEmail}`);
    return 'failed';
  }
  const emailDomain = canonicalizeDomain(rawEmail.slice(rawEmail.lastIndexOf('@') + 1));
  const domainInput = emailDomain !== null ? classifyDomainInput(emailDomain, EMPTY_CLASSIFICATION) : null;
  if (domainInput === null) {
    await recordItemError(deps, item, 'invalid_email', `unresolvable email domain: ${rawEmail}`);
    return 'failed';
  }

  const hash = sha256Hex(`verify:${email}`);
  const cacheKey: ResultCacheKey = { kind: 'verify', hash };

  const out = await deps.pipeline.verify({ tenantId: job.tenantId, requestId, email, domain: domainInput, cacheKey });

  if (out.kind === 'input_error') {
    await recordItemError(deps, item, out.code, out.details);
    return 'failed';
  }
  if (out.kind === 'unavailable' || out.kind === 'deferred') {
    return 'retry';
  }

  const r: InternalVerifierResult = out.result;
  const billing = decideBilling(out.billingInput, deps.billingCaps);
  const resultRow: Omit<ResultRow, 'id' | 'createdAt'> = {
    tenantId: job.tenantId,
    requestId,
    endpoint: 'verifier',
    requestHash: hash,
    inputFirstName: null,
    inputLastName: null,
    inputMiddleName: null,
    inputFullName: null,
    inputDomain: domainInput.domain as Domain,
    inputEmail: email,
    email: r.email,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    reasonCodes: r.reasonCodes,
    provider: r.provider,
    backend: r.backend,
    evidence: r.evidence,
    collisionRisk: false,
    acceptAll: r.acceptAll,
    disposable: r.disposable,
    webmail: r.webmail,
    mxRecords: r.mxRecords,
    smtpCheck: r.smtpCheck,
    rawSmtpCode: r.rawSmtpCode,
    enhancedCode: r.verification.enhancedCode,
    candidates: [],
    source: 'derivation',
    billed: billing.billable,
    verifiedAt: r.verification.verifiedAt,
    expiresAt: ttlFromRetention(deps, retentionDays),
  };

  const resultId = await persistAndBill(deps, {
    tenantId: job.tenantId,
    requestId,
    endpoint: 'verifier',
    resultRow,
    billing,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    backend: r.backend,
    evidence: r.evidence,
  });

  await deps.jobs.recordItemResult(deps.pools.direct, item.id, toVerifierResult(r), resultId);
  return 'done';
}

async function recordItemError(deps: WorkerDeps, item: JobItemRow, code: ErrorCode, details: string): Promise<void> {
  await deps.jobs.recordItemError(deps.pools.direct, item.id, {
    errors: [{ id: item.id, code, details }],
  });
}

/** Bounded-concurrency fan-out over a job's items. Returns the settled outcomes in item order. */
export async function runWithConcurrency(
  items: readonly JobItemRow[],
  limit: number,
  settle: (item: JobItemRow) => Promise<ItemOutcome>,
): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = new Array<ItemOutcome>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      outcomes[i] = await settle(item);
    }
  });
  await Promise.all(workers);
  return outcomes;
}
