// @mailmetero/contracts — frozen-registry snapshot + suppression-leak guard.
//
// Pins every enum/registry member (CONTRACTS_CORE §9.2): changing a member requires an
// intentional snapshot update + OpenAPI version bump. Also enforces §9.3 — no member may
// reveal suppression (grep for suppress|object|blocked_contact, D5/§7).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the runtime const-arrays from their leaf modules directly. The barrel
// (src/index.ts) re-exports these with build-mandated `.js` specifiers that only
// resolve against the compiled `dist/`; importing the leaf `.ts` modules here lets
// `node --test` exercise the exact same frozen arrays against source.
import {
  STATUSES,
  SUB_STATUSES,
  MX_ENUMS,
  PROVIDERS,
  VERIFIABILITY_CLASSES,
  EVIDENCE_TIERS,
  BACKENDS,
  PIPELINE_STAGES,
  SIZE_BRACKETS,
  SOURCE_TAGS,
  JOB_KINDS,
  JOB_ITEM_STATUSES,
  STATUS_SUBSTATUS,
  PROVIDER_VERIFIABILITY,
} from '../src/enums.ts';
import { REASON_CODES } from '../src/reason-codes.ts';
import { ERROR_CODES } from '../src/error-codes.ts';
import { JOB_STATUSES, RESPONSE_HEADERS } from '../src/wire.ts';
import { DEFAULT_SCORING_CONFIG } from '../src/scoring.ts';

// ── snapshot: exact members, in order ────────────────────────────────────────
const SNAPSHOTS: Readonly<Record<string, readonly string[]>> = {
  STATUSES: ['valid', 'invalid', 'accept_all', 'unknown', 'disposable', 'webmail', 'role'],
  SUB_STATUSES: [
    'ok',
    'invalid_mailbox', 'null_mx', 'no_mail_host', 'disabled', 'invalid_syntax',
    'catch_all_confirmed', 'provider_unverifiable',
    'timeout', 'backend_unavailable', 'gateway_blocked', 'implicit_mx_only',
  ],
  MX_ENUMS: ['EXPLICIT_MX', 'IMPLICIT_MX_FALLBACK', 'NULL_MX', 'NO_MAIL_HOST'],
  PROVIDERS: [
    'microsoft365', 'google_workspace', 'gmail_consumer', 'yahoo_consumer',
    'proofpoint', 'mimecast', 'ironport', 'barracuda', 'zoho', 'proton', 'other',
  ],
  VERIFIABILITY_CLASSES: [
    'UNVERIFIABLE', 'UNKNOWN', 'VERIFIABLE_WITH_CATCHALL_GUARD',
    'VERIFIABLE_GREYLIST_RETRY', 'GATEWAY_CONFIG_DEPENDENT',
  ],
  EVIDENCE_TIERS: [
    'verified', 'learned_pattern', 'prior_only', 'dns',
    'classifier', 'syntax', 'capped', 'degraded',
  ],
  BACKENDS: ['api', 'none', 'smtp'],
  PIPELINE_STAGES: [
    'canonicalize_syntax', 'suppression_check', 'classification_tables', 'tenant_cache',
    'kb_domain_facts', 'dns_enum', 'provider_fingerprint', 'verifier_backend', 'score_and_writeback',
  ],
  SIZE_BRACKETS: ['micro', 'small', 'medium', 'large', 'enterprise'],
  SOURCE_TAGS: ['derivation'],
  JOB_KINDS: ['bulk_find', 'bulk_verify', 'async_verify'],
  JOB_ITEM_STATUSES: ['pending', 'done', 'failed'],
  JOB_STATUSES: ['queued', 'claimed', 'running', 'done', 'failed'],
  RESPONSE_HEADERS: [
    'X-Request-Id', 'X-Billed', 'X-Credits-Remaining',
    'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
  ],
  REASON_CODES: [
    'pattern_learned_domain', 'pattern_prior_small_company', 'pattern_prior_micro_company',
    'pattern_prior_midsize_company', 'pattern_prior_enterprise', 'pattern_prior_unknown_size',
    'nickname_variant', 'compound_surname_variant', 'german_fold_variant', 'cjk_ambiguous_downweight',
    'collision_risk_high', 'collision_middle_initial_candidate', 'collision_numeric_suffix_candidate',
    'dns_explicit_mx', 'dns_implicit_mx_only', 'dns_null_mx', 'dns_no_mail_host',
    'provider_m365_cap', 'provider_gateway_config_dependent', 'catch_all_cap', 'catch_all_confirmed',
    'prior_only_catch_all_cap', 'implicit_mx_cap',
    'verifier_confirmed_valid', 'verifier_confirmed_invalid', 'smtp_5_1_1', 'gateway_policy_block',
    'mailbox_disabled',
    'freemail_domain', 'disposable_domain', 'role_account', 'typo_domain_corrected', 'invalid_syntax',
    'cache_hit_tenant', 'kb_domain_fact_hit',
    'backend_degraded', 'backend_unavailable', 'backend_timeout',
  ],
  ERROR_CODES: [
    'invalid_api_key', 'insufficient_credits', 'rate_limited', 'invalid_domain', 'domain_required',
    'verification_unavailable', 'job_pending', 'idempotency_conflict', 'payload_too_large',
    'invalid_email', 'validation_error', 'not_found', 'signup_disposable_blocked',
    'service_unavailable', 'internal_error',
  ],
};

const REGISTRIES: Readonly<Record<string, readonly string[]>> = {
  STATUSES, SUB_STATUSES, MX_ENUMS, PROVIDERS, VERIFIABILITY_CLASSES, EVIDENCE_TIERS,
  BACKENDS, PIPELINE_STAGES, SIZE_BRACKETS, SOURCE_TAGS, JOB_KINDS, JOB_ITEM_STATUSES,
  JOB_STATUSES, RESPONSE_HEADERS, REASON_CODES, ERROR_CODES,
};

for (const [name, expected] of Object.entries(SNAPSHOTS)) {
  test(`registry snapshot: ${name}`, () => {
    const actual = REGISTRIES[name];
    assert.ok(actual, `registry ${name} is exported`);
    assert.deepEqual([...actual], [...expected], `${name} members must match the pinned snapshot`);
  });
}

test('every registry member is unique', () => {
  for (const [name, members] of Object.entries(REGISTRIES)) {
    const set = new Set(members);
    assert.equal(set.size, members.length, `${name} has duplicate members`);
  }
});

// ── §9.3 / §0.5 no suppression leak ──────────────────────────────────────────
// The privacy invariant forbids any WIRE-OBSERVABLE vocabulary value from revealing
// suppression: a suppressed subject must be observationally identical to not-found.
// `PIPELINE_STAGES` is deliberately excluded — it is internal provenance only
// (VerificationEvidence.producedByStage, never serialized to a client) and legitimately
// names the §6 stage `suppression_check`.
const INTERNAL_ONLY = new Set(['PIPELINE_STAGES']);

test('no wire-observable enum/registry member reveals suppression (D5/§7/§0.5)', () => {
  const forbidden = /suppress|object|blocked_contact/i;
  for (const [name, members] of Object.entries(REGISTRIES)) {
    if (INTERNAL_ONLY.has(name)) continue;
    for (const member of members) {
      assert.ok(
        !forbidden.test(member),
        `forbidden suppression-revealing token in ${name}: '${member}'`,
      );
    }
  }
});

test('STATUS_SUBSTATUS keys cover every Status and reference only known SubStatus', () => {
  const statusKeys = Object.keys(STATUS_SUBSTATUS).sort();
  assert.deepEqual(statusKeys, [...STATUSES].sort(), 'STATUS_SUBSTATUS must key every Status');
  const known = new Set<string>(SUB_STATUSES);
  for (const [status, subs] of Object.entries(STATUS_SUBSTATUS)) {
    for (const sub of subs) {
      assert.ok(known.has(sub), `STATUS_SUBSTATUS[${status}] references unknown sub_status '${sub}'`);
    }
  }
});

test('PROVIDER_VERIFIABILITY maps every Provider to a known VerifiabilityClass', () => {
  const known = new Set<string>(VERIFIABILITY_CLASSES);
  for (const provider of PROVIDERS) {
    const cls = PROVIDER_VERIFIABILITY[provider];
    assert.ok(known.has(cls), `provider '${provider}' maps to unknown class '${cls}'`);
  }
});

// ── §5 scoring seed is frozen ────────────────────────────────────────────────
test('DEFAULT_SCORING_CONFIG is frozen and carries the published caps', () => {
  assert.ok(Object.isFrozen(DEFAULT_SCORING_CONFIG), 'DEFAULT_SCORING_CONFIG must be Object.frozen');
  assert.equal(DEFAULT_SCORING_CONFIG.caps.M365_ACCEPT_ALL_MAX, 84);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.IMPLICIT_MX_MAX, 60);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.M365_PRIOR_ONLY_MAX, 55);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.FINDER_BILLABLE_MIN, 70);
  assert.equal(DEFAULT_SCORING_CONFIG.caps.VERIFIED_BAND_MIN, 95);
  assert.equal(DEFAULT_SCORING_CONFIG.bands.length, 4);
});
