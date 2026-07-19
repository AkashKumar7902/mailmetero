// @mailmetero/worker — the SKIP LOCKED consume loop (MODULE_CONTRACTS §9).
//
// Steady state: claim a batch of jobs (FOR UPDATE SKIP LOCKED, on the unpooled pool) → dispatch
// each to its processor while a heartbeat keeps the visibility lease alive → complete on success,
// release (with backoff) when items still need retrying, fail when attempts are exhausted. An empty
// claim sleeps a random interval in [idleBackoffMinMs, idleBackoffMaxMs] before trying again. The
// loop returns cleanly once `signal` is aborted and the in-flight job has drained.

import type { JobRow } from '@mailmetero/db';
import type { WorkerConfig, WorkerDeps } from './deps.ts';
import { PROCESSORS } from './processors/registry.ts';
import { WorkerRetryableError } from './item.ts';

const MAX_BACKOFF_MS = 60_000;

/** Random integer in [min, max] (inclusive); tolerates min > max. */
function randomBackoff(minMs: number, maxMs: number): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Abortable sleep — resolves after `ms` or immediately once `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffForAttempt(attempts: number): number {
  const exp = 1_000 * 2 ** Math.max(0, attempts);
  return Math.min(MAX_BACKOFF_MS, exp);
}

/** Process one claimed job under a heartbeat lease. Never throws — outcomes are persisted. */
async function dispatchJob(job: JobRow, cfg: WorkerConfig, deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  const processor = PROCESSORS[job.kind];
  const jobController = new AbortController();
  const combined = AbortSignal.any([signal, jobController.signal]);

  // Keep the visibility lease alive; if the lease is lost (another worker/sweep took it), abort.
  const heartbeat = setInterval(() => {
    void deps.jobs
      .heartbeat(deps.pools.direct, job.id, cfg.workerId, cfg.visibilityMs)
      .then((held) => {
        if (!held) jobController.abort();
      })
      .catch((err: unknown) => {
        deps.logger.warn({ jobId: job.id, err: String(err) }, 'worker: heartbeat failed');
      });
  }, cfg.heartbeatMs);

  try {
    await deps.jobs.markRunning(deps.pools.direct, job.id);
    await processor.process(job, deps, combined);
    await deps.jobs.completeJob(deps.pools.direct, job.id);
    deps.logger.info({ jobId: job.id, kind: job.kind }, 'worker: job complete');
  } catch (err) {
    const retryable = err instanceof WorkerRetryableError;
    // `claim` already incremented `job.attempts` to count the current attempt (jobs.ts:194),
    // so `job.attempts` is the number of executions so far. Do not add 1 (would exhaust the
    // budget one attempt early). The backoff at line 77 intentionally uses the incremented value.
    const attemptsSoFar = job.attempts;
    if (!retryable && attemptsSoFar >= Math.min(job.maxAttempts, cfg.maxAttempts)) {
      await deps.jobs.failJob(deps.pools.direct, job.id, String(err));
      deps.logger.error({ jobId: job.id, err: String(err) }, 'worker: job failed (attempts exhausted)');
    } else {
      await deps.jobs.releaseJob(deps.pools.direct, job.id, String(err), backoffForAttempt(job.attempts));
      deps.logger.warn({ jobId: job.id, retryable, err: String(err) }, 'worker: job released for retry');
    }
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * The consume loop. Runs until `signal` aborts. Claims run on the unpooled direct pool so
 * `FOR UPDATE SKIP LOCKED` and long transactions are legal (D20).
 */
export async function runWorkerLoop(cfg: WorkerConfig, deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  deps.logger.info({ workerId: cfg.workerId, batchSize: cfg.batchSize }, 'worker: loop started');
  while (!signal.aborted) {
    let batch: JobRow[];
    try {
      batch = await deps.jobs.claim(deps.pools.direct, cfg.workerId, cfg.batchSize, cfg.visibilityMs);
    } catch (err) {
      deps.logger.error({ err: String(err) }, 'worker: claim failed');
      await sleep(randomBackoff(cfg.idleBackoffMinMs, cfg.idleBackoffMaxMs), signal);
      continue;
    }

    if (batch.length === 0) {
      await sleep(randomBackoff(cfg.idleBackoffMinMs, cfg.idleBackoffMaxMs), signal);
      continue;
    }

    for (const job of batch) {
      if (signal.aborted) break;
      await dispatchJob(job, cfg, deps, signal);
    }
  }
  deps.logger.info({ workerId: cfg.workerId }, 'worker: loop stopped');
}
