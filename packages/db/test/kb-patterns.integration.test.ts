// M10 — D7 verified_count write-guard, DB-backed against a throwaway Neon branch.
//
// bumpVerified MUST NOT advance verified_count on an accept-all domain (a 250 from a catch-all
// proves nothing about the specific pattern), yet observed_count still bumps. Only the schema
// half of D7 was tested before; this exercises the real repo SQL on both branches and pins the
// verified_count <= observed_count invariant. Skipped (never failed) without DATABASE_URL_TEST.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { Domain, PatternToken } from '@mailmetero/contracts';
import { hasDb, requireDb, skipUnlessDb } from '../../../tools/test/setup-integration.ts';
import { createKbDomainPatternsRepo } from '../src/repositories/kb-patterns.ts';

let pool: Pool;
const domains: string[] = [];

before(() => {
  if (hasDb) pool = new Pool({ connectionString: requireDb(), max: 4 });
});

after(async () => {
  if (!pool) return;
  if (domains.length > 0) {
    await pool.query(`DELETE FROM kb.domain_patterns WHERE domain = ANY($1::text[])`, [domains]);
  }
  await pool.end();
});

async function readCounts(domain: string, pattern: string): Promise<{ observed: number; verified: number }> {
  const r = await pool.query(
    `SELECT observed_count, verified_count FROM kb.domain_patterns
      WHERE domain = $1 AND pattern_token = $2`,
    [domain, pattern],
  );
  assert.equal(r.rows.length, 1, 'pattern row exists');
  return { observed: r.rows[0].observed_count, verified: r.rows[0].verified_count };
}

test('M10: bumpVerified advances verified_count only when NOT accept-all, never above observed', async (t) => {
  if (skipUnlessDb(t)) return;
  const repo = createKbDomainPatternsRepo();
  const domain = `kb-${randomUUID()}.test`;
  domains.push(domain);
  const d = domain as Domain;
  const p = '{first}.{last}' as PatternToken;

  // Fresh insert on an ACCEPT-ALL domain: observed=1, verified stays 0.
  await repo.bumpVerified(pool, d, p, true);
  let c = await readCounts(domain, p);
  assert.deepEqual(c, { observed: 1, verified: 0 }, 'accept-all first-observe bumps observed only');
  assert.ok(c.verified <= c.observed);

  // Non-accept-all confirmation: observed=2, verified=1.
  await repo.bumpVerified(pool, d, p, false);
  c = await readCounts(domain, p);
  assert.deepEqual(c, { observed: 2, verified: 1 }, 'real verification advances verified_count');
  assert.ok(c.verified <= c.observed);

  // Accept-all again: observed=3, verified STAYS 1 (write-guard).
  await repo.bumpVerified(pool, d, p, true);
  c = await readCounts(domain, p);
  assert.deepEqual(c, { observed: 3, verified: 1 }, 'accept-all must not advance verified_count');
  assert.ok(c.verified <= c.observed);

  // Another real verification: observed=4, verified=2.
  await repo.bumpVerified(pool, d, p, false);
  c = await readCounts(domain, p);
  assert.deepEqual(c, { observed: 4, verified: 2 });
  assert.ok(c.verified <= c.observed, 'verified_count never exceeds observed_count');
});
