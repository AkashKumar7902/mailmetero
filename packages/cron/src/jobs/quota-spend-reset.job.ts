// @mailmetero/cron — quota-spend-reset (PRD §7 P0-15).
//
// Rolls every tenant's quota period forward (TenantsRepo.resetQuotas) and prunes stale
// ops.verifier_spend counter rows. The spend counters only need to cover the current window plus a
// short audit tail; older per-day rows are pruned to keep the table small. Runs off `direct`.

import { defineCronJob, iso } from '../job.ts';

/** Retain daily spend counters this many days before pruning (audit tail well beyond a period). */
const SPEND_COUNTER_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export const quotaSpendResetJob = defineCronJob('quota-spend-reset', async (ctx, metrics) => {
  const q = ctx.deps.pools.direct;

  const tenantsReset = await ctx.deps.tenants.resetQuotas(q, iso(ctx.now));
  metrics.tenantsReset = tenantsReset;

  // Prune spend counter rows older than the retention tail. No repo method exists for this
  // ops-only maintenance, so the cron issues the DELETE directly against the pool.
  const pruneBefore = dayStr(new Date(ctx.now.getTime() - SPEND_COUNTER_RETENTION_DAYS * DAY_MS));
  const res = await q.query(`DELETE FROM ops.verifier_spend WHERE spend_date < $1`, [pruneBefore]);
  metrics.spendRowsPruned = res.rowCount ?? 0;
});
