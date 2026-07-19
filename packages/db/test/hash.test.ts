import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { computeSuppressionHash, sha256Hex } from '../src/hash.ts';

test('sha256Hex returns lowercase 64-char hex matching node:crypto', () => {
  const h = sha256Hex('hello');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, createHash('sha256').update('hello', 'utf8').digest('hex'));
});

test('computeSuppressionHash is salted, deterministic, and hex', () => {
  const a = computeSuppressionHash('user@example.com', 'salt-value-32-characters-minimum!!');
  const b = computeSuppressionHash('user@example.com', 'salt-value-32-characters-minimum!!');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('computeSuppressionHash differs by salt and never equals plain sha256 of the value', () => {
  const value = 'user@example.com';
  const h1 = computeSuppressionHash(value, 'salt-A-padded-to-thirty-two-chars!!');
  const h2 = computeSuppressionHash(value, 'salt-B-padded-to-thirty-two-chars!!');
  assert.notEqual(h1, h2);
  assert.notEqual(h1, sha256Hex(value)); // salt actually participates
});

test('salt/value domain separation: salt+value cannot be reassociated', () => {
  // hash(salt='ab', value='cd') must not equal hash(salt='a', value='bcd')
  const h1 = computeSuppressionHash('cd', 'ab_padding_to_reach_thirty_two_ch');
  const h2 = computeSuppressionHash('bcd', 'a_padding_to_reach_thirty_two_char');
  assert.notEqual(h1, h2);
});
