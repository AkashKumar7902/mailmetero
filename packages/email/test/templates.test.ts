import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSignupKeyEmail,
  buildObjectionConfirmationEmail,
  buildQuotaAlertEmail,
} from '../src/templates.ts';

test('buildSignupKeyEmail: tag === kind, carries key + docs, no messageStream', () => {
  const email = buildSignupKeyEmail({
    to: 'dev@example.com',
    apiKeyPlaintext: 'sk_live_ABC123',
    docsUrl: 'https://docs.mailmetero.com',
  });

  assert.equal(email.kind, 'signup_key');
  assert.equal(email.tag, email.kind);
  assert.equal(email.to, 'dev@example.com');
  assert.ok(email.subject.length > 0);
  // key present in both bodies
  assert.ok(email.text.includes('sk_live_ABC123'));
  assert.ok(email.html.includes('sk_live_ABC123'));
  // docs link present
  assert.ok(email.text.includes('https://docs.mailmetero.com'));
  assert.ok(email.html.includes('https://docs.mailmetero.com'));
  // exactOptionalPropertyTypes: template omits messageStream entirely
  assert.equal(Object.prototype.hasOwnProperty.call(email, 'messageStream'), false);
});

test('buildObjectionConfirmationEmail: tag === kind, carries confirm url + expiry', () => {
  const email = buildObjectionConfirmationEmail({
    to: 'subject@acme.com',
    confirmUrl: 'https://mailmetero.com/objections/confirm?token=xyz',
    expiresAt: '2026-07-26T00:00:00Z',
  });

  assert.equal(email.kind, 'objection_confirmation');
  assert.equal(email.tag, email.kind);
  assert.ok(email.text.includes('https://mailmetero.com/objections/confirm?token=xyz'));
  assert.ok(email.html.includes('token=xyz'));
  assert.ok(email.text.includes('2026-07-26T00:00:00Z'));
  assert.ok(email.html.includes('2026-07-26T00:00:00Z'));
});

test('buildQuotaAlertEmail: tag === kind, rounds and clamps usedPct into 0..100', () => {
  const email = buildQuotaAlertEmail({
    to: 'owner@acme.com',
    planName: 'Growth',
    usedPct: 80.4,
    resetDate: '2026-08-01',
  });

  assert.equal(email.kind, 'quota_alert');
  assert.equal(email.tag, email.kind);
  assert.ok(email.subject.includes('80%'));
  assert.ok(email.html.includes('80%'));
  assert.ok(email.text.includes('Growth'));
  assert.ok(email.text.includes('2026-08-01'));

  const over = buildQuotaAlertEmail({ to: 'o@a.com', planName: 'Free', usedPct: 150, resetDate: '2026-08-01' });
  assert.ok(over.subject.includes('100%'));
  const under = buildQuotaAlertEmail({ to: 'o@a.com', planName: 'Free', usedPct: -5, resetDate: '2026-08-01' });
  assert.ok(under.subject.includes('0%'));
});

test('templates: HTML-escape hostile interpolated values (no raw markup injection)', () => {
  const email = buildQuotaAlertEmail({
    to: 'owner@acme.com',
    planName: '<script>alert(1)</script>',
    usedPct: 50,
    resetDate: '2026-08-01',
  });

  // The raw tag must not appear un-escaped in the html body.
  assert.equal(email.html.includes('<script>alert(1)</script>'), false);
  assert.ok(email.html.includes('&lt;script&gt;'));
  // Plaintext body is not markup, so it carries the literal value.
  assert.ok(email.text.includes('<script>alert(1)</script>'));
});

test('templates: every builder emits non-empty html + text', () => {
  const emails = [
    buildSignupKeyEmail({ to: 'a@b.com', apiKeyPlaintext: 'k', docsUrl: 'https://x.y' }),
    buildObjectionConfirmationEmail({ to: 'a@b.com', confirmUrl: 'https://x.y/c', expiresAt: '2026-01-01' }),
    buildQuotaAlertEmail({ to: 'a@b.com', planName: 'P', usedPct: 10, resetDate: '2026-01-01' }),
  ];
  for (const e of emails) {
    assert.ok(e.html.length > 0, `${e.kind} html non-empty`);
    assert.ok(e.text.length > 0, `${e.kind} text non-empty`);
    assert.equal(e.tag, e.kind);
  }
});
