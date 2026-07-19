// @mailmetero/core — name pipeline: fold, script/CJK, German, surname, parse + patterns.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nfkdAsciiFold, detectScript, isCjkName } from '../src/name/normalize.ts';
import { germanFoldVariants, isGermanicContext } from '../src/name/german.ts';
import { expandSurnameVariants, SURNAME_VARIANT_CAP } from '../src/name/surname.ts';
import { splitFullName, normalizeName } from '../src/name/parse.ts';
import { parseNicknamesCsv } from '../src/name/nicknames.ts';
import { renderPattern, isKnownPatternToken, KNOWN_PATTERN_TOKENS } from '../src/patterns.ts';
import type { Domain, PatternToken } from '@mailmetero/contracts';

const NICK = parseNicknamesCsv('');

test('nfkdAsciiFold strips diacritics and folds ligatures', () => {
  assert.equal(nfkdAsciiFold('José'), 'jose');
  assert.equal(nfkdAsciiFold('Łukasz'), 'lukasz');
  assert.equal(nfkdAsciiFold('Straße'), 'strasse');
  assert.equal(nfkdAsciiFold('Æon'), 'aeon');
  assert.equal(nfkdAsciiFold('王'), ''); // no ASCII decomposition
});

test('detectScript classifies dominant script', () => {
  assert.equal(detectScript('Smith'), 'latin');
  assert.equal(detectScript('王伟'), 'cjk');
  assert.equal(detectScript('Иванов'), 'cyrillic');
});

test('isCjkName detects Han script and romanized surnames', () => {
  assert.equal(isCjkName('伟', '王'), true);
  assert.equal(isCjkName('Wei', 'Wang'), true); // romanized surname in builtin set
  assert.equal(isCjkName('John', 'Smith'), false);
});

test('germanFoldVariants yields digraph + bare-vowel forms', () => {
  const v = germanFoldVariants('Müller');
  assert.ok(v.includes('mueller'));
  assert.ok(v.includes('muller'));
});

test('germanFoldVariants only collapses digraphs when the original had an umlaut (m2)', () => {
  // Müller (real umlaut) → still yields both mueller and muller.
  const mueller = germanFoldVariants('Müller');
  assert.ok(mueller.includes('mueller'), 'mueller present');
  assert.ok(mueller.includes('muller'), 'muller present');

  // Bauer / Samuel / Neuer carry a coincidental ue/ae digraph but NO umlaut — they must
  // not spawn the collapsed baur/samul/neur bogus candidates.
  const bauer = germanFoldVariants('Bauer');
  assert.ok(!bauer.includes('baur'), 'Bauer must not collapse to baur');
  assert.deepEqual(bauer, ['bauer']);

  const samuel = germanFoldVariants('Samuel');
  assert.ok(!samuel.includes('samul'), 'Samuel must not collapse to samul');
  assert.deepEqual(samuel, ['samuel']);

  const neuer = germanFoldVariants('Neuer');
  assert.ok(!neuer.includes('neur'), 'Neuer must not collapse to neur');

  // An already-transliterated token with no umlaut is indistinguishable from the above,
  // so it likewise does not collapse.
  assert.deepEqual(germanFoldVariants('mueller'), ['mueller']);
});

test('isGermanicContext keys off umlauts or DACH TLD', () => {
  assert.equal(isGermanicContext('Müller', null), true);
  assert.equal(isGermanicContext('Smith', 'acme.de' as Domain), true);
  assert.equal(isGermanicContext('Smith', 'acme.com' as Domain), false);
});

test('expandSurnameVariants is capped and handles compounds', () => {
  const v = expandSurnameVariants('van der Berg');
  assert.ok(v.length <= SURNAME_VARIANT_CAP);
  assert.ok(v.includes('vanderberg'));
  assert.ok(v.includes('berg'));
  assert.deepEqual(expandSurnameVariants('Smith'), ['smith']);
  assert.ok(expandSurnameVariants("O'Brien").includes('brien'));
});

test('splitFullName splits into first/middle/last', () => {
  assert.deepEqual(splitFullName('Jane Doe'), { firstName: 'Jane', middleName: null, lastName: 'Doe' });
  assert.deepEqual(splitFullName('John Q Public'), { firstName: 'John', middleName: 'Q', lastName: 'Public' });
  assert.deepEqual(splitFullName('Cher'), { firstName: 'Cher', middleName: null, lastName: null });
});

test('normalizeName assembles a full NameInput', () => {
  const n = normalizeName({ fullName: 'José Müller' }, NICK, { emitGermanVariants: true });
  assert.equal(n.firstName, 'José');
  assert.equal(n.lastName, 'Müller');
  assert.equal(n.normalized.firstName, 'jose');
  assert.equal(n.normalized.lastName, 'muller'); // NFKD drops the umlaut dots
  assert.ok(n.surnameVariants.includes('mueller')); // ue-digraph German variant
  assert.equal(n.script, 'latin');
});

test('pattern grammar: known tokens render, unknown returns via null on missing var', () => {
  assert.equal(isKnownPatternToken('{first}.{last}'), true);
  assert.equal(isKnownPatternToken('{bogus}'), false);
  assert.ok(KNOWN_PATTERN_TOKENS.has('{f}{last}'));

  const vars = { first: 'john', last: 'smith', middle: null, f: null, l: null, m: null };
  assert.equal(renderPattern('{first}.{last}' as PatternToken, vars), 'john.smith');
  assert.equal(renderPattern('{f}{last}' as PatternToken, vars), 'jsmith');
  // middle missing ⇒ null, never a half-formed local part.
  assert.equal(renderPattern('{f}{m}{last}' as PatternToken, vars), null);
});
