// @mailmetero/db — TenantsRepo.
//
// Owns the tenant row + the atomic credit ledger balance (`credits_remaining`) that the
// insufficient_credits pre-check and outcome-conditional billing debit against. All debits
// are a single conditional UPDATE (no read-modify-write race).

import type { TenantId, IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';
import type { Tenant } from '../types.ts';

interface TenantRaw {
  id: string;
  owner_email: string;
  plan_name: string;
  retention_days: number;
  search_quota: number;
  verify_quota: number;
  credits_remaining: number;
  daily_verifier_spend_cap_cents: number;
  quota_period_start: string;
  status: 'active' | 'suspended';
  created_at: string;
  updated_at: string;
}

function mapTenant(r: TenantRaw): Tenant {
  return {
    id: r.id as TenantId,
    ownerEmail: r.owner_email,
    planName: r.plan_name,
    retentionDays: r.retention_days,
    searchQuota: r.search_quota,
    verifyQuota: r.verify_quota,
    creditsRemaining: r.credits_remaining,
    dailyVerifierSpendCapCents: r.daily_verifier_spend_cap_cents,
    quotaPeriodStart: r.quota_period_start as IsoTimestamp,
    status: r.status,
    createdAt: r.created_at as IsoTimestamp,
    updatedAt: r.updated_at as IsoTimestamp,
  };
}

const SELECT = `
  SELECT id, owner_email, plan_name, retention_days, search_quota, verify_quota,
         credits_remaining, daily_verifier_spend_cap_cents, quota_period_start, status,
         created_at, updated_at
    FROM tenants`;

export interface TenantsRepo {
  create(
    q: Queryable,
    input: {
      ownerEmail: string;
      planName?: string;
      retentionDays?: number;
      searchQuota?: number;
      verifyQuota?: number;
      creditsRemaining?: number;
      dailyVerifierSpendCapCents?: number;
    },
  ): Promise<Tenant>;
  byId(q: Queryable, id: TenantId): Promise<Tenant | null>;
  byOwnerEmail(q: Queryable, email: string): Promise<Tenant | null>;
  /** Atomic debit; returns the new balance, or null if insufficient credits. */
  tryDebitCredit(q: Queryable, id: TenantId, credits: number): Promise<number | null>;
  creditBack(q: Queryable, id: TenantId, credits: number): Promise<number>;
  setStatus(q: Queryable, id: TenantId, status: Tenant['status']): Promise<void>;
  updateRetention(q: Queryable, id: TenantId, days: number): Promise<void>;
  /** Roll every tenant's quota period forward to `now`; returns rows reset. */
  resetQuotas(q: Queryable, now: IsoTimestamp): Promise<number>;
}

export function createTenantsRepo(): TenantsRepo {
  return {
    async create(q, input) {
      const row = await maybeOne<TenantRaw>(
        q,
        `INSERT INTO tenants
           (owner_email, plan_name, retention_days, search_quota, verify_quota,
            credits_remaining, daily_verifier_spend_cap_cents)
         VALUES ($1,
                 COALESCE($2,'free'),
                 COALESCE($3,90),
                 COALESCE($4,50),
                 COALESCE($5,50),
                 COALESCE($6,50),
                 COALESCE($7,500))
         RETURNING id, owner_email, plan_name, retention_days, search_quota, verify_quota,
                   credits_remaining, daily_verifier_spend_cap_cents, quota_period_start, status,
                   created_at, updated_at`,
        [
          input.ownerEmail,
          input.planName ?? null,
          input.retentionDays ?? null,
          input.searchQuota ?? null,
          input.verifyQuota ?? null,
          input.creditsRemaining ?? null,
          input.dailyVerifierSpendCapCents ?? null,
        ],
      );
      // INSERT ... RETURNING always yields exactly one row.
      return mapTenant(row as TenantRaw);
    },

    async byId(q, id) {
      const row = await maybeOne<TenantRaw>(q, `${SELECT} WHERE id = $1`, [id]);
      return row ? mapTenant(row) : null;
    },

    async byOwnerEmail(q, email) {
      const row = await maybeOne<TenantRaw>(q, `${SELECT} WHERE owner_email = $1`, [email]);
      return row ? mapTenant(row) : null;
    },

    async tryDebitCredit(q, id, credits) {
      const row = await maybeOne<{ credits_remaining: number }>(
        q,
        `UPDATE tenants
            SET credits_remaining = credits_remaining - $2,
                updated_at = now()
          WHERE id = $1 AND credits_remaining >= $2
        RETURNING credits_remaining`,
        [id, credits],
      );
      return row ? row.credits_remaining : null;
    },

    async creditBack(q, id, credits) {
      const row = await maybeOne<{ credits_remaining: number }>(
        q,
        `UPDATE tenants
            SET credits_remaining = credits_remaining + $2,
                updated_at = now()
          WHERE id = $1
        RETURNING credits_remaining`,
        [id, credits],
      );
      // A missing tenant returns null; treat as 0 (nothing credited).
      return row ? row.credits_remaining : 0;
    },

    async setStatus(q, id, status) {
      await q.query(`UPDATE tenants SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
    },

    async updateRetention(q, id, days) {
      await q.query(`UPDATE tenants SET retention_days = $2, updated_at = now() WHERE id = $1`, [id, days]);
    },

    async resetQuotas(q, now) {
      return rowCount(
        q,
        `UPDATE tenants SET quota_period_start = $1, updated_at = now()`,
        [now],
      );
    },
  };
}
