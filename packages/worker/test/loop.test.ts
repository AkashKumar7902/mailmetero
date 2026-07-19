// runWorkerLoop: claim → dispatch → complete, and the empty-claim idle backoff + clean shutdown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerLoop } from '../src/loop.ts';
import { makeFakes, makeJob, makeItem, testWorkerConfig } from './fakes.ts';

function later(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test('empty claim sleeps the idle backoff and the loop exits cleanly on abort', async () => {
  const { deps, jobsSpy } = makeFakes({ claimScript: [] }); // claim always returns []
  const controller = new AbortController();
  const loop = runWorkerLoop(testWorkerConfig, deps, controller.signal);

  await later(20);
  controller.abort();
  await loop; // must resolve — no hang

  assert.ok(jobsSpy.claims >= 1, 'polled the queue at least once');
  assert.equal(jobsSpy.completed.length, 0);
});

test('a claimed bulk_find job is marked running, settled, and completed', async () => {
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'example.com' }, job);
  const { deps, jobsSpy, ledgerSpy, tenantSpy } = makeFakes({
    claimScript: [[job]], // one job on the first claim, then empty
    pendingItems: () => [item],
  });

  const controller = new AbortController();
  const loop = runWorkerLoop(testWorkerConfig, deps, controller.signal);
  await later(40);
  controller.abort();
  await loop;

  assert.deepEqual(jobsSpy.markRunning, [job.id]);
  assert.deepEqual(jobsSpy.completed, [job.id]);
  assert.equal(jobsSpy.itemResults.length, 1, 'the item result was recorded');
  assert.equal(jobsSpy.itemResults[0]?.resultId, 'result-req-abc:0');
  assert.equal(ledgerSpy.attempts.length, 1);
  assert.equal(tenantSpy.debits.length, 1);
  assert.equal(jobsSpy.released.length, 0);
  assert.equal(jobsSpy.failed.length, 0);
});

test('a job whose items all need retry is released, not completed', async () => {
  const job = makeJob('bulk_find');
  const item = makeItem(0, { first_name: 'jane', last_name: 'doe', domain: 'example.com' }, job);
  const { deps, jobsSpy } = makeFakes({
    claimScript: [[job]],
    pendingItems: () => [item],
    pipeline: { find: async () => ({ kind: 'unavailable' }), verify: async () => ({ kind: 'unavailable' }) },
  });

  const controller = new AbortController();
  const loop = runWorkerLoop(testWorkerConfig, deps, controller.signal);
  await later(40);
  controller.abort();
  await loop;

  assert.equal(jobsSpy.completed.length, 0);
  assert.equal(jobsSpy.released.length, 1, 'released for retry (pending items remain)');
  assert.equal(jobsSpy.released[0]?.jobId, job.id);
});

// A pipeline that always throws a non-retryable error on the verify path.
const throwingPipeline = {
  find: async () => ({ kind: 'unavailable' as const }),
  verify: async () => {
    throw new Error('boom: transient db error');
  },
};

test('a non-retryable failure on the final attempt fails the job', async () => {
  // `claim` increments attempts to count the current execution, so the Nth (final) execution
  // of a maxAttempts=N job arrives with attempts === N. This is the exhausting attempt.
  const job = makeJob('bulk_verify', { attempts: 5, maxAttempts: 5 });
  const item = makeItem(0, { email: 'jane.doe@example.com' }, job);
  const { deps, jobsSpy } = makeFakes({
    claimScript: [[job]],
    pendingItems: () => [item],
    pipeline: throwingPipeline,
  });

  const controller = new AbortController();
  const loop = runWorkerLoop(testWorkerConfig, deps, controller.signal);
  await later(40);
  controller.abort();
  await loop;

  assert.equal(jobsSpy.completed.length, 0);
  assert.equal(jobsSpy.failed.length, 1, 'attempts exhausted → failJob');
  assert.equal(jobsSpy.failed[0]?.jobId, job.id);
  assert.equal(jobsSpy.released.length, 0, 'must not release on the final attempt');
});

test('maxAttempts=N allows N executions: the Nth attempt is not exhausted early', async () => {
  // The penultimate execution of a maxAttempts=5 job arrives with attempts === 4 (claim already
  // counted this execution). With the off-by-one bug, attemptsSoFar = 4 + 1 = 5 would exhaust the
  // budget here and fail the job — swallowing the final (5th) execution. The correct behavior is to
  // release for retry so the 5th attempt can still run.
  const job = makeJob('bulk_verify', { attempts: 4, maxAttempts: 5 });
  const item = makeItem(0, { email: 'jane.doe@example.com' }, job);
  const { deps, jobsSpy } = makeFakes({
    claimScript: [[job]],
    pendingItems: () => [item],
    pipeline: throwingPipeline,
  });

  const controller = new AbortController();
  const loop = runWorkerLoop(testWorkerConfig, deps, controller.signal);
  await later(40);
  controller.abort();
  await loop;

  assert.equal(jobsSpy.failed.length, 0, 'attempt 4 of 5 must not fail — the 5th execution is still owed');
  assert.equal(jobsSpy.released.length, 1, 'released for retry so the final attempt can run');
  assert.equal(jobsSpy.released[0]?.jobId, job.id);
});
