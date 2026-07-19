// Route + hook-chain tests with faked ports (needs Fastify). Covers auth, sandbox 0-credit fixtures,
// billing headers, async 202, error mapping, GET idempotency replay, and response-schema conformance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.ts';
import { validateResponseAgainstSpec } from '../src/openapi/validate.ts';
import { buildFakeDeps, KEYS } from './fakes.ts';

async function withServer<T>(deps: ReturnType<typeof buildFakeDeps>, fn: (app: Awaited<ReturnType<typeof buildServer>>) => Promise<T>): Promise<T> {
  const app = await buildServer(deps);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

test('finder: authenticated request returns a wire FinderResult with billing headers', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({
      method: 'GET',
      url: '/v2/email-finder?domain=example.com&first_name=jane&last_name=doe',
      headers: bearer(KEYS.live),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: { email: string }; meta: { request_id: string } };
    assert.equal(body.data.email, 'jane.doe@example.com');
    assert.ok(res.headers['x-request-id']);
    assert.equal(res.headers['x-billed'], '1');
    assert.equal(res.headers['x-credits-remaining'], '49');
    assert.ok(res.headers['x-ratelimit-limit']);
    const check = validateResponseAgainstSpec('email_finder', 200, body);
    assert.ok(check.valid, check.errors.join('; '));
  });
});

test('finder: missing key is 401 invalid_api_key', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-finder?domain=example.com&first_name=a&last_name=b' });
    assert.equal(res.statusCode, 401);
    assert.equal((res.json() as { errors: Array<{ code: string }> }).errors[0]?.code, 'invalid_api_key');
  });
});

test('finder: missing domain is 400 domain_required', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-finder?first_name=a&last_name=b', headers: bearer(KEYS.live) });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { errors: Array<{ code: string }> }).errors[0]?.code, 'domain_required');
  });
});

test('verifier: sandbox test key resolves a fixture at 0 credits', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-verifier?email=valid%40example.com', headers: bearer(KEYS.test) });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: { status: string } };
    assert.equal(body.data.status, 'valid');
    assert.equal(res.headers['x-billed'], '0');
  });
});

test('sandbox: an error fixture maps to its HTTP status (insufficient_credits → 402)', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-verifier?email=nocredits%40example.com', headers: bearer(KEYS.test) });
    assert.equal(res.statusCode, 402);
    assert.equal((res.json() as { errors: Array<{ code: string }> }).errors[0]?.code, 'insufficient_credits');
  });
});

test('verifier: live sync path bills and validates against the spec', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-verifier?email=alice%40example.com', headers: bearer(KEYS.live) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-billed'], '1');
    const check = validateResponseAgainstSpec('email_verifier', 200, res.json());
    assert.ok(check.valid, check.errors.join('; '));
  });
});

test('verifier: deferred verification returns 202 + Location', async () => {
  await withServer(buildFakeDeps({ deferVerify: true }), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/email-verifier?email=slow%40example.com', headers: bearer(KEYS.live) });
    assert.equal(res.statusCode, 202);
    assert.ok(String(res.headers['location']).startsWith('/v2/verifications/'));
  });
});

test('verifications poll: pending job returns 202 job_pending with Retry-After', async () => {
  await withServer(buildFakeDeps({ jobDone: false }), async (app) => {
    const res = await app.inject({ method: 'GET', url: '/v2/verifications/job-async', headers: bearer(KEYS.live) });
    assert.equal(res.statusCode, 202);
    assert.equal((res.json() as { errors: Array<{ code: string }> }).errors[0]?.code, 'job_pending');
    assert.ok(res.headers['retry-after']);
  });
});

test('bulk finds: 202 accepted, payload over the cap is 413', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const ok = await app.inject({
      method: 'POST',
      url: '/v2/bulk/finds',
      headers: { ...bearer(KEYS.live), 'idempotency-key': 'k1' },
      payload: [{ first_name: 'a', last_name: 'b', domain: 'example.com' }],
    });
    assert.equal(ok.statusCode, 202);
    assert.equal((ok.json() as { data: { count: number } }).data.count, 1);

    const deps = buildFakeDeps();
    deps.config = { ...deps.config, bulkMaxRows: 1 };
    await withServer(deps, async (app2) => {
      const big = await app2.inject({
        method: 'POST',
        url: '/v2/bulk/finds',
        headers: { ...bearer(KEYS.live), 'idempotency-key': 'k2' },
        payload: [
          { first_name: 'a', last_name: 'b', domain: 'example.com' },
          { first_name: 'c', last_name: 'd', domain: 'example.com' },
        ],
      });
      assert.equal(big.statusCode, 413);
    });
  });
});

test('GET idempotency: a repeated finder request replays the stored response and bills exactly once', async () => {
  const deps = buildFakeDeps();
  // Count settle invocations across the replay: the second request must be served from the GET
  // dedupe store WITHOUT re-running the handler, so billing settles exactly once (m9).
  let settleCalls = 0;
  const origSettle = deps.ledger.settle;
  deps.ledger.settle = async (arg) => {
    settleCalls += 1;
    return origSettle(arg);
  };
  await withServer(deps, async (app) => {
    const url = '/v2/email-finder?domain=example.com&first_name=jane&last_name=doe';
    const first = await app.inject({ method: 'GET', url, headers: bearer(KEYS.live) });
    const second = await app.inject({ method: 'GET', url, headers: bearer(KEYS.live) });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), first.json());
    assert.equal(settleCalls, 1, 'ledger.settle must fire exactly once across the idempotency replay');
  });
});

test('meta: healthz and openapi.json are public', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);

    const spec = await app.inject({ method: 'GET', url: '/v2/openapi.json' });
    assert.equal(spec.statusCode, 200);
    assert.equal((spec.json() as { openapi: string }).openapi, '3.1.0');
  });
});

test('compliance: signup and objections are public, constant-shaped acks', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const signup = await app.inject({ method: 'POST', url: '/v2/signup', payload: { email: 'new@example.com' } });
    assert.equal(signup.statusCode, 202);

    const disposable = await app.inject({ method: 'POST', url: '/v2/signup', payload: { email: 'x@mailinator.com' } });
    assert.equal(disposable.statusCode, 400);
    assert.equal((disposable.json() as { errors: Array<{ code: string }> }).errors[0]?.code, 'signup_disposable_blocked');

    const objection = await app.inject({ method: 'POST', url: '/v2/objections', payload: { email: 'target@example.com' } });
    assert.equal(objection.statusCode, 202);
  });
});

test('compliance B1: objection → confirm → suppression → subsequent finder/verifier return canonical not-found', async () => {
  await withServer(buildFakeDeps(), async (app) => {
    const target = 'jane.doe@acme.com';

    // Control (a DIFFERENT, un-objected person at the same domain): the finder resolves normally,
    // proving the pipeline works and that suppression is address-scoped, not a blanket domain block.
    const control = await app.inject({
      method: 'GET',
      url: '/v2/email-finder?domain=acme.com&first_name=john&last_name=smith',
      headers: bearer(KEYS.live),
    });
    assert.equal(control.statusCode, 200);
    assert.equal((control.json() as { data: { email: string | null } }).data.email, 'john.smith@acme.com');

    // 1. Public objection intake → constant-shaped 202 ack. The fake mints a deterministic token.
    const objection = await app.inject({ method: 'POST', url: '/v2/objections', payload: { email: target } });
    assert.equal(objection.statusCode, 202);

    // 2. Confirm the emailed token → writes global suppression (atomic in prod).
    const confirm = await app.inject({
      method: 'GET',
      url: `/v2/objections/confirm?token=${encodeURIComponent(`obj-token:${target.toLowerCase()}`)}`,
    });
    assert.equal(confirm.statusCode, 200);

    // 3. The finder for the suppressed subject now returns the canonical not-found shape (email null).
    const finder = await app.inject({
      method: 'GET',
      url: '/v2/email-finder?domain=acme.com&first_name=jane&last_name=doe',
      headers: bearer(KEYS.live),
    });
    assert.equal(finder.statusCode, 200);
    const finderBody = finder.json() as { data: { email: string | null; status: string } };
    assert.equal(finderBody.data.email, null, 'a suppressed subject must be observationally not-found');
    const finderCheck = validateResponseAgainstSpec('email_finder', 200, finderBody);
    assert.ok(finderCheck.valid, finderCheck.errors.join('; '));

    // 4. The verifier for the suppressed address likewise returns not-found (no leak, no valid).
    const verifier = await app.inject({
      method: 'GET',
      url: `/v2/email-verifier?email=${encodeURIComponent(target)}`,
      headers: bearer(KEYS.live),
    });
    assert.equal(verifier.statusCode, 200);
    const verifierBody = verifier.json() as { data: { status: string } };
    assert.notEqual(verifierBody.data.status, 'valid');
    const verifierCheck = validateResponseAgainstSpec('email_verifier', 200, verifierBody);
    assert.ok(verifierCheck.valid, verifierCheck.errors.join('; '));
  });
});
