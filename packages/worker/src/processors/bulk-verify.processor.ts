// @mailmetero/worker — bulk_verify processor.
//
// Same shape as bulk_find, but each item runs Pipeline.verify. Per-item requestId
// `${job.requestId}:${rowIndex}` keeps the ledger's exactly-once key stable across requeue.

import type { JobRow } from '@mailmetero/db';
import type { WorkerDeps } from '../deps.ts';
import type { JobProcessor } from './registry.ts';
import { runWithConcurrency, settleVerifierItem, WorkerRetryableError } from '../item.ts';

const RESULT_TTL_FALLBACK_DAYS = 90;

async function retentionFor(deps: WorkerDeps, job: JobRow): Promise<number> {
  const tenant = await deps.tenants.byId(deps.pools.direct, job.tenantId);
  return tenant?.retentionDays ?? RESULT_TTL_FALLBACK_DAYS;
}

export const bulkVerifyProcessor: JobProcessor = {
  kind: 'bulk_verify',
  async process(job, deps, signal) {
    const retentionDays = await retentionFor(deps, job);
    const items = await deps.jobs.listPendingItems(deps.pools.direct, job.id);
    const outcomes = await runWithConcurrency(items, deps.itemConcurrency, async (item) => {
      if (signal.aborted) return 'retry';
      return settleVerifierItem(deps, job, item, retentionDays);
    });
    const pending = outcomes.filter((o) => o === 'retry').length;
    if (pending > 0) throw new WorkerRetryableError(pending);
  },
};
