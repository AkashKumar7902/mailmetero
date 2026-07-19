// Per-item idempotency + billing correctness (the requeue-safety invariant, D11/D13).
//
// The stable per-item requestId `${job.requestId}:${rowIndex}` is the ledger's exactly-once key.
// Reprocessing the same item (a requeue) must NEVER double-bill and NEVER under-bill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleFinderItem, settleVerifierItem, itemRequestId } from '../src/item.ts';
import { makeFakes, makeJob, makeItem, fakePipeline, finderResult } from './fakes.ts';

test('itemRequestId is `${job.requestId}:${rowIndex}` and stable', () => {
  const job = makeJob('bulk_find');
  assert.equal(itemRequestId(job, 0), 'req-abc:0');
  assert.equal(itemRequestId(job, 7), 'req-abc:7');
  // Stable across calls (survives requeue).
  assert.equal(itemRequestId(job, 0), itemRequestId(job, 0));
});

test('finder item bills exactly once across a requeue (no double-bill)', async () => {
  const { deps, ledgerSpy, tenantSpy, jobsSpy } = makeFakes();
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'example.com' }, job);

  const first = await settleFinderItem(deps, job, item, 90);
  const second = await settleFinderItem(deps, job, item, 90); // requeue

  assert.equal(first, 'done');
  assert.equal(second, 'done');

  // The ledger's exactly-once key is the stable per-item requestId.
  assert.equal(ledgerSpy.attempts.length, 1, 'ledger attempt inserted exactly once');
  assert.equal(ledgerSpy.attempts[0]?.requestId, 'req-abc:0');
  assert.deepEqual(ledgerSpy.applied, [-1, 0], 'first pass applies -1, requeue applies 0');

  // The debit follows the ledger-applied delta → exactly one debit of 1 credit.
  assert.equal(tenantSpy.debits.length, 1, 'debited exactly once');
  assert.equal(tenantSpy.debits[0]?.credits, 1);

  // Result recorded both times with a STABLE resultId (no orphaned duplicates).
  assert.equal(jobsSpy.itemResults.length, 2);
  assert.equal(jobsSpy.itemResults[0]?.resultId, 'result-req-abc:0');
  assert.equal(jobsSpy.itemResults[1]?.resultId, 'result-req-abc:0');
});

test('verifier item bills exactly once across a requeue', async () => {
  const { deps, ledgerSpy, tenantSpy } = makeFakes();
  const job = makeJob('bulk_verify');
  const item = makeItem(3, { email: 'jane.doe@example.com' }, job);

  await settleVerifierItem(deps, job, item, 90);
  await settleVerifierItem(deps, job, item, 90);

  assert.equal(ledgerSpy.attempts.length, 1);
  assert.equal(ledgerSpy.attempts[0]?.requestId, 'req-abc:3');
  assert.equal(ledgerSpy.attempts[0]?.endpoint, 'verifier');
  assert.deepEqual(ledgerSpy.applied, [-1, 0]);
  assert.equal(tenantSpy.debits.length, 1);
});

test('non-billable finder outcome records an attempt but debits nothing', async () => {
  const { deps, ledgerSpy, tenantSpy } = makeFakes({
    pipeline: fakePipeline({
      find: async () => ({
        kind: 'ok',
        deferrable: false,
        result: {
          ...finderResult('example.com', 'jane.doe@example.com'),
          score: 40,
          status: 'unknown',
          evidence: 'prior_only',
        },
        billingInput: {
          endpoint: 'finder',
          status: 'unknown',
          subStatus: null,
          score: 40,
          backend: 'api',
          evidence: 'prior_only',
          hasEmail: true,
        },
      }),
    }),
  });
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'example.com' }, job);

  const outcome = await settleFinderItem(deps, job, item, 90);
  assert.equal(outcome, 'done');
  assert.equal(ledgerSpy.attempts.length, 1, 'attempt still recorded (usage tracking)');
  assert.deepEqual(ledgerSpy.applied, [0], 'free outcome applies 0');
  assert.equal(tenantSpy.debits.length, 0, 'no debit for a free outcome');
});

test('invalid finder domain is a permanent item failure (no ledger attempt)', async () => {
  const { deps, ledgerSpy, jobsSpy } = makeFakes();
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'not a domain !!' }, job);

  const outcome = await settleFinderItem(deps, job, item, 90);
  assert.equal(outcome, 'failed');
  assert.equal(ledgerSpy.attempts.length, 0);
  assert.equal(jobsSpy.itemErrors.length, 1);
  assert.equal(jobsSpy.itemErrors[0]?.itemId, 'item-0');
});

test('invalid verifier email is a permanent item failure', async () => {
  const { deps, ledgerSpy, jobsSpy } = makeFakes();
  const job = makeJob('bulk_verify');
  const item = makeItem(0, { email: 'nope' }, job);

  const outcome = await settleVerifierItem(deps, job, item, 90);
  assert.equal(outcome, 'failed');
  assert.equal(ledgerSpy.attempts.length, 0);
  assert.equal(jobsSpy.itemErrors.length, 1);
});

test('pipeline unavailable leaves the item pending for retry (no bill, no error record)', async () => {
  const { deps, ledgerSpy, jobsSpy } = makeFakes({
    pipeline: fakePipeline({ find: async () => ({ kind: 'unavailable' }) }),
  });
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'example.com' }, job);

  const outcome = await settleFinderItem(deps, job, item, 90);
  assert.equal(outcome, 'retry');
  assert.equal(ledgerSpy.attempts.length, 0);
  assert.equal(jobsSpy.itemResults.length, 0);
  assert.equal(jobsSpy.itemErrors.length, 0, 'stays pending — not marked failed');
});
