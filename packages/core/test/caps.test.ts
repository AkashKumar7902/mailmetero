// @mailmetero/core — cap-ceiling property test (CI §9.5 target) + band resolution.
//
// Exercises `scoreDerivation` across a matrix of provider / MX / catch-all / verify inputs
// and asserts every published hard-cap invariant holds — reading the ceilings from the
// injected ScoringConfig, never inlined literals.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreDerivation } from '../src/scoring/score.ts';
import type { ScoreDerivationInput } from '../src/scoring/score.ts';
import { applyCaps, resolveBand } from '../src/scoring/caps.ts';
import { DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
import type {
  Candidate,
  EmailAddress,
  LocalPart,
  PatternToken,
  Provider,
  MxEnum,
  VerifiabilityClass,
  VerifyOutcome,
  SizeBracket,
} from '@mailmetero/contracts';

const CONFIG = DEFAULT_SCORING_CONFIG;
const CAPS = CONFIG.caps;

function candidate(collisionRisk = false): Candidate {
  return {
    email: 'john.smith@acme.com' as EmailAddress,
    localPart: 'john.smith' as LocalPart,
    patternToken: '{first}.{last}' as PatternToken,
    score: 0,
    reasonCodes: [],
    collisionRisk,
  };
}

function baseInput(over: Partial<ScoreDerivationInput> = {}): ScoreDerivationInput {
  return {
    candidate: candidate(),
    priorWeight: 0.6,
    verifiedCount: 0,
    observedCount: 0,
    sizeBracket: 'small' as SizeBracket,
    provider: null,
    mx: 'EXPLICIT_MX' as MxEnum,
    verifiabilityClass: null,
    isCatchAll: null,
    verify: null,
    recencyAgeDays: null,
    backend: 'api',
    isNicknameVariant: false,
    isCjk: false,
    config: CONFIG,
    ...over,
  };
}

const VALID_VERIFY: VerifyOutcome = { verdict: 'valid', subStatus: 'ok' };

test('every result carries ≥1 reason code and a status', () => {
  const providers: (Provider | null)[] = ['microsoft365', 'google_workspace', 'gmail_consumer', 'other', null];
  const mxs: MxEnum[] = ['EXPLICIT_MX', 'IMPLICIT_MX_FALLBACK', 'NULL_MX', 'NO_MAIL_HOST'];
  const catchAlls: (boolean | null)[] = [true, false, null];
  const verifies: (VerifyOutcome | null)[] = [null, VALID_VERIFY, { verdict: 'invalid', subStatus: 'invalid_mailbox' }];

  for (const provider of providers) {
    for (const mx of mxs) {
      for (const isCatchAll of catchAlls) {
        for (const verify of verifies) {
          for (const verifiedCount of [0, 8]) {
            const r = scoreDerivation(
              baseInput({ provider, mx, isCatchAll, verify, verifiedCount }),
            );
            assert.ok(r.reasonCodes.length >= 1, 'reasonCodes ≥ 1');
            assert.ok(r.score >= 0 && r.score <= 100, 'score in [0,100]');
            assert.ok(['valid', 'invalid', 'accept_all', 'unknown'].includes(r.status));
          }
        }
      }
    }
  }
});

test('M365 or catch-all ⇒ accept_all, score ≤ M365_ACCEPT_ALL_MAX, never valid', () => {
  for (const provider of ['microsoft365'] as Provider[]) {
    const r = scoreDerivation(
      baseInput({ provider, verifiabilityClass: 'UNVERIFIABLE', verifiedCount: 12, verify: VALID_VERIFY }),
    );
    assert.equal(r.status, 'accept_all');
    assert.notEqual(r.status, 'valid');
    assert.ok(r.score <= CAPS.M365_ACCEPT_ALL_MAX, `≤ ${CAPS.M365_ACCEPT_ALL_MAX}`);
  }

  const catchAll = scoreDerivation(
    baseInput({ provider: 'other', isCatchAll: true, verifiedCount: 20, verify: VALID_VERIFY }),
  );
  assert.equal(catchAll.status, 'accept_all');
  assert.ok(catchAll.score <= CAPS.CATCH_ALL_ACCEPT_ALL_MAX);
});

test('prior-only on M365/catch-all ⇒ score ≤ M365_PRIOR_ONLY_MAX', () => {
  const m365Prior = scoreDerivation(
    baseInput({ provider: 'microsoft365', verifiabilityClass: 'UNVERIFIABLE', verifiedCount: 0, observedCount: 0 }),
  );
  assert.equal(m365Prior.status, 'accept_all');
  assert.ok(m365Prior.score <= CAPS.M365_PRIOR_ONLY_MAX, `≤ ${CAPS.M365_PRIOR_ONLY_MAX}`);

  const caPrior = scoreDerivation(
    baseInput({ provider: 'other', isCatchAll: true, verifiedCount: 0, observedCount: 0 }),
  );
  assert.ok(caPrior.score <= CAPS.CATCH_ALL_PRIOR_ONLY_MAX);
});

test('IMPLICIT_MX_FALLBACK ⇒ score ≤ IMPLICIT_MX_MAX', () => {
  const r = scoreDerivation(
    baseInput({ mx: 'IMPLICIT_MX_FALLBACK', verifiedCount: 20, verifiabilityClass: 'GATEWAY_CONFIG_DEPENDENT' }),
  );
  assert.ok(r.score <= CAPS.IMPLICIT_MX_MAX, `≤ ${CAPS.IMPLICIT_MX_MAX}`);
  assert.equal(r.subStatus, 'implicit_mx_only');
});

test('NULL_MX ⇒ invalid / null_mx', () => {
  const r = scoreDerivation(baseInput({ mx: 'NULL_MX', verify: VALID_VERIFY, verifiedCount: 20 }));
  assert.equal(r.status, 'invalid');
  assert.equal(r.subStatus, 'null_mx');
  assert.ok(r.reasonCodes.includes('dns_null_mx'));
});

test('NO_MAIL_HOST ⇒ invalid / no_mail_host', () => {
  const r = scoreDerivation(baseInput({ mx: 'NO_MAIL_HOST' }));
  assert.equal(r.status, 'invalid');
  assert.equal(r.subStatus, 'no_mail_host');
});

test('verify.valid on a verifiable non-catch-all ⇒ valid / verified / ≥ VERIFIED_BAND_MIN', () => {
  const r = scoreDerivation(
    baseInput({
      provider: 'google_workspace',
      verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
      isCatchAll: false,
      verify: VALID_VERIFY,
      verifiedCount: 10,
    }),
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.evidence, 'verified');
  assert.ok(r.score >= CAPS.VERIFIED_BAND_MIN, `≥ ${CAPS.VERIFIED_BAND_MIN}`);
  assert.equal(r.band, 'verified');
  assert.ok(r.reasonCodes.includes('verifier_confirmed_valid'));
});

test('implicit-MX verify.valid does NOT take the 95 fast path — capped ≤ IMPLICIT_MX_MAX, non-billable (M1)', () => {
  const r = scoreDerivation(
    baseInput({
      provider: 'other',
      mx: 'IMPLICIT_MX_FALLBACK',
      verifiabilityClass: 'GATEWAY_CONFIG_DEPENDENT',
      isCatchAll: false,
      verify: VALID_VERIFY,
      verifiedCount: 20,
      observedCount: 20,
    }),
  );
  // Must not short-circuit to 'valid'/95 with an empty capsApplied.
  assert.notEqual(r.status, 'valid');
  assert.equal(r.subStatus, 'implicit_mx_only');
  assert.ok(r.score <= CAPS.IMPLICIT_MX_MAX, `score ${r.score} ≤ ${CAPS.IMPLICIT_MX_MAX}`);
  // Below the finder billable floor ⇒ free result.
  assert.ok(r.score < CAPS.FINDER_BILLABLE_MIN, `score ${r.score} < ${CAPS.FINDER_BILLABLE_MIN}`);
  assert.ok(r.capsApplied.includes('implicit_mx'), 'implicit_mx cap recorded');
});

test('explicit-MX verify.valid still takes the fast path ⇒ valid / verified', () => {
  const r = scoreDerivation(
    baseInput({
      provider: 'google_workspace',
      mx: 'EXPLICIT_MX',
      verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
      isCatchAll: false,
      verify: VALID_VERIFY,
      verifiedCount: 20,
      observedCount: 20,
    }),
  );
  assert.equal(r.status, 'valid');
  assert.ok(r.score >= CAPS.VERIFIED_BAND_MIN);
});

test('backend "none" never yields valid', () => {
  const r = scoreDerivation(
    baseInput({
      provider: 'google_workspace',
      verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
      verify: VALID_VERIFY,
      backend: 'none',
      verifiedCount: 10,
    }),
  );
  assert.notEqual(r.status, 'valid');
  assert.equal(r.evidence, 'degraded');
});

test('confirmed invalid mailbox ⇒ invalid + smtp_5_1_1 when enhanced code present', () => {
  const r = scoreDerivation(
    baseInput({
      provider: 'google_workspace',
      verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
      verify: { verdict: 'invalid', subStatus: 'invalid_mailbox', enhancedCode: '5.1.1' },
    }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.reasonCodes.includes('verifier_confirmed_invalid'));
  assert.ok(r.reasonCodes.includes('smtp_5_1_1'));
});

test('resolveBand maps boundaries to the seed band table', () => {
  assert.equal(resolveBand(100, CONFIG.bands), 'verified');
  assert.equal(resolveBand(CAPS.VERIFIED_BAND_MIN, CONFIG.bands), 'verified');
  assert.equal(resolveBand(CAPS.FINDER_BILLABLE_MIN, CONFIG.bands), 'learned_pattern');
  assert.equal(resolveBand(50, CONFIG.bands), 'prior_only');
  assert.equal(resolveBand(1, CONFIG.bands), 'risky_capped');
  assert.equal(resolveBand(0, CONFIG.bands), 'risky_capped');
});

test('applyCaps only ever lowers a score (ceiling semantics)', () => {
  const res = applyCaps({
    rawScore: 99,
    tentativeTier: 'learned_pattern',
    provider: 'microsoft365',
    mx: 'EXPLICIT_MX',
    verifiabilityClass: 'UNVERIFIABLE',
    isCatchAll: null,
    hasDomainSupport: true,
    backend: 'api',
    caps: CAPS,
    bands: CONFIG.bands,
  });
  assert.ok(res.score <= 99);
  assert.ok(res.score <= CAPS.M365_ACCEPT_ALL_MAX);
  assert.ok(res.capsApplied.includes('m365_accept_all'));
});
