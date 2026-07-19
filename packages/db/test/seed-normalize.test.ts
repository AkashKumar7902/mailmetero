import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDomainForSeed, FREEMAIL_JUNK_TOKENS } from '../src/seed/normalize.ts';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

test('lowercases and keeps valid domains', () => {
  assert.equal(normalizeDomainForSeed('Gmail.COM'), 'gmail.com');
  assert.equal(normalizeDomainForSeed('  example.org  '), 'example.org');
});

test('drops bare labels and known junk tokens', () => {
  assert.equal(normalizeDomainForSeed('asean-mail'), null);
  assert.equal(normalizeDomainForSeed('housefancom'), null);
  assert.equal(normalizeDomainForSeed('multiplechoices'), null);
  assert.equal(normalizeDomainForSeed('404: not found'), null);
  assert.equal(normalizeDomainForSeed(''), null);
  assert.equal(normalizeDomainForSeed('# a comment'), null);
});

test('keeps valid domain that happens to share a junk prefix', () => {
  // asean-mail.com HAS a dot and is a real domain — must survive the junk filter.
  assert.equal(normalizeDomainForSeed('asean-mail.com'), 'asean-mail.com');
});

test('converts IDN to punycode (ASCII)', () => {
  const out = normalizeDomainForSeed('lándwirt.com');
  assert.equal(out, 'xn--lndwirt-hwa.com');
  assert.match(out ?? '', /^[\x00-\x7F]+$/); // pure ASCII
});

test('FREEMAIL_JUNK_TOKENS contains the four observed junk lines', () => {
  for (const t of ['404: not found', 'asean-mail', 'housefancom', 'multiplechoices']) {
    assert.ok(FREEMAIL_JUNK_TOKENS.has(t));
  }
});

test('normalizing the real vendored freemail file drops junk and keeps a known domain', () => {
  const vendorDir = fileURLToPath(new URL('../../../data/vendor', import.meta.url));
  const lines = readFileSync(`${vendorDir}/freemail_domains.txt`, 'utf8').split(/\r?\n/);
  const set = new Set<string>();
  for (const line of lines) {
    const d = normalizeDomainForSeed(line);
    if (d !== null) set.add(d);
  }
  assert.ok(set.has('126.com'), 'keeps a real freemail domain');
  assert.ok(!set.has('404: not found'));
  assert.ok(!set.has('housefancom'));
  assert.ok(!set.has('multiplechoices'));
  assert.ok(!set.has('asean-mail'));
  for (const d of set) assert.ok(d.includes('.'), `every entry has a dot: ${d}`);
});
