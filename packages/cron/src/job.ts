// @mailmetero/cron — the CronJob harness.
//
// Every scheduled job is a `CronJob` with a stable `name` and a `run(ctx)` that returns a
// structured `CronJobReport` (timing + per-job metrics + optional error). Jobs never throw out
// of `run`: the `defineCronJob` wrapper times the body, catches any error, and folds it into an
// `ok:false` report so the dispatcher can turn it into a non-zero process exit. A mutable
// `metrics` object is threaded through the body so partial progress (e.g. rows purged before an
// assertion fails) is still surfaced on failure.

import { performance } from 'node:perf_hooks';
import type { IsoTimestamp } from '@mailmetero/contracts';
import type { Logger } from '@mailmetero/config';
import type { DbPools } from '@mailmetero/db';
import type {
  ResultsRepo,
  LedgerRepo,
  JobsRepo,
  TenantsRepo,
  ObjectionsRepo,
  IdempotencyRepo,
} from '@mailmetero/db';
import type { EmailBackend } from '@mailmetero/email';

/** The seven scheduled jobs — one render.yaml cron service each. Runtime array so the
 *  dispatcher can validate argv and enumerate the registry. */
export const CRON_JOB_NAMES = [
  'ttl-purge',
  'stuck-job-sweep',
  'quota-spend-reset',
  'credit-back-sweep',
  'quota-alert',
  'blocklist-sync',
  'objection-expiry',
] as const;
export type CronJobName = (typeof CRON_JOB_NAMES)[number];

/** Everything the jobs touch: the unpooled pool pair (crons run long batch tx off `direct`),
 *  the repos they compose, the email backend for alerts, and the vendored-data anchor for the
 *  no-egress blocklist refresh. Assembled once by the dispatcher. */
export interface CronDeps {
  pools: DbPools;
  results: ResultsRepo;
  ledger: LedgerRepo;
  jobs: JobsRepo;
  tenants: TenantsRepo;
  objections: ObjectionsRepo;
  idempotency: IdempotencyRepo;
  email: EmailBackend;
  vendorDir: string;
}

export interface CronJobContext {
  now: Date;
  logger: Logger;
  deps: CronDeps;
}

export interface CronJobReport {
  job: string;
  ok: boolean;
  durationMs: number;
  metrics: Record<string, number>;
  error?: string;
}

export interface CronJob {
  readonly name: CronJobName;
  run(ctx: CronJobContext): Promise<CronJobReport>;
}

/** The job body: mutate `metrics` as work completes, throw to signal failure. */
export type CronJobBody = (ctx: CronJobContext, metrics: Record<string, number>) => Promise<void>;

/** Wrap a job body with timing + error capture, producing the canonical `CronJobReport`. */
export function defineCronJob(name: CronJobName, body: CronJobBody): CronJob {
  return {
    name,
    async run(ctx: CronJobContext): Promise<CronJobReport> {
      const metrics: Record<string, number> = {};
      const startedAt = performance.now();
      try {
        await body(ctx, metrics);
        const durationMs = Math.round(performance.now() - startedAt);
        ctx.logger.info({ job: name, durationMs, metrics }, 'cron job completed');
        return { job: name, ok: true, durationMs, metrics };
      } catch (err) {
        const durationMs = Math.round(performance.now() - startedAt);
        const error = err instanceof Error ? err.message : String(err);
        ctx.logger.error({ job: name, durationMs, metrics, err: error }, 'cron job failed');
        return { job: name, ok: false, durationMs, metrics, error };
      }
    },
  };
}

/** Cast a `Date` to the branded wire timestamp the repos expect (RFC 3339 UTC). */
export function iso(date: Date): IsoTimestamp {
  return date.toISOString() as IsoTimestamp;
}
