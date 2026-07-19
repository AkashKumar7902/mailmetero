// @mailmetero/db — SpendGuard + VerifierPolicyRepo (D12; single kill switch, cents).
//
// Spend is tracked in ops.verifier_spend as a per-tenant row and a global aggregate row
// (scope_tenant_id NULL). The single ops.verifier_policy singleton holds the kill switch and
// the global daily cap. `check` short-circuits kill_switch → global_cap → tenant_cap.

import type { TenantId } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne } from '../client.ts';

function dayStr(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export type SpendDenyReason = 'kill_switch' | 'global_cap' | 'tenant_cap';

export interface SpendGuard {
  check(
    q: Queryable,
    tenantId: TenantId,
    tenantDailyCapCents: number | null,
    day: Date,
  ): Promise<{ allowed: true } | { allowed: false; reason: SpendDenyReason }>;
  record(q: Queryable, tenantId: TenantId, cents: number, day: Date): Promise<void>;
}

export interface VerifierPolicyRepo {
  getPolicy(q: Queryable): Promise<{ killSwitchEnabled: boolean; globalDailyCapCents: number | null }>;
  setKillSwitch(q: Queryable, enabled: boolean, updatedBy: string): Promise<void>;
  setGlobalDailyCap(q: Queryable, capCents: number | null, updatedBy: string): Promise<void>;
}

export function makeVerifierPolicyRepo(): VerifierPolicyRepo {
  return {
    async getPolicy(q) {
      const row = await maybeOne<{ kill_switch_enabled: boolean; global_daily_cap_cents: number | null }>(
        q,
        `SELECT kill_switch_enabled, global_daily_cap_cents FROM ops.verifier_policy WHERE id = 1`,
      );
      return {
        killSwitchEnabled: row ? row.kill_switch_enabled : false,
        globalDailyCapCents: row ? row.global_daily_cap_cents : null,
      };
    },

    async setKillSwitch(q, enabled, updatedBy) {
      await q.query(
        `UPDATE ops.verifier_policy SET kill_switch_enabled = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
        [enabled, updatedBy],
      );
    },

    async setGlobalDailyCap(q, capCents, updatedBy) {
      await q.query(
        `UPDATE ops.verifier_policy SET global_daily_cap_cents = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
        [capCents, updatedBy],
      );
    },
  };
}

export function makeSpendGuard(): SpendGuard {
  const policy = makeVerifierPolicyRepo();
  return {
    async check(q, tenantId, tenantDailyCapCents, day) {
      const pol = await policy.getPolicy(q);
      if (pol.killSwitchEnabled) return { allowed: false, reason: 'kill_switch' };

      const d = dayStr(day);
      if (pol.globalDailyCapCents !== null) {
        const g = await maybeOne<{ spend_cents: number }>(
          q,
          `SELECT spend_cents FROM ops.verifier_spend WHERE scope_tenant_id IS NULL AND spend_date = $1`,
          [d],
        );
        if ((g ? g.spend_cents : 0) >= pol.globalDailyCapCents) return { allowed: false, reason: 'global_cap' };
      }

      if (tenantDailyCapCents !== null) {
        const t = await maybeOne<{ spend_cents: number }>(
          q,
          `SELECT spend_cents FROM ops.verifier_spend WHERE scope_tenant_id = $1 AND spend_date = $2`,
          [tenantId, d],
        );
        if ((t ? t.spend_cents : 0) >= tenantDailyCapCents) return { allowed: false, reason: 'tenant_cap' };
      }

      return { allowed: true };
    },

    async record(q, tenantId, cents, day) {
      const d = dayStr(day);
      // Per-tenant row.
      await q.query(
        `INSERT INTO ops.verifier_spend (scope_tenant_id, spend_date, spend_cents, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (scope_tenant_id, spend_date)
           DO UPDATE SET spend_cents = ops.verifier_spend.spend_cents + EXCLUDED.spend_cents, updated_at = now()`,
        [tenantId, d, cents],
      );
      // Global aggregate row (scope_tenant_id NULL; matched via NULLS NOT DISTINCT index).
      await q.query(
        `INSERT INTO ops.verifier_spend (scope_tenant_id, spend_date, spend_cents, updated_at)
         VALUES (NULL, $1, $2, now())
         ON CONFLICT (scope_tenant_id, spend_date)
           DO UPDATE SET spend_cents = ops.verifier_spend.spend_cents + EXCLUDED.spend_cents, updated_at = now()`,
        [d, cents],
      );
    },
  };
}
