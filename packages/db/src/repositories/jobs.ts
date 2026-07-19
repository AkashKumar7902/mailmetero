// @mailmetero/db — JobsRepo (the FOR UPDATE SKIP LOCKED queue, D4/D20).
//
// Runs on the UNPOOLED direct pool (claim uses row locks + a long-ish transaction). Job
// item request ids are deterministic (`${job.requestId}:${rowIndex}`) so the ledger's
// exactly-once key survives retries. Stored item results are WIRE shapes (api/worker map
// internal→wire before recording).

import type {
  TenantId, JobId, RequestId, IsoTimestamp,
  JobKind, JobStatus, JobItemStatus,
  BulkAccepted, BulkJobStatus, BulkFinderRow, BulkVerifierRow,
  FinderResult, VerifierResult, ErrorEnvelope,
} from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rows } from '../client.ts';
import type { JobRow, JobItemRow } from '../types.ts';

interface JobRaw {
  id: string;
  tenant_id: string;
  kind: JobKind;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  attempts: number;
  max_attempts: number;
  priority: number;
  run_after: string;
  locked_by: string | null;
  locked_at: string | null;
  visibility_deadline: string | null;
  idempotency_key: string | null;
  request_id: string;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function mapJob(r: JobRaw): JobRow {
  return {
    id: r.id as JobId,
    tenantId: r.tenant_id as TenantId,
    kind: r.kind,
    status: r.status,
    total: r.total,
    done: r.done,
    failed: r.failed,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    priority: r.priority,
    runAfter: r.run_after as IsoTimestamp,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at as IsoTimestamp | null,
    visibilityDeadline: r.visibility_deadline as IsoTimestamp | null,
    idempotencyKey: r.idempotency_key,
    requestId: r.request_id as RequestId,
    lastError: r.last_error,
    createdAt: r.created_at as IsoTimestamp,
    startedAt: r.started_at as IsoTimestamp | null,
    finishedAt: r.finished_at as IsoTimestamp | null,
  };
}

interface JobItemRaw {
  id: string;
  job_id: string;
  tenant_id: string;
  row_index: number;
  request_id: string;
  input: unknown;
  status: JobItemStatus;
  result: FinderResult | VerifierResult | ErrorEnvelope | null;
  result_id: string | null;
  error: unknown | null;
  processed_at: string | null;
}

function mapItem(r: JobItemRaw): JobItemRow {
  return {
    id: r.id,
    jobId: r.job_id as JobId,
    tenantId: r.tenant_id as TenantId,
    rowIndex: r.row_index,
    requestId: r.request_id as RequestId,
    input: r.input,
    status: r.status,
    result: r.result,
    resultId: r.result_id,
    error: r.error,
    processedAt: r.processed_at as IsoTimestamp | null,
  };
}

const JOB_COL_NAMES = [
  'id', 'tenant_id', 'kind', 'status', 'total', 'done', 'failed', 'attempts', 'max_attempts',
  'priority', 'run_after', 'locked_by', 'locked_at', 'visibility_deadline', 'idempotency_key',
  'request_id', 'last_error', 'created_at', 'started_at', 'finished_at',
] as const;
const JOB_COLS_J = JOB_COL_NAMES.map((c) => `j.${c}`).join(', ');

export interface JobsRepo {
  createJob(
    q: Queryable,
    input: {
      tenantId: TenantId;
      kind: JobKind;
      requestId: RequestId;
      idempotencyKey?: string;
      expiresHint?: IsoTimestamp;
      items: Array<{ rowIndex: number; input: unknown }>;
    },
  ): Promise<BulkAccepted>;
  enqueueVerification(q: Queryable, tenantId: TenantId, email: string, requestId: RequestId): Promise<{ jobId: JobId }>;
  claim(q: Queryable, workerId: string, batch: number, visibilityMs: number): Promise<JobRow[]>;
  markRunning(q: Queryable, jobId: JobId): Promise<void>;
  listPendingItems(q: Queryable, jobId: JobId): Promise<JobItemRow[]>;
  recordItemResult(q: Queryable, itemId: string, result: FinderResult | VerifierResult, resultId: string | null): Promise<void>;
  recordItemError(q: Queryable, itemId: string, error: ErrorEnvelope): Promise<void>;
  heartbeat(q: Queryable, jobId: JobId, workerId: string, visibilityMs: number): Promise<boolean>;
  completeJob(q: Queryable, jobId: JobId): Promise<void>;
  releaseJob(q: Queryable, jobId: JobId, reason: string, backoffMs: number): Promise<void>;
  failJob(q: Queryable, jobId: JobId, error: string): Promise<void>;
  getJobStatus(q: Queryable, tenantId: TenantId, jobId: JobId): Promise<BulkJobStatus | null>;
  getJobResults(
    q: Queryable,
    tenantId: TenantId,
    jobId: JobId,
    limit: number,
    offset: number,
  ): Promise<{ rows: Array<BulkFinderRow | BulkVerifierRow>; total: number; nextOffset: number | null }>;
  getVerificationResult(
    q: Queryable,
    tenantId: TenantId,
    jobId: JobId,
  ): Promise<{ kind: 'done'; result: VerifierResult } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'not_found' }>;
  sweepStuck(q: Queryable, now: IsoTimestamp, maxAttempts: number, backoffMs: number): Promise<{ requeued: number; failed: number }>;
}

function msInterval(param: string): string {
  return `(${param}::text || ' milliseconds')::interval`;
}

export function createJobsRepo(): JobsRepo {
  return {
    async createJob(q, input) {
      const job = await maybeOne<{ id: string }>(
        q,
        `INSERT INTO jobs (tenant_id, kind, status, total, request_id, idempotency_key)
         VALUES ($1, $2, 'queued', $3, $4, $5)
         RETURNING id`,
        [input.tenantId, input.kind, input.items.length, input.requestId, input.idempotencyKey ?? null],
      );
      const jobId = (job as { id: string }).id;

      if (input.items.length > 0) {
        // Multi-row insert; params flattened per item.
        const values: string[] = [];
        const params: unknown[] = [];
        let p = 0;
        for (const it of input.items) {
          values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p}::jsonb, 'pending')`);
          params.push(jobId, input.tenantId, it.rowIndex, `${input.requestId}:${it.rowIndex}`, JSON.stringify(it.input));
        }
        await q.query(
          `INSERT INTO job_items (job_id, tenant_id, row_index, request_id, input, status)
           VALUES ${values.join(', ')}`,
          params,
        );
      }

      return { job_id: jobId as JobId, status: 'queued', count: input.items.length };
    },

    async enqueueVerification(q, tenantId, email, requestId) {
      const accepted = await this.createJob(q, {
        tenantId,
        kind: 'async_verify',
        requestId,
        items: [{ rowIndex: 0, input: { email } }],
      });
      return { jobId: accepted.job_id };
    },

    async claim(q, workerId, batch, visibilityMs) {
      const rs = await rows<JobRaw>(
        q,
        `UPDATE jobs j
            SET status = 'claimed',
                locked_by = $1,
                locked_at = now(),
                visibility_deadline = now() + ${msInterval('$3')},
                attempts = j.attempts + 1
           FROM (
             SELECT id FROM jobs
              WHERE status = 'queued' AND run_after <= now()
              ORDER BY priority DESC, created_at
              LIMIT $2
              FOR UPDATE SKIP LOCKED
           ) c
          WHERE j.id = c.id
        RETURNING ${JOB_COLS_J}`,
        [workerId, batch, visibilityMs],
      );
      return rs.map(mapJob);
    },

    async markRunning(q, jobId) {
      await q.query(
        `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1`,
        [jobId],
      );
    },

    async listPendingItems(q, jobId) {
      const rs = await rows<JobItemRaw>(
        q,
        `SELECT id, job_id, tenant_id, row_index, request_id, input, status, result, result_id, error, processed_at
           FROM job_items
          WHERE job_id = $1 AND status = 'pending'
          ORDER BY row_index`,
        [jobId],
      );
      return rs.map(mapItem);
    },

    async recordItemResult(q, itemId, result, resultId) {
      const updated = await maybeOne<{ job_id: string }>(
        q,
        `UPDATE job_items
            SET status = 'done', result = $2::jsonb, result_id = $3, processed_at = now()
          WHERE id = $1 AND status = 'pending'
        RETURNING job_id`,
        [itemId, JSON.stringify(result), resultId],
      );
      if (updated !== null) {
        await q.query(`UPDATE jobs SET done = done + 1 WHERE id = $1`, [updated.job_id]);
      }
    },

    async recordItemError(q, itemId, error) {
      const updated = await maybeOne<{ job_id: string }>(
        q,
        `UPDATE job_items
            SET status = 'failed', error = $2::jsonb, result = $2::jsonb, processed_at = now()
          WHERE id = $1 AND status = 'pending'
        RETURNING job_id`,
        [itemId, JSON.stringify(error)],
      );
      if (updated !== null) {
        await q.query(`UPDATE jobs SET failed = failed + 1 WHERE id = $1`, [updated.job_id]);
      }
    },

    async heartbeat(q, jobId, workerId, visibilityMs) {
      const row = await maybeOne<{ id: string }>(
        q,
        `UPDATE jobs
            SET visibility_deadline = now() + ${msInterval('$3')}
          WHERE id = $1 AND locked_by = $2 AND status IN ('claimed', 'running')
        RETURNING id`,
        [jobId, workerId, visibilityMs],
      );
      return row !== null;
    },

    async completeJob(q, jobId) {
      await q.query(
        `UPDATE jobs
            SET status = 'done', finished_at = now(),
                locked_by = NULL, locked_at = NULL, visibility_deadline = NULL
          WHERE id = $1`,
        [jobId],
      );
    },

    async releaseJob(q, jobId, reason, backoffMs) {
      await q.query(
        `UPDATE jobs
            SET status = 'queued', locked_by = NULL, locked_at = NULL, visibility_deadline = NULL,
                run_after = now() + ${msInterval('$3')}, last_error = $2
          WHERE id = $1`,
        [jobId, reason, backoffMs],
      );
    },

    async failJob(q, jobId, error) {
      await q.query(
        `UPDATE jobs
            SET status = 'failed', finished_at = now(), last_error = $2,
                locked_by = NULL, locked_at = NULL, visibility_deadline = NULL
          WHERE id = $1`,
        [jobId, error],
      );
    },

    async getJobStatus(q, tenantId, jobId) {
      const row = await maybeOne<{
        status: JobStatus;
        total: number;
        done: number;
        failed: number;
        created_at: string;
        finished_at: string | null;
      }>(
        q,
        `SELECT status, total, done, failed, created_at, finished_at
           FROM jobs WHERE id = $1 AND tenant_id = $2`,
        [jobId, tenantId],
      );
      if (row === null) return null;
      return {
        status: row.status,
        total: row.total,
        done: row.done,
        failed: row.failed,
        created_at: new Date(row.created_at).toISOString(),
        finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null,
      };
    },

    async getJobResults(q, tenantId, jobId, limit, offset) {
      const job = await maybeOne<{ kind: JobKind; total: number }>(
        q,
        `SELECT kind, total FROM jobs WHERE id = $1 AND tenant_id = $2`,
        [jobId, tenantId],
      );
      if (job === null) return { rows: [], total: 0, nextOffset: null };

      const items = await rows<JobItemRaw>(
        q,
        `SELECT id, job_id, tenant_id, row_index, request_id, input, status, result, result_id, error, processed_at
           FROM job_items
          WHERE job_id = $1
          ORDER BY row_index
          LIMIT $2 OFFSET $3`,
        [jobId, limit, offset],
      );

      const mapped: Array<BulkFinderRow | BulkVerifierRow> = items.map((it) => {
        if (job.kind === 'bulk_verify' || job.kind === 'async_verify') {
          return {
            input: it.input as { email: string },
            result: (it.result as VerifierResult | ErrorEnvelope | null) ?? { errors: [] },
          } satisfies BulkVerifierRow;
        }
        return {
          input: it.input as { first_name: string; last_name: string; domain: string },
          result: (it.result as FinderResult | ErrorEnvelope | null) ?? { errors: [] },
        } satisfies BulkFinderRow;
      });

      const consumed = offset + items.length;
      const nextOffset = consumed < job.total ? consumed : null;
      return { rows: mapped, total: job.total, nextOffset };
    },

    async getVerificationResult(q, tenantId, jobId) {
      const job = await maybeOne<{ status: JobStatus }>(
        q,
        `SELECT status FROM jobs WHERE id = $1 AND tenant_id = $2 AND kind = 'async_verify'`,
        [jobId, tenantId],
      );
      if (job === null) return { kind: 'not_found' };

      const item = await maybeOne<{ status: JobItemStatus; result: VerifierResult | ErrorEnvelope | null }>(
        q,
        `SELECT status, result FROM job_items WHERE job_id = $1 ORDER BY row_index LIMIT 1`,
        [jobId],
      );
      if (item === null || item.status === 'pending') return { kind: 'pending' };
      if (item.status === 'failed') return { kind: 'failed' };
      // status 'done' → the stored WIRE VerifierResult.
      return { kind: 'done', result: item.result as VerifierResult };
    },

    async sweepStuck(q, now, maxAttempts, backoffMs) {
      // Expired-visibility jobs that exhausted attempts → failed.
      const failed = await rows<{ id: string }>(
        q,
        `UPDATE jobs
            SET status = 'failed', finished_at = now(), last_error = 'sweep: max attempts exceeded',
                locked_by = NULL, locked_at = NULL, visibility_deadline = NULL
          WHERE status IN ('claimed', 'running')
            AND visibility_deadline < $1
            AND attempts >= $2
        RETURNING id`,
        [now, maxAttempts],
      );
      // Remaining expired jobs → requeued with backoff.
      const requeued = await rows<{ id: string }>(
        q,
        `UPDATE jobs
            SET status = 'queued', locked_by = NULL, locked_at = NULL, visibility_deadline = NULL,
                run_after = now() + ${msInterval('$2')}, last_error = 'sweep: visibility expired'
          WHERE status IN ('claimed', 'running')
            AND visibility_deadline < $1
        RETURNING id`,
        [now, backoffMs],
      );
      return { requeued: requeued.length, failed: failed.length };
    },
  };
}
