// @mailmetero/contracts — §2 ReasonCode registry (FROZEN).
//
// Every response carries ≥1 reason_code — there is never a bare `unknown`
// (PRD §4.2, Success Metric 5). Adding a member is a spec change that bumps the
// OpenAPI version; removing/renaming is breaking. None reveals suppression (D5/§7).

export const REASON_CODES = [
  // ── derivation / pattern evidence ──
  'pattern_learned_domain',            // [§4] KB verified pattern hit at this domain
  'pattern_prior_small_company',       // [§4] size prior, small company
  'pattern_prior_micro_company',
  'pattern_prior_midsize_company',
  'pattern_prior_enterprise',
  'pattern_prior_unknown_size',
  'nickname_variant',                  // candidate from nicknames.csv expansion
  'compound_surname_variant',          // compound/punctuated surname expansion (≤2)
  'german_fold_variant',               // ue/oe/ae/ss transliteration variant
  'cjk_ambiguous_downweight',          // CJK detected → confidence down-weighted
  'collision_risk_high',               // [§4]
  'collision_middle_initial_candidate',// dual-candidate: middle-initial form
  'collision_numeric_suffix_candidate',// dual-candidate: numeric-suffix form

  // ── DNS / MX ──
  'dns_explicit_mx',
  'dns_implicit_mx_only',              // A-record fallback → cap 60
  'dns_null_mx',                       // [§4] RFC 7505 → invalid
  'dns_no_mail_host',

  // ── provider / caps ──
  'provider_m365_cap',                 // [§4] M365 → accept_all, cap 84
  'provider_gateway_config_dependent',
  'catch_all_cap',                     // [§4] confirmed catch-all → cap 84
  'catch_all_confirmed',
  'prior_only_catch_all_cap',          // prior-only on M365/catch-all → cap 55
  'implicit_mx_cap',                   // IMPLICIT_MX_FALLBACK → cap 60

  // ── verification outcome ──
  'verifier_confirmed_valid',          // definitive positive (→ verified band)
  'verifier_confirmed_invalid',        // definitive negative
  'smtp_5_1_1',                        // [§4] invalid mailbox from honest provider
  'gateway_policy_block',              // [§4] 5.7.1 / administrative prohibition → unknown
  'mailbox_disabled',                  // disabled/deactivated mailbox

  // ── classification (free terminal statuses) ──
  'freemail_domain',
  'disposable_domain',
  'role_account',                      // RFC 2142 + extensions
  'typo_domain_corrected',             // gnail→gmail etc.
  'invalid_syntax',

  // ── cache / KB ──
  'cache_hit_tenant',                  // per-tenant TTL-fresh result cache
  'kb_domain_fact_hit',                // shared KB domain facts short-circuit

  // ── backend / degradation ──
  'backend_degraded',                  // [§4] backend=none, unbilled
  'backend_unavailable',
  'backend_timeout',
] as const;
export type ReasonCode = typeof REASON_CODES[number];
