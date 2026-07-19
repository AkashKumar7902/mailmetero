// @mailmetero/dns — fingerprintProvider unit tests (pure; longest-suffix + consumer split).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fingerprintProvider, SEED_FINGERPRINT_RULES } from '../src/fingerprint.ts';
import type { MxHost } from '../src/types.ts';
import type { Domain } from '@mailmetero/contracts';

const dom = (s: string): Domain => s as Domain;
const host = (exchange: string, preference = 10): MxHost => ({ exchange, preference });

test('gmail.com → gmail_consumer (domain identity beats aspmx MX suffix)', () => {
  const fp = fingerprintProvider(
    dom('gmail.com'),
    [host('gmail-smtp-in.l.google.com'), host('alt1.gmail-smtp-in.l.google.com', 20)],
    SEED_FINGERPRINT_RULES,
  );
  assert.equal(fp.provider, 'gmail_consumer');
  assert.equal(fp.verifiabilityClass, 'UNKNOWN');
  assert.equal(fp.matchedSuffix, null);
});

test('custom domain on aspmx.l.google.com → google_workspace', () => {
  const fp = fingerprintProvider(
    dom('acme.com'),
    [host('aspmx.l.google.com'), host('alt1.aspmx.l.google.com', 20)],
    SEED_FINGERPRINT_RULES,
  );
  assert.equal(fp.provider, 'google_workspace');
  assert.equal(fp.verifiabilityClass, 'VERIFIABLE_WITH_CATCHALL_GUARD');
  assert.equal(fp.matchedSuffix, 'aspmx.l.google.com');
});

test('M365 tenant host → microsoft365 (UNVERIFIABLE)', () => {
  const fp = fingerprintProvider(
    dom('contoso.com'),
    [host('contoso-com.mail.protection.outlook.com')],
    SEED_FINGERPRINT_RULES,
  );
  assert.equal(fp.provider, 'microsoft365');
  assert.equal(fp.verifiabilityClass, 'UNVERIFIABLE');
  assert.equal(fp.matchedSuffix, 'mail.protection.outlook.com');
});

test('longest matching suffix wins over a shorter one', () => {
  const rules = [
    { suffix: 'outlook.com', provider: 'other' as const },
    { suffix: 'mail.protection.outlook.com', provider: 'microsoft365' as const },
  ];
  const fp = fingerprintProvider(dom('x.com'), [host('x-com.mail.protection.outlook.com')], rules);
  assert.equal(fp.provider, 'microsoft365');
  assert.equal(fp.matchedSuffix, 'mail.protection.outlook.com');
});

test('gateway providers fingerprint correctly', () => {
  assert.equal(
    fingerprintProvider(dom('a.com'), [host('mx1.pphosted.com')], SEED_FINGERPRINT_RULES).provider,
    'proofpoint',
  );
  assert.equal(
    fingerprintProvider(dom('b.com'), [host('a-com.mail.eu.mimecast.com')], SEED_FINGERPRINT_RULES).provider,
    'mimecast',
  );
  assert.equal(
    fingerprintProvider(dom('c.com'), [host('mx.iphmx.com')], SEED_FINGERPRINT_RULES).provider,
    'ironport',
  );
});

test('resolved but unrecognized MX → other', () => {
  const fp = fingerprintProvider(dom('weird.com'), [host('mail.weird-host.example')], SEED_FINGERPRINT_RULES);
  assert.equal(fp.provider, 'other');
  assert.equal(fp.matchedSuffix, null);
  assert.equal(fp.verifiabilityClass, 'GATEWAY_CONFIG_DEPENDENT');
});

test('no hosts (implicit/no-mail-host domain) → other', () => {
  const fp = fingerprintProvider(dom('nomx.com'), [], SEED_FINGERPRINT_RULES);
  assert.equal(fp.provider, 'other');
  assert.equal(fp.matchedSuffix, null);
});

test('verifiabilityOverrides win over the seed PROVIDER_VERIFIABILITY map', () => {
  const fp = fingerprintProvider(
    dom('acme.com'),
    [host('aspmx.l.google.com')],
    SEED_FINGERPRINT_RULES,
    { google_workspace: 'GATEWAY_CONFIG_DEPENDENT' },
  );
  assert.equal(fp.provider, 'google_workspace');
  assert.equal(fp.verifiabilityClass, 'GATEWAY_CONFIG_DEPENDENT');
});

test('host matching is case-insensitive', () => {
  const fp = fingerprintProvider(dom('a.com'), [host('MX1.PPHOSTED.COM')], SEED_FINGERPRINT_RULES);
  assert.equal(fp.provider, 'proofpoint');
});
