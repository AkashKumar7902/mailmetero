// @mailmetero/worker — async_verify processor (the 202 single-item path, D4).
//
// A single-item verification job enqueued when the sync verifier budget was exceeded. Consumers
// poll GET /v2/verifications/{id}; JobsRepo.getVerificationResult reads the stored wire result.
// Structurally identical to bulk_verify (one item), settled through the same idempotent engine.

import type { JobRow } from '@mailmetero/db';
import type { WorkerDeps } from '../deps.ts';
import type { JobProcessor } from './registry.ts';
import { settleVerifierItem, WorkerRetryableError } from '../item.ts';

const RESULT_TTL_FALLBACK_DAYS = 90;

async function retentionFor(deps: WorkerDeps, job: JobRow): Promise<number> {
  const tenant = await deps.tenants.byId(deps.pools.direct, job.tenantId);
  return tenant?.retentionDays ?? RESULT_TTL_FALLBACK_DAYS;
}

export const asyncVerifyProcessor: JobProcessor = {
  kind: 'async_verify',
  async process(job, deps, signal) {
    if (signal.aborted) throw new WorkerRetryableError(1);
    const retentionDays = await retentionFor(deps, job);
    const items = await deps.jobs.listPendingItems(deps.pools.direct, job.id);
    let pending = 0;
    for (const item of items) {
      if (signal.aborted) {
        pending += 1;
        continue;
      }
      const outcome = await settleVerifierItem(deps, job, item, retentionDays);
      if (outcome === 'retry') pending += 1;
    }
    if (pending > 0) throw new WorkerRetryableError(pending);
  },
};
