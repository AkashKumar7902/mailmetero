// @mailmetero/contracts — §1 Enums (CONTRACTS_CORE.md verbatim) + shared job vocabulary.
//
// Enums are const-arrays, not TS `enum`: `export const XS = [...] as const;` plus
// `export type X = typeof XS[number];`. This yields a runtime array (needed to generate
// the OpenAPI 3.1 spec + fixture catalog + CI response-validation), a closed literal
// union at compile time, and stable JSON values. Never introduce `enum` here.

// ── Status (Hunter-compatible, FIXED; PRD §4.1) ─────────────────────────────
export const STATUSES = [
  'valid',       // definitive positive verify on a verifiable, non-catch-all provider
  'invalid',     // definitive negative
  'accept_all',  // domain accepts any local part; per-address deliverability unknowable
  'unknown',     // no definitive evidence
  'disposable',  // disposable/temp-mail domain
  'webmail',     // freemail domain (gmail.com …); never a derivation target
  'role',        // role account (RFC 2142 + extensions); excluded from person results
] as const;
export type Status = typeof STATUSES[number];

// ── SubStatus (every value in PRD §4.1) ─────────────────────────────────────
// Grouped by the parent Status they can appear under (see STATUS_SUBSTATUS below).
export const SUB_STATUSES = [
  // valid
  'ok',
  // invalid
  'invalid_mailbox',      // 5.1.1 from an honest provider
  'null_mx',              // RFC 7505 Null-MX — definitive reject
  'no_mail_host',         // no usable mail host
  'disabled',             // mailbox disabled/deactivated
  'invalid_syntax',       // fails RFC syntax — FREE, unbilled
  // accept_all
  'catch_all_confirmed',  // domain confirmed catch-all
  'provider_unverifiable',// M365 & equivalents — provider cannot be trusted per-address
  // unknown
  'timeout',
  'backend_unavailable',
  'gateway_blocked',      // 5.7.1 / policy block
  'implicit_mx_only',     // RFC 5321 A-record fallback only
] as const;
export type SubStatus = typeof SUB_STATUSES[number];

/** Which sub_status values are legal under each status. Enforced in response validation. */
export const STATUS_SUBSTATUS: Readonly<Record<Status, readonly SubStatus[]>> = {
  valid:      ['ok'],
  invalid:    ['invalid_mailbox', 'null_mx', 'no_mail_host', 'disabled', 'invalid_syntax'],
  accept_all: ['catch_all_confirmed', 'provider_unverifiable'],
  unknown:    ['timeout', 'backend_unavailable', 'gateway_blocked', 'implicit_mx_only'],
  disposable: [],
  webmail:    [],
  role:       [],
} as const;

// ── MxEnum (typed DNS result; PRD §6 stage 5) ───────────────────────────────
export const MX_ENUMS = [
  'EXPLICIT_MX',           // one or more MX records present
  'IMPLICIT_MX_FALLBACK',  // no MX, A/AAAA present (RFC 5321) — cap score at 60
  'NULL_MX',               // RFC 7505 "MX 0 ." — definitive reject, short-circuits FREE
  'NO_MAIL_HOST',          // no MX and no A/AAAA — cannot receive mail
] as const;
export type MxEnum = typeof MX_ENUMS[number];

// ── Provider (MX-suffix fingerprint; PRD §6 stage 6) ────────────────────────
export const PROVIDERS = [
  'microsoft365',     // *.mail.protection.outlook.com
  'google_workspace', // aspmx.l.google.com (custom domain, != gmail.com)
  'gmail_consumer',   // gmail.com / googlemail.com
  'yahoo_consumer',   // yahoo.* consumer
  'proofpoint',       // *.pphosted.com
  'mimecast',         // *.mimecast.com
  'ironport',         // Cisco IronPort gateways
  'barracuda',        // Barracuda ESG
  'zoho',             // Zoho Mail
  'proton',           // Proton
  'other',            // resolved MX, unrecognized fingerprint
] as const;
export type Provider = typeof PROVIDERS[number];

// ── VerifiabilityClass (per-provider verify strategy; RESEARCH_BRIEF §6 matrix) ─
export const VERIFIABILITY_CLASSES = [
  'UNVERIFIABLE',                  // microsoft365 — never VALID from 250; pattern confidence IS the product
  'UNKNOWN',                       // gmail_consumer, yahoo_consumer — never assert valid
  'VERIFIABLE_WITH_CATCHALL_GUARD',// google_workspace — trust 550 5.1.1; run fake-local catch-all probe first
  'VERIFIABLE_GREYLIST_RETRY',     // zoho — honest but greylists (vendor absorbs greylisting in v1)
  'GATEWAY_CONFIG_DEPENDENT',      // proofpoint/mimecast/ironport/barracuda — parse 5.1.1 vs 5.7.1
] as const;
export type VerifiabilityClass = typeof VERIFIABILITY_CLASSES[number];

/** Seed mapping provider → verifiability class. Live values may be overridden by kb.provider_fingerprints. */
export const PROVIDER_VERIFIABILITY: Readonly<Record<Provider, VerifiabilityClass>> = {
  microsoft365:     'UNVERIFIABLE',
  google_workspace: 'VERIFIABLE_WITH_CATCHALL_GUARD',
  gmail_consumer:   'UNKNOWN',
  yahoo_consumer:   'UNKNOWN',
  proofpoint:       'GATEWAY_CONFIG_DEPENDENT',
  mimecast:         'GATEWAY_CONFIG_DEPENDENT',
  ironport:         'GATEWAY_CONFIG_DEPENDENT',
  barracuda:        'GATEWAY_CONFIG_DEPENDENT',
  zoho:             'VERIFIABLE_GREYLIST_RETRY',
  proton:           'UNKNOWN',
  other:            'GATEWAY_CONFIG_DEPENDENT',
} as const;

// ── EvidenceTier (what evidence produced the score; the `evidence` response field) ─
export const EVIDENCE_TIERS = [
  'verified',        // definitive verifier outcome on a verifiable provider (→ 95–100 band)
  'learned_pattern', // KB verified_count support at this domain (→ 70–94 band)
  'prior_only',      // size-conditioned global priors, no domain-local evidence (→ 50–69 band)
  'dns',             // decided at DNS/MX stage (null_mx, no_mail_host, implicit_mx)
  'classifier',      // freemail/disposable/role/typo table hit
  'syntax',          // syntax/canonicalization stage
  'capped',          // a provider/catch-all/implicit-MX/collision cap set the ceiling (→ 1–49 band)
  'degraded',        // backend=none fallback (pattern+MX+fingerprint only)
] as const;
export type EvidenceTier = typeof EVIDENCE_TIERS[number];

// ── Backend (which verifier produced the verdict; PRD §6) ────────────────────
export const BACKENDS = [
  'api',   // v1 default: third-party HTTPS verifier (MillionVerifier-class)
  'none',  // graceful degradation: no verification performed
  'smtp',  // RESERVED for the P2 Hetzner probe node; never emitted in v1
] as const;
export type Backend = typeof BACKENDS[number];

// ── PipelineStage (cheapest-first stages 0–8; PRD §6) ───────────────────────
export const PIPELINE_STAGES = [
  'canonicalize_syntax',   // 0
  'suppression_check',     // 1 (observationally equivalent to not-found)
  'classification_tables', // 2 freemail/disposable/role
  'tenant_cache',          // 3
  'kb_domain_facts',       // 4
  'dns_enum',              // 5 DoH
  'provider_fingerprint',  // 6
  'verifier_backend',      // 7 paid; finder = top-3 only
  'score_and_writeback',   // 8
] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

// ── SizeBracket (size-conditioned priors; boundaries are seed data in kb.pattern_priors) ─
export const SIZE_BRACKETS = ['micro', 'small', 'medium', 'large', 'enterprise'] as const;
export type SizeBracket = typeof SIZE_BRACKETS[number];
// Seed boundaries (tunable in DB): micro <50, small 50–249, medium 250–999,
// large 1000–4999, enterprise 5000+. Labels are stable; cut points are not.

// ── Source of a result (v1: derivation only; NON-GOAL to add scraping sources) ─
export const SOURCE_TAGS = ['derivation'] as const;
export type SourceTag = typeof SOURCE_TAGS[number];

// ── Job vocabulary (MODULE_CONTRACTS §0 additions; frozen) ──────────────────
export const JOB_KINDS = ['bulk_find', 'bulk_verify', 'async_verify'] as const; // D4 unifies async_verify
export type JobKind = typeof JOB_KINDS[number];

export const JOB_ITEM_STATUSES = ['pending', 'done', 'failed'] as const;        // shared item enum
export type JobItemStatus = typeof JOB_ITEM_STATUSES[number];
