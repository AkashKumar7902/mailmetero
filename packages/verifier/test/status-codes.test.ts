import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiabilityClass } from '@mailmetero/contracts';
import { classifySmtpCode } from '../src/status-codes.ts';

const VERIFIABLE: VerifiabilityClass = 'VERIFIABLE_WITH_CATCHALL_GUARD';

test('5.1.1 → invalid / invalid_mailbox', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.1.1',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'invalid');
  assert.equal(c.subStatus, 'invalid_mailbox');
  assert.equal(c.rawSmtpCode, '550');
  assert.equal(c.enhancedCode, '5.1.1');
});

test('5.7.1 → unknown / gateway_blocked (policy block)', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.7.1',
    provider: 'proofpoint',
    verifiabilityClass: 'GATEWAY_CONFIG_DEPENDENT',
  });
  assert.equal(c.verdict, 'unknown');
  assert.equal(c.subStatus, 'gateway_blocked');
});

test('any x.7.x subject → gateway_blocked', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.7.26',
    provider: 'other',
    verifiabilityClass: 'GATEWAY_CONFIG_DEPENDENT',
  });
  assert.equal(c.verdict, 'unknown');
  assert.equal(c.subStatus, 'gateway_blocked');
});

test('lone 550 5.4.1 on UNVERIFIABLE (M365) → accept_all, NEVER invalid', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.4.1',
    provider: 'microsoft365',
    verifiabilityClass: 'UNVERIFIABLE',
  });
  assert.equal(c.verdict, 'accept_all');
  assert.equal(c.subStatus, 'provider_unverifiable');
  assert.notEqual(c.verdict, 'invalid');
});

test('5.4.1 on a verifiable provider → unknown (routing), not invalid', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.4.1',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'unknown');
  assert.notEqual(c.verdict, 'invalid');
});

test('5.2.1 → invalid / disabled', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    enhancedCode: '5.2.1',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'invalid');
  assert.equal(c.subStatus, 'disabled');
});

test('5.2.2 mailbox full → unknown (mailbox exists, not a negative)', () => {
  const c = classifySmtpCode({
    rawCode: '552',
    enhancedCode: '5.2.2',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'unknown');
});

test('250 success on a verifiable provider → valid / ok', () => {
  const c = classifySmtpCode({
    rawCode: '250',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'valid');
  assert.equal(c.subStatus, 'ok');
});

test('250 on UNVERIFIABLE → accept_all (never valid)', () => {
  const c = classifySmtpCode({
    rawCode: '250',
    provider: 'microsoft365',
    verifiabilityClass: 'UNVERIFIABLE',
  });
  assert.equal(c.verdict, 'accept_all');
  assert.notEqual(c.verdict, 'valid');
});

test('250 on UNKNOWN (consumer) → unknown (never valid)', () => {
  const c = classifySmtpCode({
    rawCode: '250',
    provider: 'gmail_consumer',
    verifiabilityClass: 'UNKNOWN',
  });
  assert.equal(c.verdict, 'unknown');
  assert.notEqual(c.verdict, 'valid');
});

test('bare 550 without enhanced code on verifiable provider → invalid', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    provider: 'google_workspace',
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'invalid');
  assert.equal(c.subStatus, 'invalid_mailbox');
  assert.equal(c.enhancedCode, null);
});

test('bare 550 without enhanced code on UNVERIFIABLE → accept_all (anti-enumeration)', () => {
  const c = classifySmtpCode({
    rawCode: '550',
    provider: 'microsoft365',
    verifiabilityClass: 'UNVERIFIABLE',
  });
  assert.equal(c.verdict, 'accept_all');
  assert.notEqual(c.verdict, 'invalid');
});

test('4xx transient → unknown / timeout', () => {
  const c = classifySmtpCode({
    rawCode: '451',
    enhancedCode: '4.7.1',
    provider: 'zoho',
    verifiabilityClass: 'VERIFIABLE_GREYLIST_RETRY',
  });
  // 4.7.x is subject 7 → gateway_blocked even in the transient class.
  assert.equal(c.verdict, 'unknown');
});

test('pure 4.x.x transient with non-policy subject → timeout', () => {
  const c = classifySmtpCode({
    rawCode: '450',
    enhancedCode: '4.2.1',
    provider: 'zoho',
    verifiabilityClass: 'VERIFIABLE_GREYLIST_RETRY',
  });
  assert.equal(c.verdict, 'unknown');
  assert.equal(c.subStatus, 'timeout');
});

test('no code at all → unknown / backend_unavailable', () => {
  const c = classifySmtpCode({
    provider: null,
    verifiabilityClass: VERIFIABLE,
  });
  assert.equal(c.verdict, 'unknown');
  assert.equal(c.subStatus, 'backend_unavailable');
  assert.equal(c.rawSmtpCode, null);
  assert.equal(c.enhancedCode, null);
});
