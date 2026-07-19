// M8 + m7 — DB-backed exactly-once billing & credit-back guards (D11/D13).
//
// These exercise the REAL LedgerRepo SQL and the partial unique indexes against a throwaway
// Neon branch (DATABASE_URL_TEST). The worker/api unit suites only drive a hand-written fake
// that re-implements ON CONFLICT dedup; dropping `uq_ledger_attempt` / `uq_ledger_creditback`
// or changing the ON CONFLICT target would double-bill / double-refund with those green.
// Skipped (never failed) when DATABASE_URL_TEST is absent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { TenantId, RequestId } from '@mailmetero/contracts';
import { hasDb, requireDb, skipUnlessDb } from '../../../tools/test/setup-integration.ts';
import { createLedgerRepo } from '../src/repositories/usage-ledger.ts';
import type { BillingDecision } from '../src/billing/policy.ts';

let pool: Pool;
const tenants: string[] = [];
const domains: string[] = [];

before(() => {
  if (hasDb) pool = new Pool({ connectionString: requireDb(), max: 4 });
});

after(async () => {
  if (!pool) return;
  if (tenants.length > 0) {
    // FK ON DELETE CASCADE tears down usage_ledger / results for each tenant.
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]);
  }
  if (domains.length > 0) {
    await pool.query(`DELETE FROM kb.domains WHERE domain = ANY($1::text[])`, [domains]);
  }
  await pool.end();
});

async function makeTenant(credits: number): Promise<TenantId> {
  const r = await pool.query(
    `INSERT INTO tenants (owner_email, credits_remaining) VALUES ($1, $2) RETURNING id`,
    [`ledger-${randomUUID()}@test.invalid`, credits],
  );
  const id = r.rows[0].id as string;
  tenants.push(id);
  return id as TenantId;
}

const billableFinder: BillingDecision = {
  billable: true,
  creditsDelta: -1,
  reason: 'finder_score_ge_min',
};

test('M8: recordAttempt is exactly-once on (tenant,request_id) — one row, debit once', async (t) => {
  if (skipUnlessDb(t)) return;
  const ledger = createLedgerRepo();
  const tenantId = await makeTenant(100);
  const requestId = randomUUID() as RequestId;

  const input = {
    tenantId,
    requestId,
    endpoint: 'finder' as const,
    decision: billableFinder,
    resultStatus: 'valid' as const,
    resultSubStatus: null,
    resultScore: 80,
    backend: 'api' as const,
    evidence: 'learned_pattern' as const,
    resultId: null,
  };

  // Mirror the correct settle flow (worker path): recordAttempt + conditional debit driven by
  // the ledger's RETURNED delta, both inside one transaction. Run it twice with the same
  // (tenant, request_id) — a retry must not move a second credit.
  async function settleOnce(): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { creditsDeltaApplied } = await ledger.recordAttempt(client, input);
      if (creditsDeltaApplied < 0) {
        await client.query(
          `UPDATE tenants SET credits_remaining = credits_remaining + $2 WHERE id = $1`,
          [tenantId, creditsDeltaApplied],
        );
      }
      await client.query('COMMIT');
      return creditsDeltaApplied;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const first = await settleOnce();
  const second = await settleOnce();

  assert.equal(first, -1, 'first attempt applies the debit');
  assert.equal(second, 0, 'retry applies no further debit (ON CONFLICT DO NOTHING)');

  const rowsRes = await pool.query(
    `SELECT count(*)::int AS n FROM usage_ledger
      WHERE tenant_id = $1 AND request_id = $2 AND kind = 'attempt'`,
    [tenantId, requestId],
  );
  assert.equal(rowsRes.rows[0].n, 1, 'exactly one attempt ledger row');

  const bal = await pool.query(`SELECT credits_remaining FROM tenants WHERE id = $1`, [tenantId]);
  assert.equal(bal.rows[0].credits_remaining, 99, 'balance debited exactly once (100 → 99)');

  // The partial unique index is what makes the retry a physical no-op — assert it exists.
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_ledger_attempt'`,
  );
  assert.equal(idx.rows.length, 1, 'uq_ledger_attempt partial unique index exists');
  assert.match(idx.rows[0].indexdef, /UNIQUE/);
  assert.match(idx.rows[0].indexdef, /\(tenant_id, request_id\)/);
  assert.match(idx.rows[0].indexdef, /kind = 'attempt'/);
});

test('m7: issueCreditBack is idempotent; findCreditBackCandidates excludes credited attempts', async (t) => {
  if (skipUnlessDb(t)) return;
  const ledger = createLedgerRepo();
  const tenantId = await makeTenant(100);
  const requestId = randomUUID() as RequestId;
  const domain = `catchall-${randomUUID()}.test`;
  domains.push(domain);

  // A confirmed catch-all domain makes the billed attempt a credit-back candidate.
  await pool.query(
    `INSERT INTO kb.domains (domain, is_catch_all) VALUES ($1, true)`,
    [domain],
  );

  // A result row the ledger attempt points at (findCreditBackCandidates JOINs results → domain).
  const resultRes = await pool.query(
    `INSERT INTO results
       (tenant_id, request_id, endpoint, request_hash, input_domain, status, score,
        reason_codes, backend, evidence, expires_at)
     VALUES ($1, $2, 'verifier', $3, $4, 'valid', 90, ARRAY['ok'], 'api', 'verified',
             now() + interval '90 days')
     RETURNING id`,
    [tenantId, requestId, `hash-${randomUUID()}`, domain],
  );
  const resultId = resultRes.rows[0].id as string;

  // A billable attempt referencing that result.
  const { ledgerId } = await ledger.recordAttempt(pool, {
    tenantId,
    requestId,
    endpoint: 'verifier',
    decision: { billable: true, creditsDelta: -1, reason: 'verifier_definitive' },
    resultStatus: 'valid',
    resultSubStatus: 'ok',
    resultScore: 90,
    backend: 'api',
    evidence: 'verified',
    resultId,
  });
  assert.notEqual(ledgerId, '', 'attempt inserted');

  // Before crediting, the attempt is a candidate.
  const before1 = await ledger.findCreditBackCandidates(pool, 30, 500);
  assert.ok(
    before1.some((c) => c.ledgerId === ledgerId),
    'billed attempt on a now-catch-all domain is a credit-back candidate',
  );

  // Credit back twice — the partial unique index must make the second a no-op.
  const r1 = await ledger.issueCreditBack(pool, ledgerId, 'domain_now_catch_all');
  const r2 = await ledger.issueCreditBack(pool, ledgerId, 'domain_now_catch_all');
  assert.equal(r1.applied, true, 'first credit-back applies');
  assert.equal(r2.applied, false, 'second credit-back is a no-op (ON CONFLICT DO NOTHING)');

  const cbCount = await pool.query(
    `SELECT count(*)::int AS n FROM usage_ledger
      WHERE original_ledger_id = $1 AND kind = 'credit_back'`,
    [ledgerId],
  );
  assert.equal(cbCount.rows[0].n, 1, 'exactly one credit_back row for the attempt');

  // After crediting, the attempt is excluded from candidates (NOT EXISTS credit_back guard).
  const after1 = await ledger.findCreditBackCandidates(pool, 30, 500);
  assert.ok(
    !after1.some((c) => c.ledgerId === ledgerId),
    'already-credited attempt is excluded from candidates',
  );

  // The credit-back partial unique index is the physical guard — assert it exists.
  const idx = await pool.query(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_ledger_creditback'`,
  );
  assert.equal(idx.rows.length, 1, 'uq_ledger_creditback partial unique index exists');
  assert.match(idx.rows[0].indexdef, /UNIQUE/);
  assert.match(idx.rows[0].indexdef, /kind = 'credit_back'/);
});
