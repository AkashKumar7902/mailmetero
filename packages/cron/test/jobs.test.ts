// @mailmetero/cron — unit tests. Faked repos / pools; no real Postgres, no egress.
//
// Covers: the defineCronJob harness (timing + error capture + metric preservation), each of the
// seven jobs' core behavior, and the dispatcher registry completeness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineCronJob,
  ttlPurgeJob,
  stuckJobSweepJob,
  quotaSpendResetJob,
  creditBackSweepJob,
  quotaAlertJob,
  blocklistSyncJob,
  objectionExpiryJob,
  CRON_JOBS,
  CRON_JOB_NAMES,
  isCronJobName,
} from '../src/index.ts';

// ── fakes ────────────────────────────────────────────────────────────────────

function noopLogger() {
  const fn = () => {};
  const logger = { info: fn, error: fn, warn: fn, debug: fn, trace: fn, fatal: fn, silent: fn };
  return { ...logger, child: () => logger };
}

/** A fake Pool usable both as a bare Queryable (`.query`) and by withTransaction (`.connect`). */
function fakePool(queryImpl = async () => ({ rows: [], rowCount: 0 })) {
  const client = { query: queryImpl, release: () => {} };
  return { query: queryImpl, connect: async () => client };
}

function makeCtx(overrides = {}) {
  const o = overrides;
  const deps = {
    pools: { web: fakePool(), direct: o.direct ?? fakePool() },
    results: o.results ?? {},
    ledger: o.ledger ?? {},
    jobs: o.jobs ?? {},
    tenants: o.tenants ?? {},
    objections: o.objections ?? {},
    idempotency: {},
    email:
      o.email ?? { kind: 'noop', send: async () => ({ providerMessageId: 'noop', accepted: true }) },
    vendorDir: o.vendorDir ?? tmpdir(),
  };
  return { now: o.now ?? new Date('2026-07-19T00:00:00.000Z'), logger: noopLogger(), deps };
}

// ── harness ──────────────────────────────────────────────────────────────────

test('defineCronJob: success report carries metrics, duration, ok:true, no error', async () => {
  const job = defineCronJob('ttl-purge', async (_ctx, metrics) => {
    metrics.answer = 42;
  });
  const report = await job.run(makeCtx());
  assert.equal(report.job, 'ttl-purge');
  assert.equal(report.ok, true);
  assert.equal(report.metrics.answer, 42);
  assert.equal(typeof report.durationMs, 'number');
  assert.ok(report.durationMs >= 0);
  assert.equal(report.error, undefined);
});

test('defineCronJob: a throwing body yields ok:false and preserves partial metrics', async () => {
  const job = defineCronJob('ttl-purge', async (_ctx, metrics) => {
    metrics.progress = 7;
    throw new Error('boom');
  });
  const report = await job.run(makeCtx());
  assert.equal(report.ok, false);
  assert.equal(report.error, 'boom');
  assert.equal(report.metrics.progress, 7); // partial progress survived
});

// ── ttl-purge ──────────────────────────────────────────────────────────────

test('ttl-purge: batches purge until a short batch, redacts ledger, asserts zero overdue', async () => {
  const purgeReturns = [1000, 1000, 300];
  let purgeCall = 0;
  const results = {
    purgeExpired: async () => purgeReturns[purgeCall++] ?? 0,
    countOverdue: async () => 0,
  };
  const ledger = { redactPastTtl: async () => 0 };
  const report = await ttlPurgeJob.run(makeCtx({ results, ledger }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.purged, 2300);
  assert.equal(report.metrics.redacted, 0);
  assert.equal(report.metrics.overdue, 0);
  assert.equal(purgeCall, 3); // stopped on the 300-row short batch
});

test('ttl-purge: nonzero overdue count fails the job (Success Metric 10 breach)', async () => {
  const results = {
    purgeExpired: async () => 0,
    countOverdue: async () => 5,
  };
  const ledger = { redactPastTtl: async () => 0 };
  const report = await ttlPurgeJob.run(makeCtx({ results, ledger }));
  assert.equal(report.ok, false);
  assert.equal(report.metrics.overdue, 5);
  assert.match(report.error ?? '', /past TTL\+24h/);
});

// ── stuck-job-sweep ──────────────────────────────────────────────────────────

test('stuck-job-sweep: surfaces requeued/failed counts', async () => {
  let called = false;
  const jobs = {
    sweepStuck: async (_q, _now, maxAttempts, backoffMs) => {
      called = true;
      assert.equal(typeof maxAttempts, 'number');
      assert.equal(typeof backoffMs, 'number');
      return { requeued: 3, failed: 1 };
    },
  };
  const report = await stuckJobSweepJob.run(makeCtx({ jobs }));
  assert.ok(called);
  assert.equal(report.ok, true);
  assert.equal(report.metrics.requeued, 3);
  assert.equal(report.metrics.failed, 1);
});

// ── quota-spend-reset ────────────────────────────────────────────────────────

test('quota-spend-reset: resets quotas and prunes old spend rows', async () => {
  const tenants = { resetQuotas: async () => 12 };
  let deleteSql = '';
  const direct = fakePool(async (sql) => {
    deleteSql = sql;
    return { rows: [], rowCount: 4 };
  });
  const report = await quotaSpendResetJob.run(makeCtx({ tenants, direct }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.tenantsReset, 12);
  assert.equal(report.metrics.spendRowsPruned, 4);
  assert.match(deleteSql, /DELETE FROM ops\.verifier_spend/);
});

// ── credit-back-sweep ────────────────────────────────────────────────────────

test('credit-back-sweep: refunds new credit-backs only, never double-refunds', async () => {
  const candidates = [
    { ledgerId: 'l1', tenantId: 't1', resultId: 'r1', billedOn: '2026-07-01', reason: 'domain_now_catch_all' },
    { ledgerId: 'l2', tenantId: 't2', resultId: 'r2', billedOn: '2026-07-02', reason: 'domain_now_catch_all' },
  ];
  const issued = [];
  const creditedBack = [];
  const ledger = {
    findCreditBackCandidates: async () => candidates,
    // l1 is a fresh credit-back; l2 already credited (applied:false).
    issueCreditBack: async (_tx, ledgerId) => {
      issued.push(ledgerId);
      return ledgerId === 'l1'
        ? { creditBackId: 'cb1', applied: true }
        : { creditBackId: '', applied: false };
    },
  };
  const tenants = {
    creditBack: async (_tx, tenantId, credits) => {
      creditedBack.push([tenantId, credits]);
      return 99;
    },
  };
  const report = await creditBackSweepJob.run(makeCtx({ ledger, tenants, direct: fakePool() }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.candidates, 2);
  assert.equal(report.metrics.credited, 1);
  assert.equal(report.metrics.skipped, 1);
  assert.deepEqual(issued, ['l1', 'l2']);
  assert.deepEqual(creditedBack, [['t1', 1]]); // only the applied one restored the balance
});

// ── quota-alert ──────────────────────────────────────────────────────────────

test('quota-alert: emails at the 80% and 100% thresholds only', async () => {
  const tenantRows = [
    // 100/100 = 100% → full alert
    { id: 't-full', owner_email: 'full@x.com', plan_name: 'free', search_quota: 50, verify_quota: 50, quota_period_start: '2026-07-01T00:00:00Z' },
    // 90/100 = 90% → warn alert
    { id: 't-warn', owner_email: 'warn@x.com', plan_name: 'free', search_quota: 50, verify_quota: 50, quota_period_start: '2026-07-01T00:00:00Z' },
    // 50/100 = 50% → no alert
    { id: 't-ok', owner_email: 'ok@x.com', plan_name: 'free', search_quota: 50, verify_quota: 50, quota_period_start: '2026-07-01T00:00:00Z' },
  ];
  const billedByTenant = { 't-full': 100, 't-warn': 90, 't-ok': 50 };
  const direct = fakePool(async () => ({ rows: tenantRows, rowCount: tenantRows.length }));
  const ledger = {
    getPeriodBillable: async (_q, tenantId) => ({ billed: billedByTenant[tenantId], creditBacks: 0 }),
  };
  const sent = [];
  const email = {
    kind: 'noop',
    send: async (msg) => {
      sent.push(msg.to);
      return { providerMessageId: 'm', accepted: true };
    },
  };
  const report = await quotaAlertJob.run(makeCtx({ direct, ledger, email }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.tenantsScanned, 3);
  assert.equal(report.metrics.alerts100, 1);
  assert.equal(report.metrics.alerts80, 1);
  assert.equal(report.metrics.sendFailures, 0);
  assert.deepEqual(sent.sort(), ['full@x.com', 'warn@x.com']);
});

test('quota-alert: a send failure is counted, not fatal', async () => {
  const tenantRows = [
    { id: 't1', owner_email: 'a@x.com', plan_name: 'free', search_quota: 50, verify_quota: 50, quota_period_start: '2026-07-01T00:00:00Z' },
  ];
  const direct = fakePool(async () => ({ rows: tenantRows, rowCount: 1 }));
  const ledger = { getPeriodBillable: async () => ({ billed: 100, creditBacks: 0 }) };
  const email = {
    kind: 'noop',
    send: async () => {
      throw new Error('esp down');
    },
  };
  const report = await quotaAlertJob.run(makeCtx({ direct, ledger, email }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.sendFailures, 1);
  assert.equal(report.metrics.alerts100, 0);
});

// ── blocklist-sync ───────────────────────────────────────────────────────────

test('blocklist-sync: re-seeds classification tables from vendorDir with no egress', async () => {
  // Empty temp vendor dir → missing files are treated as empty lists (readLines swallows ENOENT).
  const vendorDir = mkdtempSync(join(tmpdir(), 'cron-vendor-'));
  const direct = fakePool(async () => ({ rows: [], rowCount: 0 }));
  const report = await blocklistSyncJob.run(makeCtx({ direct, vendorDir }));
  assert.equal(report.ok, true);
  for (const key of ['freemail', 'disposable', 'roles', 'typos']) {
    assert.equal(typeof report.metrics[key], 'number');
  }
});

// ── objection-expiry ─────────────────────────────────────────────────────────

test('objection-expiry: expires stale pending tokens', async () => {
  const objections = { expireStale: async () => 8 };
  const report = await objectionExpiryJob.run(makeCtx({ objections }));
  assert.equal(report.ok, true);
  assert.equal(report.metrics.expired, 8);
});

// ── dispatcher registry ──────────────────────────────────────────────────────

test('CRON_JOBS registry has exactly the seven names, each self-consistent', () => {
  assert.equal(CRON_JOB_NAMES.length, 7);
  assert.deepEqual(Object.keys(CRON_JOBS).sort(), [...CRON_JOB_NAMES].sort());
  for (const name of CRON_JOB_NAMES) {
    assert.equal(CRON_JOBS[name].name, name);
    assert.equal(typeof CRON_JOBS[name].run, 'function');
  }
});

test('isCronJobName guards argv input', () => {
  assert.equal(isCronJobName('ttl-purge'), true);
  assert.equal(isCronJobName('not-a-job'), false);
  assert.equal(isCronJobName(''), false);
});
