// @mailmetero/worker — bulk_find processor.
//
// Loads the job's still-pending items, settles each (Pipeline.find → decideBilling → persist+bill →
// wire → recordItemResult) with bounded item concurrency, and signals a retry if any item could
// not be settled this pass. Settled items are idempotent, so a retry reprocesses only what remains.

import type { JobRow } from '@mailmetero/db';
import type { WorkerDeps } from '../deps.ts';
import type { JobProcessor } from './registry.ts';
import { runWithConcurrency, settleFinderItem, WorkerRetryableError } from '../item.ts';

const RESULT_TTL_FALLBACK_DAYS = 90;

async function retentionFor(deps: WorkerDeps, job: JobRow): Promise<number> {
  const tenant = await deps.tenants.byId(deps.pools.direct, job.tenantId);
  return tenant?.retentionDays ?? RESULT_TTL_FALLBACK_DAYS;
}

export const bulkFindProcessor: JobProcessor = {
  kind: 'bulk_find',
  async process(job, deps, signal) {
    const retentionDays = await retentionFor(deps, job);
    const items = await deps.jobs.listPendingItems(deps.pools.direct, job.id);
    const outcomes = await runWithConcurrency(items, deps.itemConcurrency, async (item) => {
      if (signal.aborted) return 'retry';
      return settleFinderItem(deps, job, item, retentionDays);
    });
    const pending = outcomes.filter((o) => o === 'retry').length;
    if (pending > 0) throw new WorkerRetryableError(pending);
  },
};
