// @mailmetero/cron — objection-expiry (hourly; PRD §7 compliance pack).
//
// Marks stale 'pending' objection tokens 'expired' once past their TTL, so an unconfirmed public
// objection request cannot linger indefinitely. Hash-only table; no plaintext touched. Runs off
// the unpooled `direct` pool.

import { defineCronJob, iso } from '../job.ts';

export const objectionExpiryJob = defineCronJob('objection-expiry', async (ctx, metrics) => {
  const expired = await ctx.deps.objections.expireStale(ctx.deps.pools.direct, iso(ctx.now));
  metrics.expired = expired;
});
