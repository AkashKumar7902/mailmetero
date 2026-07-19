// @mailmetero/core — canonicalizers + syntax gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeEmail,
  canonicalizeDomain,
  canonicalizeLocalPart,
  validateEmailSyntax,
  isValidLocalPartSyntax,
} from '../src/canonicalize.ts';

test('canonicalizeDomain reduces to registrable eTLD+1, lower-cased', () => {
  assert.equal(canonicalizeDomain('WWW.Acme.CO.UK'), 'acme.co.uk');
  assert.equal(canonicalizeDomain('mail.corp.example.com'), 'example.com');
  assert.equal(canonicalizeDomain('https://foo.example.com/path?q=1'), 'example.com');
  assert.equal(canonicalizeDomain('example.com.'), 'example.com');
});

test('canonicalizeDomain rejects bare TLDs and garbage', () => {
  assert.equal(canonicalizeDomain('com'), null);
  assert.equal(canonicalizeDomain(''), null);
  assert.equal(canonicalizeDomain('localhost'), null);
});

test('canonicalizeDomain punycodes unicode hosts', () => {
  const d = canonicalizeDomain('münchen.de');
  assert.equal(d, 'xn--mnchen-3ya.de');
});

test('canonicalizeEmail lower-cases, strips one +tag, normalizes domain', () => {
  assert.equal(canonicalizeEmail('John.Smith+newsletter@WWW.Acme.CO.UK'), 'john.smith@acme.co.uk');
  assert.equal(canonicalizeEmail('a@b.com'), 'a@b.com');
});

test('canonicalizeEmail rejects malformed input', () => {
  assert.equal(canonicalizeEmail('no-at-sign'), null);
  assert.equal(canonicalizeEmail('@nope.com'), null);
  assert.equal(canonicalizeEmail('user@'), null);
  assert.equal(canonicalizeEmail('+only@x.com'), null);
});

test('canonicalizeLocalPart trims + lower-cases without stripping +tag', () => {
  assert.equal(canonicalizeLocalPart('  John.Smith+X '), 'john.smith+x');
});

test('isValidLocalPartSyntax accepts dot-atoms, rejects junk', () => {
  assert.equal(isValidLocalPartSyntax('john.smith'), true);
  assert.equal(isValidLocalPartSyntax("o'brien"), true); // apostrophe is a legal RFC 5321 atom char
  assert.equal(isValidLocalPartSyntax('has space'), false);
  assert.equal(isValidLocalPartSyntax('.leading'), false);
  assert.equal(isValidLocalPartSyntax('trailing.'), false);
  assert.equal(isValidLocalPartSyntax('a..b'), false);
  assert.equal(isValidLocalPartSyntax(''), false);
});

test('validateEmailSyntax returns brands on success', () => {
  const v = validateEmailSyntax('Jane.Doe+promo@sub.Example.com');
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.email, 'jane.doe@example.com');
    assert.equal(v.localPart, 'jane.doe');
    assert.equal(v.domain, 'example.com');
  }
});

test('validateEmailSyntax returns the free invalid_syntax verdict on failure', () => {
  const v = validateEmailSyntax('bogus@@x');
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.reasonCode, 'invalid_syntax');
    assert.equal(v.subStatus, 'invalid_syntax');
  }
});
