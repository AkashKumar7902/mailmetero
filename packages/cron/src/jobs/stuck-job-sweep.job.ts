// @mailmetero/cron — stuck-job-sweep (PRD §7 P0-7).
//
// A worker that dies mid-job leaves the row 'claimed'/'running' with an expired visibility
// deadline. This sweep requeues those with backoff, and fails the ones that have exhausted their
// attempt budget. Runs off the unpooled `direct` pool (long-lived UPDATE … FROM).

import { defineCronJob, iso } from '../job.ts';

/** Attempt ceiling before a stuck job is failed rather than requeued. */
const MAX_JOB_ATTEMPTS = 5;
/** Requeue backoff, aligned with the worker's 30–60s idle backoff (PRD §8 D20). */
const SWEEP_BACKOFF_MS = 30_000;

export const stuckJobSweepJob = defineCronJob('stuck-job-sweep', async (ctx, metrics) => {
  const { requeued, failed } = await ctx.deps.jobs.sweepStuck(
    ctx.deps.pools.direct,
    iso(ctx.now),
    MAX_JOB_ATTEMPTS,
    SWEEP_BACKOFF_MS,
  );
  metrics.requeued = requeued;
  metrics.failed = failed;
});
