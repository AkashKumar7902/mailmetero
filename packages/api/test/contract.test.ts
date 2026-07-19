// Error mapping, ApiException, and envelope builders. Pure — runs standalone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES } from '@mailmetero/contracts';
import type { RequestId } from '@mailmetero/contracts';
import { ERROR_HTTP_STATUS, ApiException, errors } from '../src/errors.ts';
import { makeMeta, successEnvelope, errorEnvelope, apiError } from '../src/envelope.ts';

test('ERROR_HTTP_STATUS is exhaustive over the frozen registry', () => {
  for (const code of ERROR_CODES) {
    assert.equal(typeof ERROR_HTTP_STATUS[code], 'number', `missing status for ${code}`);
  }
});

test('key status mappings match the contract', () => {
  assert.equal(ERROR_HTTP_STATUS.invalid_api_key, 401);
  assert.equal(ERROR_HTTP_STATUS.insufficient_credits, 402);
  assert.equal(ERROR_HTTP_STATUS.rate_limited, 429);
  assert.equal(ERROR_HTTP_STATUS.job_pending, 202);
  assert.equal(ERROR_HTTP_STATUS.idempotency_conflict, 409);
  assert.equal(ERROR_HTTP_STATUS.payload_too_large, 413);
});

test('ApiException carries the mapped status and serializes to an error envelope', () => {
  const exc = errors.rateLimited(30);
  assert.equal(exc.httpStatus, 429);
  assert.equal(exc.retryAfterSeconds, 30);
  const env = exc.toEnvelope();
  assert.equal(env.errors.length, 1);
  assert.equal(env.errors[0]?.code, 'rate_limited');
});

test('jobPending carries Retry-After and Location and maps to 202', () => {
  const exc = errors.jobPending({ retryAfterSeconds: 2, location: '/v2/verifications/abc' });
  assert.ok(exc instanceof ApiException);
  assert.equal(exc.httpStatus, 202);
  assert.equal(exc.retryAfterSeconds, 2);
  assert.equal(exc.locationHeader, '/v2/verifications/abc');
});

test('envelope builders produce the Hunter-parity shapes', () => {
  const meta = makeMeta('req1' as RequestId, { total: 3, nextOffset: 10 });
  assert.equal(meta.request_id, 'req1');
  assert.equal(meta.total, 3);
  assert.equal(meta.next_offset, 10);

  const ok = successEnvelope({ x: 1 }, makeMeta('r' as RequestId));
  assert.deepEqual(ok.data, { x: 1 });

  const err = errorEnvelope([apiError('invalid_domain', 'bad', 'id1')]);
  assert.deepEqual(err.errors[0], { id: 'id1', code: 'invalid_domain', details: 'bad' });
});
