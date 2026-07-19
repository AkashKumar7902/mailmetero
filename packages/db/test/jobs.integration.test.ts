// M11 — FOR UPDATE SKIP LOCKED job-claim exclusivity (D4/D20), against a throwaway Neon branch.
//
// The worker loop suite drives a scripted fake claim(); the real
// `UPDATE jobs … FROM (SELECT … FOR UPDATE SKIP LOCKED)` never runs there. Two workers must
// never claim the same job, only queued rows whose run_after has arrived are eligible, and each
// claim increments attempts + stamps locked_by. Dropping SKIP LOCKED, the
// `run_after <= now()` / `status='queued'` predicate, or the attempts bump would ship green
// without this. Skipped (never failed) when DATABASE_URL_TEST is absent.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { TenantId } from '@mailmetero/contracts';
import { hasDb, requireDb, skipUnlessDb } from '../../../tools/test/setup-integration.ts';
import { createJobsRepo } from '../src/repositories/jobs.ts';

let pool: Pool;
const tenants: string[] = [];

before(() => {
  if (hasDb) pool = new Pool({ connectionString: requireDb(), max: 6 });
});

after(async () => {
  if (!pool) return;
  if (tenants.length > 0) {
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::uuid[])`, [tenants]); // cascades jobs
  }
  await pool.end();
});

async function makeTenant(): Promise<TenantId> {
  const r = await pool.query(
    `INSERT INTO tenants (owner_email) VALUES ($1) RETURNING id`,
    [`jobs-${randomUUID()}@test.invalid`],
  );
  const id = r.rows[0].id as string;
  tenants.push(id);
  return id as TenantId;
}

/** Insert a queued job; `future` pushes run_after 1h ahead so it must NOT be claimable now. */
async function insertJob(tenantId: TenantId, future: boolean): Promise<string> {
  const r = await pool.query(
    `INSERT INTO jobs (tenant_id, kind, status, total, request_id, run_after)
     VALUES ($1, 'async_verify', 'queued', 1, $2,
             now() ${future ? "+ interval '1 hour'" : "- interval '1 second'"})
     RETURNING id`,
    [tenantId, randomUUID()],
  );
  return r.rows[0].id as string;
}

test('M11: two concurrent claim() calls get disjoint sets; future run_after excluded', async (t) => {
  if (skipUnlessDb(t)) return;
  const jobs = createJobsRepo();
  const tenantId = await makeTenant();

  const N = 12; // claimable now
  const F = 4; // run_after in the future — must stay queued
  const claimable = new Set<string>();
  const future = new Set<string>();
  for (let i = 0; i < N; i++) claimable.add(await insertJob(tenantId, false));
  for (let i = 0; i < F; i++) future.add(await insertJob(tenantId, true));

  // Drain every currently-ready queued job across two concurrent workers with a generous budget,
  // so all N of THIS test's ready jobs are definitely claimed. The branch may already hold
  // unrelated queued jobs; the SKIP LOCKED exclusivity invariant we assert holds regardless, and
  // we restore any non-test job we happen to drain so the run leaves no residue (isolation-safe on
  // a shared branch, though a dedicated Neon test branch is still preferred).
  const BUDGET = 10_000;
  const [a, b] = await Promise.all([
    jobs.claim(pool, 'worker-A', BUDGET, 30_000),
    jobs.claim(pool, 'worker-B', BUDGET, 30_000),
  ]);

  const setA = new Set(a.map((j) => String(j.id)));
  const setB = new Set(b.map((j) => String(j.id)));

  // (1) SKIP LOCKED exclusivity: no job claimed by BOTH workers; no duplicate within a result.
  for (const id of setA) assert.ok(!setB.has(id), `job ${id} claimed by BOTH workers`);
  assert.equal(setA.size, a.length, 'no duplicate ids within worker-A result');
  assert.equal(setB.size, b.length, 'no duplicate ids within worker-B result');

  // (2) Every one of THIS test's ready jobs was claimed by exactly one worker.
  for (const id of claimable) {
    const inA = setA.has(id);
    const inB = setB.has(id);
    assert.ok(inA !== inB, `ready job ${id} must be claimed by exactly one worker (A=${inA} B=${inB})`);
  }

  // (3) None of THIS test's future-run_after jobs were claimed.
  for (const id of future) {
    assert.ok(!setA.has(id) && !setB.has(id), `future-run_after job ${id} must not be claimed`);
  }

  // (4) Each of this test's claimed rows is stamped correctly.
  const ours = [...a, ...b].filter((j) => claimable.has(String(j.id)));
  assert.equal(ours.length, N, "exactly this test's N ready jobs came back claimed");
  for (const j of ours) {
    assert.equal(j.status, 'claimed', 'claimed status set');
    assert.ok(j.lockedBy === 'worker-A' || j.lockedBy === 'worker-B', 'locked_by stamped');
    assert.equal(j.attempts, 1, 'attempts incremented by the claim');
  }

  // Restore any FOREIGN jobs we drained (not this test's) so the shared branch is left as found.
  const foreignIds = [...setA, ...setB].filter((id) => !claimable.has(id));
  if (foreignIds.length > 0) {
    await pool.query(
      `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
              locked_by = NULL, locked_at = NULL, visibility_deadline = NULL
        WHERE id = ANY($1::uuid[])`,
      [foreignIds],
    );
  }

  // The future jobs remain untouched in the DB.
  const futRows = await pool.query(
    `SELECT id, status, attempts, locked_by FROM jobs WHERE id = ANY($1::uuid[])`,
    [[...future]],
  );
  assert.equal(futRows.rows.length, F);
  for (const row of futRows.rows) {
    assert.equal(row.status, 'queued', 'future job still queued');
    assert.equal(row.attempts, 0, 'future job never had attempts bumped');
    assert.equal(row.locked_by, null, 'future job never locked');
  }
});
