import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Domain,
  EmailAddress,
  VerifiabilityClass,
  VerifyContext,
} from '@mailmetero/contracts';
import type { EgressFetch } from '@mailmetero/config';
import {
  createHttpsApiBackend,
  DEFAULT_MILLIONVERIFIER_RESULT_MAP,
} from '../src/https-api-backend.ts';
import { createNullBackend } from '../src/null-backend.ts';
import {
  createFetchVendorClient,
  type HttpsVerifierVendorClient,
  type VendorVerifyResponse,
} from '../src/vendor-client.ts';

const EMAIL = 'jane.doe@acme.com' as EmailAddress;

function ctx(vc: VerifiabilityClass, provider: VerifyContext['provider'] = 'other'): VerifyContext {
  return {
    domain: 'acme.com' as Domain,
    mx: 'EXPLICIT_MX',
    provider,
    verifiabilityClass: vc,
    isCatchAll: null,
  };
}

/** A stub vendor client that returns a fixed response — zero live calls. */
function stubClient(resp: VendorVerifyResponse): HttpsVerifierVendorClient {
  return { async verify() { return resp; } };
}

const OPTS = { timeoutMs: 2000, resultMap: DEFAULT_MILLIONVERIFIER_RESULT_MAP };

test("vendor 'ok' on a verifiable provider → valid / ok", async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'ok' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD', 'google_workspace'));
  assert.equal(o.verdict, 'valid');
  assert.equal(o.subStatus, 'ok');
  assert.equal(backend.kind, 'api');
});

test("vendor 'catch_all' → accept_all / catch_all_confirmed", async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'catch_all' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'accept_all');
  assert.equal(o.subStatus, 'catch_all_confirmed');
});

test("vendor 'invalid' → invalid / invalid_mailbox", async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'invalid' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'invalid');
  assert.equal(o.subStatus, 'invalid_mailbox');
});

test('D10 clamp: vendor says ok, but UNVERIFIABLE (M365) → accept_all, never valid', async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'ok' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('UNVERIFIABLE', 'microsoft365'));
  assert.equal(o.verdict, 'accept_all');
  assert.equal(o.subStatus, 'provider_unverifiable');
  assert.notEqual(o.verdict, 'valid');
});

test('D10 clamp: vendor says ok, but UNKNOWN (consumer) → unknown, never valid', async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'ok' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('UNKNOWN', 'gmail_consumer'));
  assert.equal(o.verdict, 'unknown');
  assert.notEqual(o.verdict, 'valid');
});

test('unmapped vendor code falls back to the SMTP classifier', async () => {
  const backend = createHttpsApiBackend(
    stubClient({ resultCode: 'weird_code', rawSmtpCode: '550', enhancedCode: '5.1.1' }),
    OPTS,
  );
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'invalid');
  assert.equal(o.subStatus, 'invalid_mailbox');
  assert.equal(o.rawSmtpCode, '550');
  assert.equal(o.enhancedCode, '5.1.1');
});

test('unmapped vendor code with no SMTP reply → unknown / backend_unavailable', async () => {
  const backend = createHttpsApiBackend(stubClient({ resultCode: 'weird_code' }), OPTS);
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.subStatus, 'backend_unavailable');
});

test('mapped outcome carries the vendor SMTP codes through', async () => {
  const backend = createHttpsApiBackend(
    stubClient({ resultCode: 'invalid', rawSmtpCode: '550', enhancedCode: '5.1.1' }),
    OPTS,
  );
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.rawSmtpCode, '550');
  assert.equal(o.enhancedCode, '5.1.1');
});

test('client throw (deadline abort) → unknown / timeout, never throws', async () => {
  const slowClient: HttpsVerifierVendorClient = {
    async verify(_email, signal) {
      // Simulate a request that outlives the timeout by waiting on the abort signal.
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    },
  };
  const backend = createHttpsApiBackend(slowClient, { timeoutMs: 10, resultMap: DEFAULT_MILLIONVERIFIER_RESULT_MAP });
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.subStatus, 'timeout');
});

test('client throw (non-abort failure) → unknown / backend_unavailable', async () => {
  const failClient: HttpsVerifierVendorClient = {
    async verify() {
      throw new Error('connection refused');
    },
  };
  const backend = createHttpsApiBackend(failClient, OPTS);
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.subStatus, 'backend_unavailable');
});

test('createNullBackend → kind none, always unknown', async () => {
  const backend = createNullBackend();
  assert.equal(backend.kind, 'none');
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.verdict, 'unknown');
  assert.equal(o.subStatus, 'backend_unavailable');
});

test('createNullBackend honors the provided degradation subStatus', async () => {
  const backend = createNullBackend('timeout');
  const o = await backend.verify(EMAIL, ctx('VERIFIABLE_WITH_CATCHALL_GUARD'));
  assert.equal(o.subStatus, 'timeout');
});

// ── createFetchVendorClient over a stubbed EgressFetch (no live network) ──────────────

test('createFetchVendorClient parses the vendor JSON body', async () => {
  const fakeFetch: EgressFetch = async (input) => {
    const url = new URL(input.toString());
    assert.equal(url.searchParams.get('email'), EMAIL);
    assert.equal(url.searchParams.get('api'), 'secret-key');
    return new Response(JSON.stringify({ result: 'ok', resultcode: 1, quality: 'good' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createFetchVendorClient({
    fetch: fakeFetch,
    baseUrl: 'https://api.millionverifier.com/api/v3/',
    apiKey: 'secret-key',
    allowlist: ['api.millionverifier.com'],
  });
  const resp = await client.verify(EMAIL);
  assert.equal(resp.resultCode, 'ok');
  assert.equal(resp.subResult, 'good');
});

test('createFetchVendorClient rejects a host off the allowlist at construction', () => {
  const fakeFetch: EgressFetch = async () => new Response('{}');
  assert.throws(
    () =>
      createFetchVendorClient({
        fetch: fakeFetch,
        baseUrl: 'https://evil.example.com/verify',
        apiKey: 'k',
        allowlist: ['api.millionverifier.com'],
      }),
    /not on the egress allowlist/,
  );
});

test('createFetchVendorClient throws on a non-2xx vendor response', async () => {
  const fakeFetch: EgressFetch = async () => new Response('nope', { status: 500 });
  const client = createFetchVendorClient({
    fetch: fakeFetch,
    baseUrl: 'https://api.millionverifier.com/api/v3/',
    apiKey: 'k',
    allowlist: ['api.millionverifier.com'],
  });
  await assert.rejects(() => client.verify(EMAIL), /HTTP 500/);
});
