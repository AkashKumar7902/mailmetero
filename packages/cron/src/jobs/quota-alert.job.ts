// @mailmetero/cron — quota-alert (PRD §7; emails at 80% and 100% of quota).
//
// For each active tenant, compares period-to-date net billable usage against the plan quota and,
// when a threshold is crossed, sends the quota-alert email. There is no per-tenant alert-state
// table in v1, so this fires the alert for the highest crossed threshold on each run (at-most one
// email per tenant per run); dedupe across runs is a P1 concern noted here deliberately.
//
// TenantsRepo has no list-all method, so the active-tenant scan is a direct read off the pool.

import type { TenantId } from '@mailmetero/contracts';
import { rows } from '@mailmetero/db';
import { buildQuotaAlertEmail } from '@mailmetero/email';
import { defineCronJob } from '../job.ts';

const WARN_THRESHOLD_PCT = 80;
const FULL_THRESHOLD_PCT = 100;
/** Quota period length (PRD: monthly reset). */
const QUOTA_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ActiveTenantRow {
  id: string;
  owner_email: string;
  plan_name: string;
  search_quota: number;
  verify_quota: number;
  quota_period_start: string;
}

function resetDate(periodStart: string): string {
  const start = new Date(periodStart);
  const reset = new Date(start.getTime() + QUOTA_PERIOD_DAYS * DAY_MS);
  return reset.toISOString().slice(0, 10);
}

export const quotaAlertJob = defineCronJob('quota-alert', async (ctx, metrics) => {
  const q = ctx.deps.pools.direct;

  const tenants = await rows<ActiveTenantRow>(
    q,
    `SELECT id, owner_email, plan_name, search_quota, verify_quota, quota_period_start
       FROM tenants
      WHERE status = 'active'`,
  );
  metrics.tenantsScanned = tenants.length;

  let alerts80 = 0;
  let alerts100 = 0;
  let sendFailures = 0;

  for (const t of tenants) {
    const quota = t.search_quota + t.verify_quota;
    if (quota <= 0) continue;

    const periodStart = t.quota_period_start.slice(0, 10);
    const { billed, creditBacks } = await ctx.deps.ledger.getPeriodBillable(q, t.id as TenantId, periodStart);
    const netBilled = Math.max(0, billed - creditBacks);
    const usedPct = (netBilled / quota) * 100;

    if (usedPct < WARN_THRESHOLD_PCT) continue;

    const isFull = usedPct >= FULL_THRESHOLD_PCT;
    const msg = buildQuotaAlertEmail({
      to: t.owner_email,
      planName: t.plan_name,
      usedPct,
      resetDate: resetDate(t.quota_period_start),
    });

    try {
      await ctx.deps.email.send(msg);
      if (isFull) alerts100 += 1;
      else alerts80 += 1;
    } catch (err) {
      sendFailures += 1;
      ctx.logger.error(
        { job: 'quota-alert', tenantId: t.id, err: err instanceof Error ? err.message : String(err) },
        'quota-alert email send failed',
      );
    }
  }

  metrics.alerts80 = alerts80;
  metrics.alerts100 = alerts100;
  metrics.sendFailures = sendFailures;
});
