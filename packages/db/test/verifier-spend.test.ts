// M12 — SpendGuard.check decision: kill_switch > global_cap > tenant_cap precedence and
// the `>=` cap boundary, exercised against a scripted fake Queryable (no DB needed).
//
// The guard is what decides whether the paid verifier backend is injected at all; the
// orchestrator tests only cover an already-degraded NullBackend, so this precedence/boundary
// logic was previously asserted nowhere. Dropping a short-circuit or flipping `>=` to `>`
// would over/under-spend real money with every test green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TenantId } from '@mailmetero/contracts';
import type { Queryable } from '../src/client.ts';
import { makeSpendGuard } from '../src/repositories/verifier-spend.ts';

interface Script {
  policy: { kill_switch_enabled: boolean; global_daily_cap_cents: number | null };
  /** null ⇒ no spend row exists (treated as 0 by the guard). */
  globalSpend?: number | null;
  tenantSpend?: number | null;
}

/** A fake Queryable that answers the guard's three queries from `script`, recording which ran. */
function fakeQ(script: Script): { q: Queryable; calls: string[] } {
  const calls: string[] = [];
  const q = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async query(text: string) {
      if (text.includes('verifier_policy')) {
        calls.push('policy');
        return { rows: [script.policy], rowCount: 1 };
      }
      if (text.includes('scope_tenant_id IS NULL')) {
        calls.push('global');
        const s = script.globalSpend ?? null;
        return { rows: s === null ? [] : [{ spend_cents: s }], rowCount: s === null ? 0 : 1 };
      }
      if (text.includes('scope_tenant_id = $1')) {
        calls.push('tenant');
        const s = script.tenantSpend ?? null;
        return { rows: s === null ? [] : [{ spend_cents: s }], rowCount: s === null ? 0 : 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { q: q as unknown as Queryable, calls };
}

const TENANT = 'tenant-1' as TenantId;
const DAY = new Date('2026-07-19T12:00:00.000Z');

test('kill switch denies regardless of spend, and short-circuits before any spend query', async () => {
  const guard = makeSpendGuard();
  // Kill on; caps present and spend WAY under them — kill must still win.
  const { q, calls } = fakeQ({
    policy: { kill_switch_enabled: true, global_daily_cap_cents: 1000 },
    globalSpend: 0,
    tenantSpend: 0,
  });
  const res = await guard.check(q, TENANT, 1000, DAY);
  assert.deepEqual(res, { allowed: false, reason: 'kill_switch' });
  assert.deepEqual(calls, ['policy']); // no spend lookups happened
});

test('global cap: at cap denies (>= boundary), one cent under allows', async () => {
  const guard = makeSpendGuard();

  // Exactly at the cap ⇒ denied (the `>=` boundary).
  const atCap = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 100 },
    globalSpend: 100,
  });
  assert.deepEqual(await guard.check(atCap.q, TENANT, null, DAY), { allowed: false, reason: 'global_cap' });

  // One under the cap ⇒ allowed (tenant cap null so global is the only gate).
  const underCap = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 100 },
    globalSpend: 99,
  });
  assert.deepEqual(await guard.check(underCap.q, TENANT, null, DAY), { allowed: true });
});

test('tenant cap: at cap denies (>= boundary), one cent under allows', async () => {
  const guard = makeSpendGuard();

  const atCap = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 1000 },
    globalSpend: 0,
    tenantSpend: 200,
  });
  assert.deepEqual(await guard.check(atCap.q, TENANT, 200, DAY), { allowed: false, reason: 'tenant_cap' });

  const underCap = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 1000 },
    globalSpend: 0,
    tenantSpend: 199,
  });
  assert.deepEqual(await guard.check(underCap.q, TENANT, 200, DAY), { allowed: true });
});

test('just-under both caps ⇒ allowed', async () => {
  const guard = makeSpendGuard();
  const { q } = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 100 },
    globalSpend: 99,
    tenantSpend: 199,
  });
  assert.deepEqual(await guard.check(q, TENANT, 200, DAY), { allowed: true });
});

test('precedence: global cap wins over tenant cap when both are at cap', async () => {
  const guard = makeSpendGuard();
  const { q, calls } = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 100 },
    globalSpend: 100,
    tenantSpend: 200,
  });
  const res = await guard.check(q, TENANT, 200, DAY);
  assert.deepEqual(res, { allowed: false, reason: 'global_cap' });
  // Tenant spend must never be consulted once the global gate already denied.
  assert.deepEqual(calls, ['policy', 'global']);
});

test('null caps skip their spend lookups entirely and allow', async () => {
  const guard = makeSpendGuard();
  const { q, calls } = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: null },
  });
  assert.deepEqual(await guard.check(q, TENANT, null, DAY), { allowed: true });
  assert.deepEqual(calls, ['policy']); // no global (cap null), no tenant (cap null)
});

test('missing spend rows are treated as zero spend ⇒ allowed', async () => {
  const guard = makeSpendGuard();
  const { q } = fakeQ({
    policy: { kill_switch_enabled: false, global_daily_cap_cents: 100 },
    globalSpend: null, // no row for the global aggregate today
    tenantSpend: null, // no row for the tenant today
  });
  assert.deepEqual(await guard.check(q, TENANT, 200, DAY), { allowed: true });
});
