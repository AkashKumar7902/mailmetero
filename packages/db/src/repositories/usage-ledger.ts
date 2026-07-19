// @mailmetero/db — LedgerRepo (outcome-conditional billing, D11/D13).
//
// The ledger is the exactly-once billing spine. `recordAttempt` is idempotent on
// (tenant_id, request_id) via the partial unique index — a retried request physically
// cannot double-bill. Credit-backs are unique per originating attempt. Person fields
// (result_id) are nulled on TTL redaction.

import type { TenantId, RequestId, Status, SubStatus, Backend, EvidenceTier, IsoTimestamp } from '@mailmetero/contracts';
import type { UsageInfo } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rows, rowCount } from '../client.ts';
import type { LedgerEndpoint } from '../types.ts';
import type { BillingDecision } from '../billing/policy.ts';

export interface LedgerRepo {
  recordAttempt(
    q: Queryable,
    input: {
      tenantId: TenantId;
      requestId: RequestId;
      endpoint: LedgerEndpoint;
      decision: BillingDecision;
      resultStatus: Status;
      resultSubStatus: SubStatus | null;
      resultScore: number;
      backend: Backend;
      evidence: EvidenceTier;
      resultId: string | null;
    },
  ): Promise<{ ledgerId: string; creditsDeltaApplied: number }>;
  issueCreditBack(
    q: Queryable,
    originalLedgerId: string,
    downgradeReason: string,
  ): Promise<{ creditBackId: string; applied: boolean }>;
  findCreditBackCandidates(
    q: Queryable,
    withinDays: number,
    limit: number,
  ): Promise<Array<{ ledgerId: string; tenantId: TenantId; resultId: string | null; billedOn: string; reason: string }>>;
  getUsage(q: Queryable, tenantId: TenantId, from: string | null, to: string | null): Promise<UsageInfo>;
  getPeriodBillable(q: Queryable, tenantId: TenantId, periodStart: string): Promise<{ billed: number; creditBacks: number }>;
  redactPastTtl(q: Queryable, cutoff: IsoTimestamp, limit: number): Promise<number>;
}

export function createLedgerRepo(): LedgerRepo {
  return {
    async recordAttempt(q, input) {
      const inserted = await maybeOne<{ id: string; credits_delta: number }>(
        q,
        `INSERT INTO usage_ledger
           (tenant_id, request_id, kind, endpoint, billable, credits_delta,
            result_status, result_sub_status, result_score, backend, evidence, billed_reason, result_id)
         VALUES ($1,$2,'attempt',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, request_id) WHERE kind = 'attempt' DO NOTHING
         RETURNING id, credits_delta`,
        [
          input.tenantId, input.requestId, input.endpoint, input.decision.billable, input.decision.creditsDelta,
          input.resultStatus, input.resultSubStatus, input.resultScore, input.backend, input.evidence,
          input.decision.reason, input.resultId,
        ],
      );
      if (inserted !== null) {
        return { ledgerId: inserted.id, creditsDeltaApplied: inserted.credits_delta };
      }
      // Conflict: the attempt already exists (retry). Return its id; no new delta applied.
      const existing = await maybeOne<{ id: string }>(
        q,
        `SELECT id FROM usage_ledger WHERE tenant_id = $1 AND request_id = $2 AND kind = 'attempt' LIMIT 1`,
        [input.tenantId, input.requestId],
      );
      return { ledgerId: existing ? existing.id : '', creditsDeltaApplied: 0 };
    },

    async issueCreditBack(q, originalLedgerId, downgradeReason) {
      const row = await maybeOne<{ id: string }>(
        q,
        `INSERT INTO usage_ledger
           (tenant_id, request_id, kind, endpoint, billable, credits_delta,
            original_ledger_id, downgrade_reason, occurred_on)
         SELECT a.tenant_id, a.request_id, 'credit_back', a.endpoint, false, 1,
                a.id, $2, (now() AT TIME ZONE 'utc')::date
           FROM usage_ledger a
          WHERE a.id = $1 AND a.kind = 'attempt'
         ON CONFLICT (original_ledger_id) WHERE kind = 'credit_back' DO NOTHING
         RETURNING id`,
        [originalLedgerId, downgradeReason],
      );
      return row !== null ? { creditBackId: row.id, applied: true } : { creditBackId: '', applied: false };
    },

    async findCreditBackCandidates(q, withinDays, limit) {
      // Billable finder/verify attempts whose domain has since become a confirmed
      // catch-all / M365 (per-address deliverability unknowable) and not yet credited back.
      const rs = await rows<{
        ledger_id: string;
        tenant_id: string;
        result_id: string | null;
        billed_on: string;
        reason: string;
      }>(
        q,
        `SELECT a.id AS ledger_id, a.tenant_id, a.result_id, a.occurred_on::text AS billed_on,
                'domain_now_catch_all' AS reason
           FROM usage_ledger a
           JOIN results r  ON r.id = a.result_id
           JOIN kb.domains d ON d.domain = r.input_domain
          WHERE a.kind = 'attempt'
            AND a.billable = true
            AND a.occurred_on >= (now() AT TIME ZONE 'utc')::date - ($1::int)
            AND (d.is_catch_all = true OR d.provider = 'microsoft365')
            AND NOT EXISTS (
              SELECT 1 FROM usage_ledger cb
               WHERE cb.original_ledger_id = a.id AND cb.kind = 'credit_back')
          ORDER BY a.occurred_on
          LIMIT $2`,
        [withinDays, limit],
      );
      return rs.map((r) => ({
        ledgerId: r.ledger_id,
        tenantId: r.tenant_id as TenantId,
        resultId: r.result_id,
        billedOn: r.billed_on,
        reason: r.reason,
      }));
    },

    async getUsage(q, tenantId, from, to) {
      const agg = await maybeOne<{
        attempts: string;
        billable: string;
        credit_backs: string;
        credits_used: string;
      }>(
        q,
        `SELECT
            count(*) FILTER (WHERE kind = 'attempt')::text AS attempts,
            count(*) FILTER (WHERE kind = 'attempt' AND billable)::text AS billable,
            count(*) FILTER (WHERE kind = 'credit_back')::text AS credit_backs,
            COALESCE(-sum(credits_delta) FILTER (WHERE credits_delta < 0), 0)::text AS credits_used
           FROM usage_ledger
          WHERE tenant_id = $1
            AND ($2::date IS NULL OR occurred_on >= $2::date)
            AND ($3::date IS NULL OR occurred_on <= $3::date)`,
        [tenantId, from, to],
      );
      const byDay = await rows<{ date: string; attempts: string; billable: string; credit_backs: string }>(
        q,
        `SELECT occurred_on::text AS date,
                count(*) FILTER (WHERE kind = 'attempt')::text AS attempts,
                count(*) FILTER (WHERE kind = 'attempt' AND billable)::text AS billable,
                count(*) FILTER (WHERE kind = 'credit_back')::text AS credit_backs
           FROM usage_ledger
          WHERE tenant_id = $1
            AND ($2::date IS NULL OR occurred_on >= $2::date)
            AND ($3::date IS NULL OR occurred_on <= $3::date)
          GROUP BY occurred_on
          ORDER BY occurred_on`,
        [tenantId, from, to],
      );
      const balance = await maybeOne<{ credits_remaining: number }>(
        q,
        `SELECT credits_remaining FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return {
        credits_used: agg ? Number(agg.credits_used) : 0,
        credits_remaining: balance ? balance.credits_remaining : 0,
        attempts: agg ? Number(agg.attempts) : 0,
        billable: agg ? Number(agg.billable) : 0,
        credit_backs: agg ? Number(agg.credit_backs) : 0,
        by_day: byDay.map((d) => ({
          date: d.date,
          attempts: Number(d.attempts),
          billable: Number(d.billable),
          credit_backs: Number(d.credit_backs),
        })),
      };
    },

    async getPeriodBillable(q, tenantId, periodStart) {
      const row = await maybeOne<{ billed: string; credit_backs: string }>(
        q,
        `SELECT
            count(*) FILTER (WHERE kind = 'attempt' AND billable)::text AS billed,
            count(*) FILTER (WHERE kind = 'credit_back')::text AS credit_backs
           FROM usage_ledger
          WHERE tenant_id = $1 AND occurred_on >= $2::date`,
        [tenantId, periodStart],
      );
      return {
        billed: row ? Number(row.billed) : 0,
        creditBacks: row ? Number(row.credit_backs) : 0,
      };
    },

    async redactPastTtl(q, cutoff, limit) {
      return rowCount(
        q,
        `UPDATE usage_ledger SET result_id = NULL
          WHERE id IN (
            SELECT id FROM usage_ledger
             WHERE result_id IS NOT NULL AND created_at < $1
             ORDER BY created_at
             LIMIT $2)`,
        [cutoff, limit],
      );
    },
  };
}
