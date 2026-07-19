// @mailmetero/cron — ttl-purge (nightly; PRD §7 P0-11, Success Metric 10).
//
// Three steps, all off the unpooled `direct` pool:
//   1. Batched DELETE of person-level `results` past their `expires_at` TTL.
//   2. Null `usage_ledger.result_id` for ledger rows older than the MAX person-retention window —
//      the billing-dispute audit trail is retained past TTL, but its link to the (now-purged)
//      person-level result is minimized away (PRD §5.2 usage_ledger). We use the maximum
//      configurable retention (365d) as the cutoff so the audit link is never dropped while the
//      result it points to could still be alive under a longer per-tenant retention.
//   3. ASSERT zero `results` rows survive past TTL + a 24h grace (Success Metric 10 monitor).
//      A non-zero count throws → the job reports ok:false → the dispatcher exits non-zero and the
//      cron alert fires.

import { defineCronJob, iso } from '../job.ts';

const BATCH = 1000;
const MAX_BATCHES = 100_000; // safety bound; each batch strictly removes/updates its rows
/** Maximum configurable person-level retention (PRD Future #11: 30–365 days). Ledger rows created
 *  before this are guaranteed past their linked result's TTL under ANY tenant retention, so the
 *  result_id link can be safely minimized. */
const MAX_PERSON_RETENTION_DAYS = 365;
/** Success Metric 10 grace: zero rows alive past TTL + 24h. */
const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const ttlPurgeJob = defineCronJob('ttl-purge', async (ctx, metrics) => {
  const q = ctx.deps.pools.direct;
  const now = iso(ctx.now);

  // 1. Batched purge of expired results.
  let purged = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await ctx.deps.results.purgeExpired(q, now, BATCH);
    purged += n;
    if (n < BATCH) break;
  }
  metrics.purged = purged;

  // 2. Null usage_ledger.result_id for rows past the retention window.
  const redactCutoff = iso(new Date(ctx.now.getTime() - MAX_PERSON_RETENTION_DAYS * DAY_MS));
  let redacted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await ctx.deps.ledger.redactPastTtl(q, redactCutoff, BATCH);
    redacted += n;
    if (n < BATCH) break;
  }
  metrics.redacted = redacted;

  // 3. Zero-overdue invariant (TTL + 24h grace).
  const overdueCutoff = iso(new Date(ctx.now.getTime() - OVERDUE_GRACE_MS));
  const overdue = await ctx.deps.results.countOverdue(q, overdueCutoff);
  metrics.overdue = overdue;
  if (overdue > 0) {
    throw new Error(`ttl-purge: ${overdue} result row(s) alive past TTL+24h grace (Success Metric 10 breach)`);
  }
});
