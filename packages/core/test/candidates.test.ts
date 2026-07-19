// @mailmetero/core — candidate generation, dual collision candidates (D9), dedupe + clamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateCandidates, shouldEmitCollisionCandidates } from '../src/candidates.ts';
import type { PatternPriorTable } from '../src/candidates.ts';
import { normalizeName } from '../src/name/parse.ts';
import { parseNicknamesCsv } from '../src/name/nicknames.ts';
import { classifyDomainInput } from '../src/classify.ts';
import { DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
import type { PatternToken, SizeBracket } from '@mailmetero/contracts';

const NICK = parseNicknamesCsv(['name1,relationship,name2', 'william,has_nickname,bill'].join('\n'));

const PRIORS: PatternPriorTable = {
  micro: [{ token: '{first}.{last}' as PatternToken, weight: 0.5 }],
  small: [
    { token: '{first}.{last}' as PatternToken, weight: 0.6 },
    { token: '{f}{last}' as PatternToken, weight: 0.25 },
  ],
  medium: [{ token: '{first}.{last}' as PatternToken, weight: 0.6 }],
  large: [{ token: '{first}.{last}' as PatternToken, weight: 0.6 }],
  enterprise: [{ token: '{first}.{last}' as PatternToken, weight: 0.6 }],
};

const CLASS = { freemail: new Set<string>(), disposable: new Set<string>() };

function domainInput(raw: string, bracket: SizeBracket | null) {
  const d = classifyDomainInput(raw, CLASS, bracket);
  assert.ok(d !== null);
  return d;
}

test('generates ranked, deduped candidates each with ≥1 reason code', () => {
  const name = normalizeName({ firstName: 'William', lastName: 'Smith' }, NICK);
  const domain = domainInput('acme.com', 'small');
  const cands = generateCandidates({ name, domain, priors: PRIORS, config: DEFAULT_SCORING_CONFIG });

  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.ok(c.reasonCodes.length >= 1);
    assert.ok(c.email.endsWith('@acme.com'));
    assert.ok(c.score >= 0 && c.score <= 100);
  }
  // No duplicate emails.
  const emails = cands.map((c) => c.email);
  assert.equal(new Set(emails).size, emails.length);
  // Nickname expansion produced a bill.* candidate.
  assert.ok(cands.some((c) => c.email.startsWith('bill.')), 'nickname candidate present');
  assert.ok(cands.some((c) => c.reasonCodes.includes('nickname_variant')));
});

test('respects MAX_CANDIDATES clamp', () => {
  const tinyConfig = {
    ...DEFAULT_SCORING_CONFIG,
    caps: { ...DEFAULT_SCORING_CONFIG.caps, MAX_CANDIDATES: 2 },
  };
  const name = normalizeName({ firstName: 'William', lastName: 'Smith' }, NICK);
  const domain = domainInput('acme.com', 'small');
  const cands = generateCandidates({ name, domain, priors: PRIORS, config: tinyConfig });
  assert.ok(cands.length <= 2);
});

test('shouldEmitCollisionCandidates fires on middle name or large company', () => {
  const withMiddle = normalizeName({ firstName: 'John', middleName: 'Quincy', lastName: 'Adams' }, NICK);
  const smallDomain = domainInput('acme.com', 'small');
  assert.equal(shouldEmitCollisionCandidates(withMiddle, smallDomain), true);

  const noMiddle = normalizeName({ firstName: 'John', lastName: 'Adams' }, NICK);
  const bigDomain = domainInput('acme.com', 'enterprise');
  assert.equal(shouldEmitCollisionCandidates(noMiddle, bigDomain), true);
  assert.equal(shouldEmitCollisionCandidates(noMiddle, smallDomain), false);
});

test('dual collision candidates: BOTH middle-initial AND numeric-suffix at equal weight', () => {
  const name = normalizeName({ firstName: 'John', middleName: 'Quincy', lastName: 'Adams' }, NICK);
  const domain = domainInput('acme.com', 'small');
  const cands = generateCandidates({ name, domain, priors: PRIORS, config: DEFAULT_SCORING_CONFIG });

  const middleInitial = cands.filter((c) => c.reasonCodes.includes('collision_middle_initial_candidate'));
  const numericSuffix = cands.filter((c) => c.reasonCodes.includes('collision_numeric_suffix_candidate'));

  assert.ok(middleInitial.length >= 1, 'middle-initial candidate emitted');
  assert.ok(numericSuffix.length >= 1, 'numeric-suffix candidate emitted');
  for (const c of [...middleInitial, ...numericSuffix]) {
    assert.equal(c.collisionRisk, true);
    assert.ok(c.reasonCodes.includes('collision_risk_high'));
  }
  // Equal weight ⇒ same preliminary score for both collision forms.
  assert.equal(middleInitial[0]!.score, numericSuffix[0]!.score);
});

test('empty name yields no candidates', () => {
  const name = normalizeName({}, NICK);
  const domain = domainInput('acme.com', 'small');
  assert.deepEqual(generateCandidates({ name, domain, priors: PRIORS, config: DEFAULT_SCORING_CONFIG }), []);
});

test('domain-learned pattern support surfaces pattern_learned_domain', () => {
  const name = normalizeName({ firstName: 'William', lastName: 'Smith' }, NICK);
  const domain = domainInput('acme.com', 'small');
  const support = new Map([
    [
      '{first}.{last}' as PatternToken,
      {
        patternToken: '{first}.{last}' as PatternToken,
        observedCount: 40,
        verifiedCount: 30,
        lastSeenAt: null,
        winningFold: null,
      },
    ],
  ]);
  const cands = generateCandidates({
    name,
    domain,
    priors: PRIORS,
    config: DEFAULT_SCORING_CONFIG,
    domainSupport: support,
  });
  const learned = cands.find((c) => c.patternToken === '{first}.{last}' && c.email === 'william.smith@acme.com');
  assert.ok(learned);
  assert.ok(learned!.reasonCodes.includes('pattern_learned_domain'));
  // Learned-pattern support should push the score into (or toward) the learned band.
  assert.ok(learned!.score >= DEFAULT_SCORING_CONFIG.caps.FINDER_BILLABLE_MIN);
});
