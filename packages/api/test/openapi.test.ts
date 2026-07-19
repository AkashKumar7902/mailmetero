// OpenAPI document shape + validateResponseAgainstSpec behavior. Pure — runs standalone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FinderResult, RequestId } from '@mailmetero/contracts';
import { OPENAPI_DOCUMENT } from '../src/openapi/spec.ts';
import { validateResponseAgainstSpec } from '../src/openapi/validate.ts';
import { successEnvelope, errorEnvelope, apiError, makeMeta } from '../src/envelope.ts';

test('OPENAPI_DOCUMENT is OpenAPI 3.1 with an operation per endpoint', () => {
  const doc = OPENAPI_DOCUMENT as { openapi: string; paths: Record<string, unknown> };
  assert.equal(doc.openapi, '3.1.0');
  const opIds = new Set<string>();
  for (const methods of Object.values(doc.paths) as Array<Record<string, { operationId?: string }>>) {
    for (const op of Object.values(methods)) if (op.operationId) opIds.add(op.operationId);
  }
  for (const id of ['email_finder', 'email_verifier', 'verifications_get', 'bulk_finds', 'account', 'usage', 'signup', 'objections', 'openapi', 'healthz']) {
    assert.ok(opIds.has(id), `missing operation ${id}`);
  }
});

const okFinder: FinderResult = {
  email: 'jane.doe@example.com',
  score: 96,
  status: 'valid',
  domain: 'example.com',
  first_name: 'jane',
  last_name: 'doe',
  sources: ['derivation'],
  verification: { status: 'valid', date: null },
  sub_status: 'ok',
  reason_codes: ['verifier_confirmed_valid'],
  provider: 'google_workspace',
  backend: 'api',
  evidence: 'verified',
  collision_risk: false,
  candidates: [{ email: 'jane.doe@example.com', score: 96, reason_codes: ['verifier_confirmed_valid'] }],
  verified_at: null,
  stale: false,
};

test('a well-formed finder envelope validates', () => {
  const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(okFinder, makeMeta('r1' as RequestId)));
  assert.ok(res.valid, res.errors.join('; '));
});

test('a finder payload with a bad status enum fails validation', () => {
  const bad = { ...okFinder, status: 'not_a_status' } as unknown as FinderResult;
  const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(bad, makeMeta('r1' as RequestId)));
  assert.equal(res.valid, false);
});

test('an empty reason_codes array fails the minItems constraint', () => {
  const bad = { ...okFinder, reason_codes: [] } as unknown as FinderResult;
  const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(bad, makeMeta('r1' as RequestId)));
  assert.equal(res.valid, false);
});

test('an illegal status/sub_status pair fails validation even though both enums are individually valid', () => {
  // `valid` and `timeout` are each members of their own enum, but `timeout` is not legal under
  // `valid` per STATUS_SUBSTATUS — the pair-legality check must reject it (m4).
  const bad = { ...okFinder, status: 'valid', sub_status: 'timeout' } as unknown as FinderResult;
  const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(bad, makeMeta('r1' as RequestId)));
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('sub_status')), res.errors.join('; '));
});

test('a legal status/sub_status pair still passes', () => {
  const good = { ...okFinder, status: 'unknown', sub_status: 'timeout' } as unknown as FinderResult;
  const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(good, makeMeta('r1' as RequestId)));
  assert.ok(res.valid, res.errors.join('; '));
});

test('error envelopes validate against the default response and reject bad codes', () => {
  const good = validateResponseAgainstSpec('email_finder', 400, errorEnvelope([apiError('invalid_domain', 'bad')]));
  assert.ok(good.valid, good.errors.join('; '));
  const bad = validateResponseAgainstSpec('email_finder', 400, { errors: [{ id: 'x', code: 'nope', details: 'd' }] });
  assert.equal(bad.valid, false);
});
