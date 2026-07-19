// @mailmetero/core — nickname CSV parsing + bidirectional expansion.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNicknamesCsv, expandGivenName } from '../src/name/nicknames.ts';

const CSV = [
  'name1,relationship,name2',
  'william,has_nickname,bill',
  'william,has_nickname,billy',
  'william,has_nickname,will',
  'robert,has_nickname,bill',
  'robert,has_nickname,bob',
  '# a comment line',
  'katherine,not_a_nickname,kate', // wrong relationship → skipped
  'elizabeth,has_nickname,liz',
  ',has_nickname,ghost', // empty name1 → skipped
].join('\n');

test('parses the triple CSV into a bidirectional map, skipping header/comments/bad rows', () => {
  const map = parseNicknamesCsv(CSV);

  assert.deepEqual([...(map.forward.get('william') ?? [])], ['bill', 'billy', 'will']);
  assert.deepEqual([...(map.reverse.get('bill') ?? [])], ['william', 'robert']);
  assert.equal(map.forward.has('name1'), false, 'header not ingested');
  assert.equal(map.forward.has('katherine'), false, 'non-has_nickname relationship skipped');
  assert.equal(map.reverse.has('ghost'), false, 'empty name1 row skipped');
});

test('expandGivenName forward: canonical → nicknames', () => {
  const map = parseNicknamesCsv(CSV);
  const out = expandGivenName('william', map);
  assert.deepEqual(out, ['bill', 'billy', 'will']);
  assert.equal(out.includes('william'), false, 'never includes the input itself');
});

test('expandGivenName reverse: nickname → canonical(s)', () => {
  const map = parseNicknamesCsv(CSV);
  const out = expandGivenName('bill', map);
  assert.ok(out.includes('william'));
  assert.ok(out.includes('robert'));
});

test('expandGivenName siblings option surfaces co-nicknames', () => {
  const map = parseNicknamesCsv(CSV);
  const withSiblings = expandGivenName('bill', map, { includeSiblings: true });
  // via william → billy, will ; via robert → bob
  assert.ok(withSiblings.includes('billy'));
  assert.ok(withSiblings.includes('bob'));
});

test('reverse-canonical can be disabled', () => {
  const map = parseNicknamesCsv(CSV);
  const out = expandGivenName('bill', map, { includeReverseCanonical: false });
  assert.equal(out.includes('william'), false);
});

test('maxExpansions clamps the output', () => {
  const map = parseNicknamesCsv(CSV);
  const out = expandGivenName('william', map, { maxExpansions: 2 });
  assert.equal(out.length, 2);
});

test('empty / unknown input is safe', () => {
  const map = parseNicknamesCsv('');
  assert.equal(map.forward.size, 0);
  assert.deepEqual(expandGivenName('nobody', map), []);
  assert.deepEqual(expandGivenName('', map), []);
});
