// Sandbox fixture coverage + response-schema conformance. Pure (no Fastify) — runs standalone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES } from '@mailmetero/contracts';
import { FIXTURES, FIXTURE_STATUS_COVERAGE } from '../src/sandbox/fixtures.ts';
import { validateResponseAgainstSpec } from '../src/openapi/validate.ts';
import { successEnvelope, makeMeta } from '../src/envelope.ts';
import type { RequestId } from '@mailmetero/contracts';

test('every Status is covered by at least one sandbox fixture', () => {
  for (const s of STATUSES) {
    assert.equal(FIXTURE_STATUS_COVERAGE[s], true, `Status ${s} has no fixture`);
  }
});

test('fixture catalog includes the 202 async path and error outcomes', () => {
  const kinds = new Set(FIXTURES.map((f) => f.outcome.kind));
  assert.ok(kinds.has('async_202'), 'no async_202 fixture');
  assert.ok(kinds.has('error'), 'no error fixture');
  assert.ok(kinds.has('finder'), 'no finder fixture');
  assert.ok(kinds.has('verifier'), 'no verifier fixture');
});

test('every finder/verifier fixture validates against the OpenAPI response schema', () => {
  const meta = makeMeta('req_test' as RequestId);
  for (const f of FIXTURES) {
    if (f.outcome.kind === 'finder') {
      const res = validateResponseAgainstSpec('email_finder', 200, successEnvelope(f.outcome.result, meta));
      assert.ok(res.valid, `${f.name}: ${res.errors.join('; ')}`);
    } else if (f.outcome.kind === 'verifier') {
      const res = validateResponseAgainstSpec('email_verifier', 200, successEnvelope(f.outcome.result, meta));
      assert.ok(res.valid, `${f.name}: ${res.errors.join('; ')}`);
    }
  }
});

test('every finder/verifier fixture carries >=1 reason_code and a numeric score', () => {
  for (const f of FIXTURES) {
    if (f.outcome.kind === 'finder' || f.outcome.kind === 'verifier') {
      const r = f.outcome.result;
      assert.ok(r.reason_codes.length >= 1, `${f.name}: no reason_codes`);
      assert.equal(typeof r.score, 'number', `${f.name}: score not numeric`);
      assert.ok(STATUSES.includes(r.status), `${f.name}: bad status`);
    }
  }
});
