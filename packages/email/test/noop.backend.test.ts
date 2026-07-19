import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeNoopBackend } from '../src/noop.backend.ts';
import { makePostmarkBackend } from '../src/postmark.backend.ts';
import { buildSignupKeyEmail } from '../src/templates.ts';
import { EMAIL_EGRESS_HOSTS } from '../src/hosts.ts';
import type { EgressFetch, Logger } from '@mailmetero/config';
import type { OutboundEmail } from '../src/backend.ts';

const msg: OutboundEmail = buildSignupKeyEmail({
  to: 'dev@example.com',
  apiKeyPlaintext: 'sk_test_key',
  docsUrl: 'https://docs.mailmetero.com',
});

test('noop backend: kind is noop and send accepts without a logger', async () => {
  const backend = makeNoopBackend();
  assert.equal(backend.kind, 'noop');

  const receipt = await backend.send(msg);
  assert.equal(receipt.accepted, true);
  assert.ok(receipt.providerMessageId.startsWith('noop-'));
});

test('noop backend: captures message metadata via the injected logger, never sends', async () => {
  const calls: Array<{ obj: unknown; label: string }> = [];
  // Minimal Logger duck-type: only .info is exercised by the noop path.
  const logger = {
    info: (obj: unknown, label: string) => calls.push({ obj, label }),
  } as unknown as Logger;

  const backend = makeNoopBackend(logger);
  const receipt = await backend.send(msg);

  assert.equal(receipt.accepted, true);
  assert.equal(calls.length, 1);
  const recorded = calls[0]!.obj as { event: string; kind: string; tag: string; providerMessageId: string };
  assert.equal(recorded.event, 'email_noop_send');
  assert.equal(recorded.kind, 'signup_key');
  assert.equal(recorded.tag, 'signup_key');
  assert.equal(recorded.providerMessageId, receipt.providerMessageId);
});

test('noop backend: message ids are unique across sends', async () => {
  const backend = makeNoopBackend();
  const a = await backend.send(msg);
  const b = await backend.send(msg);
  assert.notEqual(a.providerMessageId, b.providerMessageId);
});

// --- Postmark backend: exercised against a fake EgressFetch (no real network) ---

const silentLogger = {
  info: () => {},
  warn: () => {},
} as unknown as Logger;

test('postmark backend: rejects a baseUrl whose host is not allowlisted', () => {
  const fetchStub: EgressFetch = async () => new Response('{}');
  assert.throws(
    () =>
      makePostmarkBackend({
        fetch: fetchStub,
        baseUrl: 'https://evil.example.com',
        apiKey: 'token',
        fromEmail: 'no-reply@mail.mailmetero.com',
        messageStream: 'outbound',
        logger: silentLogger,
      }),
    /not an allowlisted ESP host/,
  );
});

test('postmark backend: posts to the allowlisted host and returns an accepted receipt', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchStub: EgressFetch = async (input, init) => {
    seen.push({ url: input.toString(), init });
    return new Response(JSON.stringify({ MessageID: 'pm-123', ErrorCode: 0, Message: 'OK' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const backend = makePostmarkBackend({
    fetch: fetchStub,
    baseUrl: `https://${EMAIL_EGRESS_HOSTS[0]}`,
    apiKey: 'server-token',
    fromEmail: 'no-reply@mail.mailmetero.com',
    messageStream: 'outbound',
    logger: silentLogger,
  });

  assert.equal(backend.kind, 'postmark');
  const receipt = await backend.send(msg);

  assert.equal(receipt.accepted, true);
  assert.equal(receipt.providerMessageId, 'pm-123');
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.url.endsWith('/email'));

  const init = seen[0]!.init!;
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['X-Postmark-Server-Token'], 'server-token');
  const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
  assert.equal(sentBody['From'], 'no-reply@mail.mailmetero.com');
  assert.equal(sentBody['To'], 'dev@example.com');
  assert.equal(sentBody['Tag'], 'signup_key');
  assert.equal(sentBody['MessageStream'], 'outbound');
});

test('postmark backend: non-zero ErrorCode yields an un-accepted receipt', async () => {
  const fetchStub: EgressFetch = async () =>
    new Response(JSON.stringify({ ErrorCode: 300, Message: 'Invalid email request' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });

  const backend = makePostmarkBackend({
    fetch: fetchStub,
    baseUrl: `https://${EMAIL_EGRESS_HOSTS[0]}/`,
    apiKey: 'server-token',
    fromEmail: 'no-reply@mail.mailmetero.com',
    messageStream: 'outbound',
    logger: silentLogger,
  });

  const receipt = await backend.send(msg);
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.providerMessageId, '');
});
