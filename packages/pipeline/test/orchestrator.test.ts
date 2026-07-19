// E2E orchestrator tests — ALL ports/resolver/backend faked (zero live network).
// Covers: M365 short-circuit, Null-MX terminal, budget degrade, suppression observational
// equivalence, ≥1 reason code + BillingInput on every output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EmailAddress } from '@mailmetero/contracts';
import { createPipeline } from '../src/orchestrator.ts';
import {
  makeDeps,
  makeMx,
  makeDomain,
  finderReq,
  verifierReq,
  OUTLOOK_HOSTS,
  GOOGLE_HOSTS,
} from './harness.ts';

const SUPPRESSION_LEAK = /suppress|object|blocked/i;

test('M365 short-circuit: never calls the paid verifier, returns capped accept_all', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', OUTLOOK_HOSTS) });
  const out = await createPipeline(deps).find(finderReq());

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(calls.verify.length, 0, 'backend.verify must not be called for M365');
  assert.equal(calls.probe, 0, 'catch-all probe must not run for M365');
  assert.equal(out.result.status, 'accept_all');
  assert.ok(out.result.score <= deps.scoringConfig.caps.M365_ACCEPT_ALL_MAX);
  assert.notEqual(out.result.status, 'valid', 'M365 is never valid');
  assert.ok(out.result.reasonCodes.length >= 1);
  assert.ok(out.result.provider === 'microsoft365');
});

test('Null-MX terminal: definitive invalid, no verifier call (verifier path)', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'NULL_MX', []) });
  const out = await createPipeline(deps).verify(verifierReq());

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.result.status, 'invalid');
  assert.equal(out.result.subStatus, 'null_mx');
  assert.ok(out.result.reasonCodes.includes('dns_null_mx'));
  assert.equal(calls.verify.length, 0);
  // Null-MX is a definitive DNS verdict ⇒ billable (evidence 'dns', not degraded).
  assert.equal(out.billingInput.evidence, 'dns');
});

test('Null-MX terminal on the finder path returns invalid too', async () => {
  const { deps } = makeDeps({ mx: makeMx('acme.com', 'NULL_MX', []) });
  const out = await createPipeline(deps).find(finderReq());
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.result.status, 'invalid');
  assert.equal(out.result.subStatus, 'null_mx');
});

test('budget degrade: finder past deadline falls back to backend=none / degraded, unbilled', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS) });
  const out = await createPipeline(deps).find(finderReq({ maxDurationMs: 0 }));

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(calls.verify.length, 0, 'no paid verify once the budget is blown');
  assert.equal(out.result.backend, 'none');
  assert.equal(out.result.evidence, 'degraded');
  assert.ok(out.result.reasonCodes.includes('backend_degraded'));
  assert.ok(out.result.reasonCodes.length >= 1);
  // degraded ⇒ never billable.
  assert.equal(out.billingInput.evidence, 'degraded');
});

test('suppression observational-equivalence: stage-1 domain == stage-8 address, no leak', async () => {
  // (a) suppressed at stage 1 (whole domain).
  const a = makeDeps({
    suppress: (values) => values.includes('acme.com'),
  });
  const outA = await createPipeline(a.deps).find(finderReq());

  // (b) suppressed at stage 8 (the chosen address), after full derivation ran.
  const b = makeDeps({
    mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS),
    suppress: (values) => values.includes('john.doe@acme.com'),
  });
  const outB = await createPipeline(b.deps).find(finderReq());

  assert.equal(outA.kind, 'ok');
  assert.equal(outB.kind, 'ok');
  if (outA.kind !== 'ok' || outB.kind !== 'ok') return;

  // Byte-for-byte identical result AND billing — a suppressed subject is indistinguishable
  // from a genuine not-found regardless of which stage caught it.
  assert.deepEqual(outB.result, outA.result);
  assert.deepEqual(outB.billingInput, outA.billingInput);

  // Canonical not-found shape.
  assert.equal(outA.result.email, null);
  assert.equal(outA.result.status, 'unknown');
  assert.equal(outA.result.chosen, null);
  assert.deepEqual(outA.result.candidates, []);
  assert.ok(outA.result.reasonCodes.length >= 1);
  assert.equal(outA.billingInput.hasEmail, false);

  // No status/reason/sub_status reveals suppression.
  for (const code of outA.result.reasonCodes) assert.ok(!SUPPRESSION_LEAK.test(code));
  assert.ok(!SUPPRESSION_LEAK.test(outA.result.status));
  assert.ok(!SUPPRESSION_LEAK.test(String(outA.result.subStatus)));

  // Stage-1 short-circuits before any paid verify; the address hash was still checked in (b).
  assert.equal(a.calls.verify.length, 0);
});

test('happy path finder: verified valid candidate, ≥1 reason code + BillingInput', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS) });
  const out = await createPipeline(deps).find(finderReq());

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.ok(calls.probe >= 1, 'Google Workspace runs the catch-all guard first');
  assert.ok(calls.verify.length >= 1);
  assert.equal(out.result.status, 'valid');
  assert.equal(out.result.evidence, 'verified');
  assert.ok(out.result.score >= deps.scoringConfig.caps.VERIFIED_BAND_MIN);
  assert.ok(out.result.email !== null);
  assert.ok(out.result.reasonCodes.length >= 1);
  for (const c of out.result.candidates) assert.ok(c.reasonCodes.length >= 1);
  assert.equal(out.billingInput.endpoint, 'finder');
  assert.equal(out.billingInput.hasEmail, true);
});

test('happy path verifier: valid address with smtp_check + BillingInput', async () => {
  const { deps } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS) });
  const out = await createPipeline(deps).verify(verifierReq());

  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.result.status, 'valid');
  assert.equal(out.result.smtpCheck, true);
  assert.equal(out.result.mxRecords, true);
  assert.ok(out.result.reasonCodes.length >= 1);
  assert.equal(out.billingInput.endpoint, 'verifier');
});

test('verifier defers (202) when the sync budget is blown on a verifiable provider', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS) });
  const out = await createPipeline(deps).verify(verifierReq({ budgetMs: 0 }));
  assert.equal(out.kind, 'deferred');
  assert.equal(calls.verify.length, 0);
});

test('classification terminal: freemail domain ⇒ webmail (finder), unbilled', async () => {
  const { deps, calls } = makeDeps({ isFreemail: true });
  const out = await createPipeline(deps).find(finderReq({ domain: makeDomain('gmail.com', { isFreemail: true }) }));
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.result.status, 'webmail');
  assert.ok(out.result.reasonCodes.includes('freemail_domain'));
  assert.equal(calls.verify.length, 0);
});

test('B2: an address-suppressed finder candidate is NEVER passed to backend.verify', async () => {
  // john.doe@acme.com is the top-ranked candidate for "John Doe" on acme.com and is
  // address-scope suppressed. The finder MUST NOT SMTP-probe it (or any sibling candidate)
  // via the paid subprocessor. `calls.verify` is the recording fake backend.
  const suppressedAddr = 'john.doe@acme.com';
  const { deps, calls } = makeDeps({
    mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS),
    suppress: (values) => values.includes(suppressedAddr),
  });

  const out = await createPipeline(deps).find(finderReq());
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;

  // The core guarantee: the suppressed address was never handed to the paid backend, and — because
  // the batch address filter runs before stage 7 — no candidate is probed at all once one is suppressed.
  assert.ok(!calls.verify.includes(suppressedAddr), 'suppressed address must never reach backend.verify');
  assert.equal(calls.verify.length, 0, 'no paid verify runs once a candidate is address-suppressed');

  // Canonical not-found — observationally identical to a genuine miss (D5/§7). No leak.
  assert.equal(out.result.email, null);
  assert.equal(out.result.status, 'unknown');
  assert.equal(out.result.chosen, null);
  assert.deepEqual(out.result.candidates, []);
  assert.equal(out.billingInput.hasEmail, false);
  for (const code of out.result.reasonCodes) assert.ok(!SUPPRESSION_LEAK.test(code));
});

test('M9 catch-all guard: probe detects accept_all ⇒ per-address paid verify skipped, capped, non-billable', async () => {
  // Google Workspace (VERIFIABLE_WITH_CATCHALL_GUARD) runs the catch-all probe first; a positive
  // verdict must short-circuit the paid per-address verify (D7 KB-poisoning / D10 anti-enumeration).
  const { deps, calls } = makeDeps({
    mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS),
    probeCatchAll: true,
  });

  const out = await createPipeline(deps).find(finderReq());
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;

  assert.ok(calls.probe >= 1, 'the catch-all guard probe runs first on Google Workspace');
  assert.equal(calls.verify.length, 0, 'no per-address paid verify on a confirmed catch-all domain');
  assert.equal(out.result.status, 'accept_all');
  assert.notEqual(out.result.status, 'valid', 'a catch-all domain is never definitively valid');
  assert.ok(out.result.score <= deps.scoringConfig.caps.CATCH_ALL_ACCEPT_ALL_MAX);
  // Finder billing policy treats accept_all as non-billable regardless of score.
  assert.equal(out.billingInput.status, 'accept_all');
});

test('injected NullBackend (kill switch / spend cap) ⇒ degraded, unbilled', async () => {
  const { deps, calls } = makeDeps({ mx: makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS), backendKind: 'none' });
  const out = await createPipeline(deps).find(finderReq());
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(calls.verify.length, 0);
  assert.equal(out.result.evidence, 'degraded');
  assert.equal(out.result.backend, 'none');
});
