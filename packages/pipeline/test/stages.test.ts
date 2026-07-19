// Unit tests — stage ordering/CI invariant, Budget, the internal→wire mapper, suppression hashing,
// and the core adapter. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIPELINE_STAGES, DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
import type {
  Candidate,
  EmailAddress,
  Domain,
  LocalPart,
  PatternToken,
  IsoTimestamp,
  ApiError,
  VerificationEvidence,
} from '@mailmetero/contracts';
import { buildStages } from '../src/orchestrator.ts';
import { createBudget } from '../src/budget.ts';
import { baseEvidence } from '../src/stage.ts';
import { createCoreAdapter } from '../src/adapter.ts';
import {
  toFinderResult,
  toVerifierResult,
  toWireCandidate,
  toBulkFinderRow,
  toBulkVerifierRow,
  toVerificationSummary,
} from '../src/wire.ts';
import type { InternalFinderResult, InternalVerifierResult } from '../src/types.ts';
import { PRIORS, makeName, makeDomain } from './harness.ts';

// ── buildStages ordering + the suppression CI invariant ────────────────────────

test('buildStages returns the 9 stages in canonical order', () => {
  const stages = buildStages();
  assert.equal(stages.length, 9);
  assert.deepEqual(stages.map((s) => s.id), [...PIPELINE_STAGES]);
});

test('buildStages()[1] is the suppression stage with appliesTo ⊇ {finder, verifier}', () => {
  const stage = buildStages()[1]!;
  assert.equal(stage.id, 'suppression_check');
  assert.ok(stage.appliesTo.includes('finder'));
  assert.ok(stage.appliesTo.includes('verifier'));
});

// ── Budget ─────────────────────────────────────────────────────────────────────

test('createBudget: remaining/expired track the injected clock', () => {
  let now = 1000;
  const clock = () => now;
  const b = createBudget(clock, 500);
  assert.equal(b.deadline, 1500);
  assert.equal(b.remaining(clock), 500);
  assert.equal(b.expired(clock), false);
  now = 1500;
  assert.equal(b.remaining(clock), 0);
  assert.equal(b.expired(clock), true);
});

test('createBudget: callerMaxMs tightens but never loosens the budget', () => {
  const clock = () => 0;
  assert.equal(createBudget(clock, 8000, 2000).deadline, 2000);
  assert.equal(createBudget(clock, 1000, 5000).deadline, 1000);
  assert.equal(createBudget(clock, 8000, 0).deadline, 0);
});

// (suppression hashing moved to the db-backed SuppressionPort impl; the pipeline no longer hashes
//  values itself — see orchestrator.test.ts B2 + observational-equivalence tests, which drive the
//  suppress fake with raw canonical values.)

// ── wire mapper ────────────────────────────────────────────────────────────────

const EV: VerificationEvidence = {
  ...baseEvidence('score_and_writeback'),
  tier: 'verified',
  backend: 'api',
  provider: 'google_workspace',
  mx: 'EXPLICIT_MX',
  verifiedAt: '2026-07-19T00:00:00.000Z' as IsoTimestamp,
};

const CAND: Candidate = {
  email: 'john.doe@acme.com' as EmailAddress,
  localPart: 'john.doe' as LocalPart,
  patternToken: '{first}.{last}' as PatternToken,
  score: 96,
  reasonCodes: ['verifier_confirmed_valid'],
  collisionRisk: false,
};

const FINDER: InternalFinderResult = {
  email: 'john.doe@acme.com' as EmailAddress,
  score: 96,
  status: 'valid',
  subStatus: 'ok',
  domain: 'acme.com' as Domain,
  firstName: 'John',
  lastName: 'Doe',
  reasonCodes: ['verifier_confirmed_valid'],
  provider: 'google_workspace',
  backend: 'api',
  evidence: 'verified',
  collisionRisk: false,
  chosen: { email: 'john.doe@acme.com' as EmailAddress, score: 96, status: 'valid', reasonCodes: ['verifier_confirmed_valid'], collisionRisk: false },
  candidates: [CAND],
  verification: EV,
};

const VERIFIER: InternalVerifierResult = {
  email: 'john.doe@acme.com' as EmailAddress,
  status: 'valid',
  score: 96,
  subStatus: 'ok',
  acceptAll: false,
  disposable: false,
  webmail: false,
  mxRecords: true,
  smtpCheck: true,
  reasonCodes: ['verifier_confirmed_valid'],
  provider: 'google_workspace',
  backend: 'api',
  evidence: 'verified',
  rawSmtpCode: '250',
  verification: EV,
};

test('toWireCandidate projects the snake_case candidate', () => {
  assert.deepEqual(toWireCandidate(CAND), {
    email: 'john.doe@acme.com',
    score: 96,
    reason_codes: ['verifier_confirmed_valid'],
  });
});

test('toVerificationSummary carries status + verified date', () => {
  assert.deepEqual(toVerificationSummary('valid', EV), { status: 'valid', date: EV.verifiedAt });
});

test('toFinderResult maps every field to the wire shape', () => {
  const w = toFinderResult(FINDER);
  assert.equal(w.email, 'john.doe@acme.com');
  assert.equal(w.first_name, 'John');
  assert.equal(w.last_name, 'Doe');
  assert.deepEqual(w.sources, ['derivation']);
  assert.equal(w.sub_status, 'ok');
  assert.equal(w.collision_risk, false);
  assert.equal(w.verified_at, EV.verifiedAt);
  assert.equal(w.stale, false);
  assert.equal(w.candidates.length, 1);
  assert.deepEqual(w.verification, { status: 'valid', date: EV.verifiedAt });
});

test('toVerifierResult maps the Hunter-parity + native fields', () => {
  const w = toVerifierResult(VERIFIER);
  assert.equal(w.email, 'john.doe@acme.com');
  assert.equal(w.mx_records, true);
  assert.equal(w.smtp_check, true);
  assert.equal(w.accept_all, false);
  assert.equal(w.raw_smtp_code, '250');
  assert.equal(w.verified_at, EV.verifiedAt);
});

test('toBulkFinderRow: ok result and ApiError both map', () => {
  const ok = toBulkFinderRow({ first_name: 'John', last_name: 'Doe', domain: 'acme.com' }, FINDER);
  assert.ok('email' in ok.result);
  const err: ApiError = { id: 'e1', code: 'invalid_domain', details: 'bad' };
  const bad = toBulkFinderRow({ first_name: 'X', last_name: 'Y', domain: 'nope' }, err);
  assert.ok('errors' in bad.result);
  if ('errors' in bad.result) assert.deepEqual(bad.result.errors, [err]);
});

test('toBulkVerifierRow: ok result and ApiError both map', () => {
  const ok = toBulkVerifierRow({ email: 'john.doe@acme.com' }, VERIFIER);
  assert.ok('status' in ok.result);
  const err: ApiError = { id: 'e2', code: 'invalid_email', details: 'bad' };
  const bad = toBulkVerifierRow({ email: 'nope' }, err);
  assert.ok('errors' in bad.result);
});

// ── core adapter ─────────────────────────────────────────────────────────────

test('createCoreAdapter.candidates generates deduped candidates, each with ≥1 reason code', () => {
  const { candidates } = createCoreAdapter({ priors: PRIORS, config: DEFAULT_SCORING_CONFIG });
  const list = candidates.generate(makeName('John', 'Doe'), makeDomain('acme.com'), null);
  assert.ok(list.length >= 1);
  assert.ok(list.length <= DEFAULT_SCORING_CONFIG.caps.MAX_CANDIDATES);
  for (const c of list) assert.ok(c.reasonCodes.length >= 1);
  const emails = new Set(list.map((c) => c.email));
  assert.equal(emails.size, list.length, 'candidates are deduped by email');
});

test('createCoreAdapter.scorer narrows status to a VerifyVerdict and returns ≥1 reason code', () => {
  const { candidates, scorer } = createCoreAdapter({ priors: PRIORS, config: DEFAULT_SCORING_CONFIG });
  const [cand] = candidates.generate(makeName('John', 'Doe'), makeDomain('acme.com'), null);
  assert.ok(cand);
  const out = scorer.score({
    candidate: cand!,
    evidence: { ...baseEvidence('score_and_writeback'), mx: 'EXPLICIT_MX', provider: 'google_workspace', verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD', backend: 'api' },
    domainSupport: null,
    sizeBracket: 'small',
    verify: { verdict: 'valid', subStatus: 'ok', rawSmtpCode: '250' },
    config: DEFAULT_SCORING_CONFIG,
  });
  assert.equal(out.status, 'valid');
  assert.ok(out.score >= DEFAULT_SCORING_CONFIG.caps.VERIFIED_BAND_MIN);
  assert.ok(out.reasonCodes.length >= 1);
  assert.ok(['valid', 'invalid', 'accept_all', 'unknown'].includes(out.status));
});
