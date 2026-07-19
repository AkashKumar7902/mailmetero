// @mailmetero/cron — blocklist-sync (weekly; PRD §7 P0-3).
//
// Re-applies the VENDORED freemail / disposable / role / typo classification lists into the kb.*
// tables via db's `refreshClassificationTables`. This does NO network egress — it re-reads the
// files already committed under `vendorDir` (compliance posture P0-11). Updating the vendored data
// itself is an out-of-band, reviewed commit; this job only re-seeds from what's on disk. Runs off
// the unpooled `direct` pool (bulk idempotent upserts).

import { refreshClassificationTables } from '@mailmetero/db';
import { defineCronJob } from '../job.ts';

export const blocklistSyncJob = defineCronJob('blocklist-sync', async (ctx, metrics) => {
  const counts = await refreshClassificationTables(ctx.deps.pools.direct, ctx.deps.vendorDir);
  metrics.freemail = counts.freemail;
  metrics.disposable = counts.disposable;
  metrics.roles = counts.roles;
  metrics.typos = counts.typos;
});
