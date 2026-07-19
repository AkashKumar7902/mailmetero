import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HardCaps, BillingInput } from '@mailmetero/contracts';
import { decideBilling } from '../src/billing/policy.ts';

const caps = { FINDER_BILLABLE_MIN: 70 } as unknown as HardCaps;

function vInput(over: Partial<BillingInput>): BillingInput {
  return {
    endpoint: 'verifier',
    status: 'valid',
    subStatus: 'ok',
    score: 95,
    backend: 'api',
    evidence: 'verified',
    hasEmail: true,
    ...over,
  };
}
function fInput(over: Partial<BillingInput>): BillingInput {
  return {
    endpoint: 'finder',
    status: 'valid',
    subStatus: null,
    score: 80,
    backend: 'api',
    evidence: 'learned_pattern',
    hasEmail: true,
    ...over,
  };
}

test('verifier: definitive valid/invalid bills exactly one credit', () => {
  for (const status of ['valid', 'invalid'] as const) {
    const d = decideBilling(vInput({ status }), caps);
    assert.equal(d.billable, true);
    assert.equal(d.creditsDelta, -1);
    assert.equal(d.reason, 'verifier_definitive');
  }
});

test('verifier: non-definitive (unknown/accept_all) is free', () => {
  assert.deepEqual(decideBilling(vInput({ status: 'unknown', subStatus: 'timeout' }), caps), {
    billable: false, creditsDelta: 0, reason: 'free_non_definitive',
  });
  assert.equal(decideBilling(vInput({ status: 'accept_all', subStatus: 'catch_all_confirmed' }), caps).reason, 'free_non_definitive');
});

test('invalid_syntax is always free with a precise reason (both endpoints)', () => {
  assert.equal(decideBilling(vInput({ status: 'invalid', subStatus: 'invalid_syntax' }), caps).reason, 'free_invalid_syntax');
  assert.equal(decideBilling(fInput({ subStatus: 'invalid_syntax' }), caps).reason, 'free_invalid_syntax');
});

test('degraded evidence is never billable', () => {
  assert.equal(decideBilling(vInput({ evidence: 'degraded', backend: 'none' }), caps).reason, 'free_degraded');
  assert.equal(decideBilling(fInput({ evidence: 'degraded', backend: 'none' }), caps).reason, 'free_degraded');
});

test('finder bills iff email present AND score >= FINDER_BILLABLE_MIN AND not accept_all', () => {
  assert.equal(decideBilling(fInput({ score: 80 }), caps).reason, 'finder_score_ge_min');
  assert.equal(decideBilling(fInput({ score: 80 }), caps).creditsDelta, -1);
  assert.equal(decideBilling(fInput({ score: 69 }), caps).billable, false);
  assert.equal(decideBilling(fInput({ score: 95, hasEmail: false }), caps).billable, false);
  assert.equal(decideBilling(fInput({ score: 95, status: 'accept_all' }), caps).billable, false);
});

test('finder non-billable outcomes carry the exact ledger reason (m8: D11 reconstructability)', () => {
  // Every non-billable finder outcome must label itself free_non_definitive so the ledger
  // can reconstruct WHY no credit moved. A mislabel here silently breaks D11.
  // Below-threshold score (69 < FINDER_BILLABLE_MIN 70), email present.
  assert.deepEqual(decideBilling(fInput({ score: 69 }), caps), {
    billable: false, creditsDelta: 0, reason: 'free_non_definitive',
  });
  // No email returned (regardless of score).
  assert.deepEqual(decideBilling(fInput({ score: 95, hasEmail: false }), caps), {
    billable: false, creditsDelta: 0, reason: 'free_non_definitive',
  });
  // accept_all domain — never billable even at a high score.
  assert.deepEqual(decideBilling(fInput({ score: 95, status: 'accept_all' }), caps), {
    billable: false, creditsDelta: 0, reason: 'free_non_definitive',
  });
});
