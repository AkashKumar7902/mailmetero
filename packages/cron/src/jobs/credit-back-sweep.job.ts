// @mailmetero/cron — credit-back-sweep (PRD §4/§7 outcome-conditional billing).
//
// Finds billable attempts (last 30 days) whose domain has since become a confirmed catch-all /
// M365 (per-address deliverability now unknowable) and refunds them. Each candidate is handled in
// its own transaction: `issueCreditBack` inserts the credit_back ledger row (unique per attempt),
// and only when that insert actually happened do we restore the tenant's materialized balance —
// so a retry / already-credited attempt is a no-op (no double refund).

import { withTransaction } from '@mailmetero/db';
import { defineCronJob } from '../job.ts';

/** Look-back window for credit-back candidates. */
const WITHIN_DAYS = 30;
/** Max candidates per run (bounded work; the next run picks up the rest). */
const LIMIT = 1000;
/** Credits restored per refunded attempt (attempts debit exactly one credit). */
const CREDITS_PER_REFUND = 1;

export const creditBackSweepJob = defineCronJob('credit-back-sweep', async (ctx, metrics) => {
  const pool = ctx.deps.pools.direct;
  const candidates = await ctx.deps.ledger.findCreditBackCandidates(pool, WITHIN_DAYS, LIMIT);
  metrics.candidates = candidates.length;

  let credited = 0;
  let skipped = 0;
  for (const c of candidates) {
    await withTransaction(pool, async (tx) => {
      const { applied } = await ctx.deps.ledger.issueCreditBack(tx, c.ledgerId, c.reason);
      if (applied) {
        await ctx.deps.tenants.creditBack(tx, c.tenantId, CREDITS_PER_REFUND);
        credited += 1;
      } else {
        // Already credited back (unique constraint) — never refund twice.
        skipped += 1;
      }
    });
  }
  metrics.credited = credited;
  metrics.skipped = skipped;
});
