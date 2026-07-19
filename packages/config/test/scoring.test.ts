import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScoringConfig, ScoringConfigError, DEFAULT_SCORING_CONFIG } from '../src/scoring.ts';
import type { ScoringConfig } from '../src/scoring.ts';

function clone(): ScoringConfig {
  return JSON.parse(JSON.stringify(DEFAULT_SCORING_CONFIG)) as ScoringConfig;
}

test('DEFAULT_SCORING_CONFIG passes validation and is returned unchanged', () => {
  const out = validateScoringConfig(DEFAULT_SCORING_CONFIG);
  assert.equal(out, DEFAULT_SCORING_CONFIG);
});

test('rejects bands that do not contiguously cover 1..100', () => {
  const cfg = clone();
  // punch a gap: shrink the top band so coverage no longer reaches 100
  cfg.bands = cfg.bands.map((b) => (b.id === 'verified' ? { ...b, max: 99 } : b));
  assert.throws(() => validateScoringConfig(cfg), ScoringConfigError);
});

test('rejects a prior-only cap above its accept_all cap', () => {
  const cfg = clone();
  cfg.caps = { ...cfg.caps, M365_PRIOR_ONLY_MAX: 90 }; // > M365_ACCEPT_ALL_MAX (84)
  assert.throws(
    () => validateScoringConfig(cfg),
    (e: unknown) => e instanceof ScoringConfigError
      && (e).problems.some((p) => p.includes('M365 prior-only')),
  );
});

test('rejects FINDER_BILLABLE_MIN above VERIFIED_BAND_MIN', () => {
  const cfg = clone();
  cfg.caps = { ...cfg.caps, FINDER_BILLABLE_MIN: 99 };
  assert.throws(() => validateScoringConfig(cfg), ScoringConfigError);
});

test('rejects VERIFY_TOP_N below 1 and MAX_CANDIDATES below VERIFY_TOP_N', () => {
  const a = clone();
  a.caps = { ...a.caps, VERIFY_TOP_N: 0 };
  assert.throws(() => validateScoringConfig(a), ScoringConfigError);

  const b = clone();
  b.caps = { ...b.caps, MAX_CANDIDATES: 1, VERIFY_TOP_N: 3 };
  assert.throws(() => validateScoringConfig(b), ScoringConfigError);
});

test('rejects non-positive budgets', () => {
  const cfg = clone();
  cfg.caps = { ...cfg.caps, FINDER_BUDGET_MS: 0 };
  assert.throws(() => validateScoringConfig(cfg), ScoringConfigError);
});

test('accepts a valid recalibrated config', () => {
  const cfg = clone();
  cfg.version = 'recal-2026-08';
  cfg.source = 'recalibrated';
  assert.equal(validateScoringConfig(cfg).version, 'recal-2026-08');
});
