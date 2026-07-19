# mailmetero v1 — Product Requirements Document

**Status:** Authoritative v1 PRD (synthesized from 5 lens proposals + 3 critiques)
**Date:** 2026-07-19
**Stack (fixed):** TypeScript / Node 26 · node-postgres · Render (web + worker + cron) · Neon serverless Postgres (single DB)
**Sourcing (fixed):** Derivation-only. Never fetches LinkedIn, never uses LinkedIn accounts or scraped-data vendors. Inputs are user-supplied name + company/domain; LinkedIn URLs are parsed only as pasted text.

---

## 1. Product Summary

mailmetero is a hosted, multi-tenant email **finder + verifier API** — the service successor to the offline BounceZero tool. It derives candidate addresses from a user-supplied name plus company domain using BounceZero's audited derivation science (size-conditioned pattern priors, name normalization, collision handling), verifies the top candidates through a pluggable verification backend (default: third-party HTTPS verification API), and returns Hunter-compatible responses (0–100 score, `valid/invalid/accept_all/unknown/disposable/webmail/role` statuses, Bearer auth) so integrators can switch from Hunter-class incumbents with a base-URL change. Its compounding asset is a shared, strictly **company/domain-level** knowledge base — learned patterns, MX fingerprints, catch-all status — that improves accuracy and unit cost for all tenants with every lookup, while person-level results stay per-tenant with TTL retention. Its wedge is honesty: calibrated confidence bands with published methodology (seeded from BounceZero's 3,006-address ground-truth audit), provider-aware truthfulness on M365/catch-all domains, outcome-conditional billing that never charges for non-answers, and a compliance-clean-by-construction posture (no scraped data, suppression honored at find-time, no cross-tenant person data) that scraped-database competitors cannot match.

---

## 2. Scope

### 2.1 v1 In-Scope (P0) — all items below ship at launch

| # | Feature | Effort |
|---|---------|--------|
| P0-1 | **Hunter-mirror `/v2` REST surface**: `GET /v2/email-finder`, `GET /v2/email-verifier` (sync fast-path + 202-async), `GET /v2/verifications/{id}`, `GET /v2/account`, `GET /v2/usage` — same paths/verbs/params/envelope/status enum as Hunter; all mailmetero-native capability as **additive-only** fields | M |
| P0-2 | **Derivation engine** as workspace package `@mailmetero/core` (BounceZero port): size-conditioned pattern priors stored as **tunable Postgres tables** (never code constants), NFKD normalization, compound-surname expansion (capped at 2 variants), RFC 2142+ role-account classifier, `+tag`/lowercase canonicalization, CJK detection + confidence down-weight, dual collision candidates (middle-initial AND numeric-suffix, equal weight) with `collision_risk` flag | L |
| P0-3 | **Cheapest-first pipeline**: syntax + typo-domain table → freemail/disposable/role tables (weekly cron sync) → per-tenant result cache → shared KB → typed DNS enum via DoH (`EXPLICIT_MX / IMPLICIT_MX_FALLBACK / NULL_MX / NO_MAIL_HOST`, Null-MX short-circuits free) → provider fingerprint → paid verify (top-3 candidates only) | M |
| P0-4 | **Provider fingerprint router + verifiability matrix**: MX-suffix table (M365, Google Workspace, Proofpoint, Mimecast, IronPort, Barracuda, Zoho, unknown); M365/known-catch-all **short-circuit that skips paid verifier spend entirely** and returns capped `accept_all`; enhanced-status-code classifier (5.1.1 invalid vs 5.7.1 blocked) | M |
| P0-5 | **Shared domain-level KB** (`kb` schema): patterns + counts, MX enum, provider, catch-all status, TTLs — **schema physically has no name/email columns**, enforced by a CI invariant on migrations; `verified_count` write-guard: never incremented from accept-all-domain probes | M |
| P0-6 | **Pluggable `VerifierBackend`**: one third-party HTTPS API implementation (MillionVerifier-class) + graceful degradation to pattern+MX+fingerprint scoring; `backend` field (`api`\|`none`) and evidence tier on every result | M |
| P0-7 | **Postgres-native async jobs**: `FOR UPDATE SKIP LOCKED` queue on unpooled connection, worker with 30–60s idle backoff, cron sweep for stuck jobs; carries 202-async verify + **bulk endpoints** (`POST /v2/bulk/verifications`, `POST /v2/bulk/finds`, ≤1,000 rows, polling only) | L |
| P0-8 | **API-key auth + abuse controls**: `sk_live_`/`sk_test_` prefix + HMAC-SHA256(pepper) hash, indexed prefix lookup, constant-time compare, scopes; **attempt-level** per-key rate limits via atomic UPDATE counters; per-tenant daily verifier-spend caps; global verifier-spend kill switch; signup email verification + per-IP signup limits + disposable-domain signup blocking | M |
| P0-9 | **Outcome-conditional single-credit ledger**: attempt row always, billable row only on definitive value delivered; auto credit-back on downgrade; `X-Billed`, `X-Credits-Remaining`, `X-RateLimit-*`, `X-Request-Id` headers on every response; **idempotency**: `Idempotency-Key` on POSTs + 24h request-hash dedupe on GET unit endpoints (no double-billing on retries) | M |
| P0-10 | **Sandbox**: `sk_test_` keys hit deterministic fixtures covering **every status enum value and the 202-async path**, burn zero credits, isolated rate limit | S |
| P0-11 | **Compliance pack** (see §7): global hashed suppression list (observationally equivalent to not-found) enforced in find AND verify paths, verified public objection form, per-tenant DSAR export/delete endpoints, 90-day person-level TTL + nightly purge cron, privacy posture pack, code-level egress allowlist, per-result provenance | M |
| P0-12 | **Calibrated confidence bands + reason codes** seeded from the BounceZero 3,006-address audit; never a bare `unknown` — every response carries status + score + ≥1 reason code; M365/catch-all score caps | M |
| P0-13 | **OpenAPI 3.1 spec** as hand-written source of truth (served at `/v2/openapi.json`), generated TS types, CI response validation, docs page with per-endpoint curl + **Hunter migration table** (documenting known gaps honestly), frozen error-code registry | S |
| P0-14 | **Transactional email via ESP** (Postmark-class, behind a thin interface): signup key delivery, objection-form confirmation links, quota alerts — SPF/DKIM/DMARC-aligned from day one | S |
| P0-15 | **Deploy**: `render.yaml` (web + worker + cron on paid Starter, ~$14–20/mo), pooled `DATABASE_URL` for web / unpooled for worker + migrations, `node-pg-migrate` migrations, `/healthz` DB ping, crons: TTL purge, blocklist sync, stuck-job sweep, quota reset | S |

**v1 finder input contract:** `domain` is required at launch. `company`-only requests return a documented `domain_required` error (400) with remediation text; the company→domain resolver is the first P1 fast-follow and completes the Hunter input contract. The migration table states this gap explicitly — we do not market "drop-in" for company-name-based integrations until P1-1 ships.

### 2.2 P1 Backlog (fast-follows, roughly in order)

1. **Company-name → domain resolver** — Brandfetch Brand Search primary (500k/mo free), ranked candidates, MX-gated, PSL-normalized, cached in shared KB; completes Hunter's company-or-domain contract.
2. **MCP server** — `find_email`, `verify_email`, `get_usage`; thin client of the public REST API using the caller's own key; npx-runnable; no privileged path. First fast-follow after the REST surface freezes (per brief guidance to ship near launch).
3. **`GET /v2/domains/{domain}`** — exposes the learned KB row (pattern + support counts, provider, catch-all status, verifiability class); the compliance-safe replacement for Hunter's domain-search; monetizes the moat directly.
4. **Stripe self-serve billing** — free tier (50 finds/mo) exists at P0 with manual paid provisioning; checkout automation follows first paying users.
5. **Teach-the-KB verifier params** — optional `first_name`/`last_name` on `email-verifier` so tenant-verified corporate addresses feed domain-level pattern learning (KB write-guard rules apply).
6. **`POST /v2/feedback`** — bounce/delivery outcome capture into a `calibration_outcomes` table. **Capture-only: no credit-back incentive** (critics' consensus: paying for bounce reports invites fabricated ground truth).
7. **Completion webhooks** (signed, retried) for bulk jobs.
8. **Derivation quality pack** — nickname/diminutive table (carltonnorthern CSV in Postgres), German ue/oe/ae/ss transliteration variants + per-domain fold-winner learning.
9. **Calibration methodology page + monthly recalibration job** — bands labeled "audit-seeded, recalibrated monthly"; the public honesty artifact.
10. **Per-tenant suppression-list API + opted-out export flags** — customer-side CAN-SPAM/PECR insulation; upsell surface.
11. **Per-tenant retention config API** (30–365 days) + FR localization of the privacy notice (Kaspr finding) before EU marketing push.

### 2.3 P2 Backlog

- **Self-hosted SMTP probe node** (BounceZero prober on Hetzner VPS behind authed HTTPS, as a second `VerifierBackend`) — includes the greylist retry state machine, which is deliberately **absent from v1** (the HTTPS verifier API absorbs greylisting internally; the machinery is dead code until SMTP ships).
- **Scheduled re-verification / stale-refresh subscriptions** (`verified_at` + `stale` flag ship in the P0 schema; automation follows once tenants have aged data).
- **Generic-contacts endpoint** (RFC 2142 role addresses on explicit request; the P0 classifier only *excludes* them from person results).
- **Full CJK name-order + syllable-variant generation** (P0 ships detection + down-weight only).
- **Collision frequency tables** (US Census / SSA) for data-driven collision risk.
- **Feedback credit-back incentive** — only if an anti-gaming design (per-tenant refund caps, outlier detection, trimmed calibration) is validated.
- **Status page + public uptime/latency metrics.**
- **Second verifier-vendor adapter** in production (contract-risk hedge; interface is P0, second live integration is P2).

---

## 3. Public API Surface (v1)

All endpoints under `/v2`, Bearer auth (`Authorization: Bearer sk_live_...`). Hunter's `api_key=` query param is also accepted — deprecated, redacted from all logs, answered with a `Deprecation` header. Envelope: success `{data: {...}, meta: {...}}`; errors `{errors: [{id, code, details}]}` with a frozen, documented code registry (`invalid_api_key`, `insufficient_credits`, `rate_limited`, `invalid_domain`, `domain_required`, `verification_unavailable`, `job_pending`, `idempotency_conflict`, `payload_too_large`, ...). There is **no** suppression-revealing code or status anywhere in the API. Every response carries `X-Request-Id`, `X-Billed`, `X-Credits-Remaining`, `X-RateLimit-Limit/Remaining/Reset`.

| Method | Path | Purpose | Key request fields | Key response fields |
|---|---|---|---|---|
| GET | `/v2/email-finder` | Derive + verify the most likely address for a person at a domain | `domain` (required in v1), `first_name`, `last_name` (or `full_name`); optional: `middle_name`, `company` (P1 resolution), `linkedin_url` (parsed as text only), `max_duration` | `data`: `email`, `score` (0–100), `status`, `domain`, `first_name`, `last_name`, `sources: ["derivation"]`, `verification {status, date}`; **additive**: `sub_status`, `reason_codes[]`, `provider`, `backend`, `evidence`, `collision_risk`, `candidates[] {email, score, reason_codes}` (full ranked list, ~25), `verified_at`, `stale` |
| GET | `/v2/email-verifier` | Verify a single address. Sync when resolvable in ~2s (cache/KB/DNS short-circuit); else `202` + `Location: /v2/verifications/{id}` (Hunter's own pattern) | `email` | `data`: `email`, `status`, `score`, `accept_all`, `disposable`, `webmail`, `mx_records`, `smtp_check`; **additive**: `sub_status`, `reason_codes[]`, `provider`, `backend`, `evidence`, `raw_smtp_code`, `verified_at` |
| GET | `/v2/verifications/{id}` | Poll an async verification | — | Same shape as email-verifier when done; `{errors:[{code: "job_pending"}]}` with `Retry-After` while running |
| GET | `/v2/account` | Account/plan info (Hunter parity) | — | `data`: `email`, `plan_name`, `requests {searches {used, available}, verifications {used, available}}`, `reset_date` |
| GET | `/v2/usage` | Live metering detail beyond Hunter parity | optional `from`/`to` | `data`: `credits_used`, `credits_remaining`, `attempts`, `billable`, `credit_backs`, per-day breakdown |
| POST | `/v2/bulk/verifications` | Bulk verify (async job) | JSON array of emails (≤1,000), `Idempotency-Key` header | `202` → `data: {job_id, status, count}` |
| POST | `/v2/bulk/finds` | Bulk find (async job) | JSON array of `{first_name, last_name, domain}` (≤1,000), `Idempotency-Key` | `202` → `data: {job_id, status, count}` |
| GET | `/v2/bulk/{job_id}` | Job status | — | `data: {status, total, done, failed, created_at, finished_at}` |
| GET | `/v2/bulk/{job_id}/results` | Paginated per-row results | `limit`, `offset` | `data: [per-row finder/verifier result]`, `meta: {total, next_offset}` |
| POST | `/v2/signup` | Public self-serve signup → email-verified free-tier key (50 finds/mo) | `email` | `data: {message}` (key delivered by email after confirmation) |
| GET | `/v2/data-subjects/export` | Tenant DSAR export: all rows this tenant holds for an address | `email` | `data: [result rows incl. provenance]` |
| DELETE | `/v2/data-subjects` | Tenant DSAR delete: removes this tenant's rows for an address (tenant-scope only; does **not** write global suppression) | `email` | `204` |
| POST | `/v2/objections` | **Public, unauthenticated** objection/erasure intake (also a hosted web form): sends confirmation link to the target mailbox; on confirm, writes the irreversible global suppression hash | `email` | `202` generic acknowledgment (constant-shaped; rate-limited) |
| GET | `/v2/openapi.json` | The OpenAPI 3.1 contract (source of truth) | — | Spec document |
| GET | `/healthz` | Render health check, cheap DB ping | — | `200` |

**Sandbox:** all endpoints accept `sk_test_` keys and serve deterministic fixtures (fixed name/domain inputs → each status enum value, a fixed `202` flow, fixed error cases), zero credits, isolated limits — documented in the fixture catalog generated from the spec.

**P1 additions:** `GET /v2/domains/{domain}` (KB read), `POST /v2/feedback` (outcome capture), webhook registration.

---

## 4. Confidence Scoring & Status Taxonomy

### 4.1 Status enum (Hunter-compatible, fixed)

| `status` | Meaning | Key `sub_status` values | Billed? |
|---|---|---|---|
| `valid` | Definitive positive verification on a verifiable, non-catch-all provider | `ok` | **Yes (1 credit)** |
| `invalid` | Definitive negative | `invalid_mailbox` (5.1.1 from honest provider), `null_mx`, `no_mail_host`, `disabled`, `invalid_syntax` | **Yes (1 credit)** — except `invalid_syntax` (free) |
| `accept_all` | Domain accepts any local part; per-address deliverability unknowable | `catch_all_confirmed`, `provider_unverifiable` (M365) | No |
| `unknown` | No definitive evidence | `timeout`, `backend_unavailable`, `gateway_blocked` (5.7.1/policy), `implicit_mx_only` | No |
| `disposable` | Disposable/temp-mail domain | — | No |
| `webmail` | Freemail domain (gmail.com etc.); never a derivation target | — | No |
| `role` | Role account (RFC 2142 + extensions); excluded from person results | — | No |

**Finder billing:** 1 credit only when an email is returned with `score ≥ 70` (learned-pattern band or better). Attempts always logged; degraded-backend results always free; automatic credit-back if a billed result is downgraded within 30 days (e.g., domain later confirmed catch-all). Every billable decision is reconstructible from the attempt ledger via `X-Request-Id`.

### 4.2 Confidence bands (evidence-typed, published, calibrated)

| Band | Meaning | Evidence |
|---|---|---|
| **95–100** | Verified | Definitive positive verification of this exact address on a verifiable provider, catch-all guard passed |
| **70–94** | Learned pattern | KB `verified_count` support for this pattern at this domain; address not individually confirmable (or confirmable only behind a catch-all guard) |
| **50–69** | Prior-only guess | Size-conditioned global priors, no domain-local evidence |
| **1–49** | Risky / capped | Catch-all or M365 cap with weak pattern evidence, implicit-MX-only domain, high collision risk, degraded backend |

**Hard caps (published rules):**
- Domains with MX ending `.mail.protection.outlook.com` (M365) or confirmed catch-all: `status=accept_all`, score is pattern-driven and **capped at 84** (never the 95+ band); prior-only on such domains capped at 55. Never `valid` from a 250; never `invalid` from a lone 550 5.4.1. Documented rationale: **anti-enumeration responses to unfamiliar IPs + hybrid/relay configs** (not "DBEB off by default" — DBEB is on by default for authoritative cloud domains; the corrected mechanism goes in the methodology page and code comments).
- `IMPLICIT_MX_FALLBACK` (A-record only, RFC 5321): confidence capped at 60 — downgrade, not hard reject. Only RFC 7505 Null-MX is a definitive reject.
- Score is computed as a blend (tunable weights in DB): domain-local `verified_count` support (dominant, log-scaled) + verification outcome quality + recency decay + size-conditioned prior floor, then provider-class caps applied.

**Never a bare `unknown`:** every response carries status + numeric score + ≥1 machine-readable `reason_code` (e.g., `pattern_learned_domain`, `pattern_prior_small_company`, `provider_m365_cap`, `catch_all_cap`, `dns_null_mx`, `smtp_5_1_1`, `gateway_policy_block`, `backend_degraded`, `collision_risk_high`).

Bands are seeded from the BounceZero 3,006-address / ~210-company audit and labeled "audit-seeded" until the P1 recalibration loop has real outcome volume. No headline accuracy percentage is ever marketed.

---

## 5. Data Model (conceptual)

Two hard boundaries: (a) the shared `kb` schema is company/domain-level only and **physically cannot express person data** (no name/email columns; CI test fails any migration adding personal-data columns to `kb.*`); (b) person-level rows exist only in tenant scope with TTL. There is **no cross-tenant per-address verdict cache** (see decision D1).

### Tenant scope (person-level allowed, TTL'd)

| Table | Stores |
|---|---|
| `tenants` | Workspace/owner, plan, retention config (default 90d), spend caps |
| `api_keys` | `key_prefix` (indexed), `key_hash` = HMAC-SHA256(secret, pepper), scopes, `revoked_at`, `last_used_at`; live + test keys |
| `results` | Per-tenant person-level find/verify results: input echo, derived email, status/sub_status/score/reason_codes, `backend`, `evidence`, provenance (`source='derivation'`, request id), `verified_at`, `expires_at` (TTL). Doubles as the per-tenant verdict cache (24h billing dedupe, TTL freshness) |
| `usage_ledger` | One row per attempt; `billable` flag, credits delta, credit-backs, request id — retained past person-TTL with person-identifying fields nulled after TTL (billing-dispute audit trail) |
| `rate_counters` | Atomic UPDATE attempt-level rate-limit counters (pooled-connection-safe) |
| `idempotency_keys` | (key, endpoint, request hash, response ref) unique per tenant |
| `jobs`, `job_items` | SKIP LOCKED queue: status queued/claimed/done/failed, attempts, locked_by/locked_at, per-row results refs |

### Shared KB scope (`kb` schema — domain/company-level ONLY)

| Table | Stores |
|---|---|
| `kb.domains` | domain, `mx_enum` (EXPLICIT_MX/IMPLICIT_MX_FALLBACK/NULL_MX/NO_MAIL_HOST), provider tag, verifiability class, `is_catch_all`, spf/dmarc present, size bracket (user-supplied or null), `last_probed_at`, TTL |
| `kb.domain_patterns` | domain, pattern token (e.g. `{f}{last}`), `observed_count`, `verified_count`, `last_seen_at`, winning diacritic fold. Write-guard: `verified_count` never incremented from accept-all-domain probes |
| `kb.provider_fingerprints` | MX-suffix → provider → verifiability matrix (config-as-data) |
| `kb.pattern_priors`, `kb.blend_weights` | Size-bracket format priors and scoring weights — tunable data, seeded from the audit, never code constants |
| `kb.freemail_domains`, `kb.disposable_domains`, `kb.role_locals`, `kb.typo_domains` | Classification tables, cron-synced weekly from open repos |
| `kb.company_domains` (P1) | Normalized company name → ranked resolved domains (Brandfetch-cached, MX-gated) |
| `kb.calibration_seed` / `calibration_outcomes` (P1) | Band → realized-deliverability stats; seed from audit, later from feedback capture |

### Global compliance scope

| Table | Stores |
|---|---|
| `suppression_global` | Salted SHA-256 of canonicalized address (and optional domain-scoped entries) — **no plaintext, no source attribution, retained indefinitely** (legal-obligation basis); checked pre-derivation and pre-verification on every path |
| `objection_requests` | Pending mailbox-ownership confirmations (token, expiry); manual-review fallback queue |
| `ops.verifier_spend` | Per-tenant and global daily spend counters backing caps + kill switch |

**Controller/processor split:** mailmetero is processor for tenant-submitted person data and per-tenant results; controller for the shared KB (no personal data) and the suppression list. DPA baked into ToS; published subprocessor list (verifier API, Neon, Render, ESP).

---

## 6. Verification Pipeline (cheapest-first) & Pluggable Backend

Every result records which stage produced it (`evidence`) and the backend (`api` | `none`; `smtp` reserved for the P2 probe node).

| Stage | Check | Cost | Outcome |
|---|---|---|---|
| 0 | Canonicalize (lowercase, strip `+tag`) + syntax + typo-domain correction (`gnail→gmail`) | free | `invalid/invalid_syntax` (free, unbilled) or corrected input |
| 1 | **Global suppression check** (salted hash) | free | Suppressed → constant-shaped not-found/`unknown` response; pipeline stops; observationally identical to no-result |
| 2 | Freemail / disposable / role tables | free | `webmail` / `disposable` / `role` terminal statuses |
| 3 | Per-tenant result cache (TTL-fresh) | free | Cache hit → return (billing dedupe applies) |
| 4 | Shared KB domain facts | free | `NULL_MX`/`NO_MAIL_HOST` → `invalid`; known catch-all/M365 → **skip paid verify entirely**, return capped `accept_all` with pattern-driven score |
| 5 | DNS via DoH (Google + Cloudflare fallback), typed enum, cached in `kb.domains` with TTL | ~free | `IMPLICIT_MX_FALLBACK` → cap 60; fresh MX data feeds stage 6 |
| 6 | Provider fingerprint (MX suffix) + verifiability matrix | free | Routes to 7 or short-circuits per matrix (`microsoft365: UNVERIFIABLE`, `google_workspace: VERIFIABLE_WITH_CATCHALL_GUARD`, `gmail/yahoo consumer: UNKNOWN`, gateways: `CONFIG_DEPENDENT` with 5.1.1-vs-5.7.1 parsing) |
| 7 | **`VerifierBackend` paid call** — finder: top-3 candidates only (hard per-request budget); verifier: single address. Vendor absorbs greylisting internally; no greylist state machine in v1 | ~$0.0004–0.004/check | Definitive verdict, or degrade |
| 8 | Score + respond + write back: domain-level KB updates (pattern counts under write-guard, catch-all verdict, fingerprint), tenant result row, ledger row | free | — |

**Degradation:** if the backend errors/times out (finder budget ~8s total), the service returns pattern+MX+fingerprint scoring with `backend=none`, `sub_status=backend_unavailable`, unbilled — the service never pretends to verify.

**`VerifierBackend` interface (P0):** `verify(email, context) → {verdict, sub_status, raw_smtp_code?, enhanced_code?}` — implementations: `HttpsApiBackend` (v1 default), `SmtpProbeBackend` (P2, Hetzner node over authed HTTPS), `NullBackend` (degradation). Vendor ToS must be reviewed pre-contract for the right to power a commercial verification service; a second vendor adapter is kept spec'd on the shelf.

**Unit-economics check (resolves the critics' demand for arithmetic):** worst case, every find pays for 3 verifier checks at $0.0004–$0.004 → **$0.0012–$0.012 per find with zero cross-tenant address caching** — under the $0.02 target before the KB/short-circuit savings (M365/catch-all skip, Null-MX, per-tenant cache) are even counted. The risky cross-tenant cache buys savings the economics do not need.

---

## 7. Compliance Features (P0 — launch-gating)

1. **Global hashed suppression list**, checked before derivation output and before any verification call, on every code path (CI-enforced test). Suppressed responses are **observationally equivalent to not-found** — no distinguishable status, error code, timing, or shape (an objection is itself private information).
2. **Public objection/erasure form** (`POST /v2/objections` + hosted page): verifies control of the target mailbox via a confirmation link before writing the irreversible suppression hash; rate-limited, constant-shaped acknowledgments; documented manual-review fallback with proportionate identity evidence (anti-poisoning: a competitor must not be able to suppress a company's address book).
3. **Per-tenant DSAR endpoints**: export + delete, automated, tenant-scoped; operator runbook for cross-tenant/controller-side requests; per-result provenance (`source='derivation'`, input echo, request id) so DSAR answers name actual sources (the Kaspr failure).
4. **TTL retention**: default 90 days on every person-level row, nightly purge cron, monitored zero-overdue-rows invariant (90d ≈ recycled-spam-trap staleness window — minimization and freshness are the same mechanism).
5. **Schema-level KB guard**: shared `kb.*` tables have no personal-data columns; CI invariant fails any migration that adds one. The central legal claim ("our shared learning contains no personal data") is mechanically demonstrable.
6. **Code-level egress allowlist**: outbound network restricted to DoH resolvers, the verifier API, the ESP, (P1: Brandfetch) — zero LinkedIn fetches, mechanically auditable per release.
7. **Privacy posture pack** (content, not code): Art. 14-satisfying public "how we derive emails and what we store" notice; written LIA on file; AUP/ToS requiring customers' CAN-SPAM/GDPR/PECR compliance (facilitator-theory insulation); published subprocessor list; DPA in ToS. No compliance numbers hard-coded in docs (CAN-SPAM cap adjusts annually — link out).
8. **No cross-tenant person data anywhere** — the non-data-broker architecture (no CA Delete Act registration, no DROP, no third-party audits) as a one-page procurement answer.

---

## 8. Resolved Key Decisions

| # | Topic | Decision | Rationale |
|---|---|---|---|
| D1 | **Cross-tenant per-address verdict cache** | **Rejected for v1.** Verification verdicts cache per-tenant only; cross-tenant sharing is strictly domain-level facts | All three critiques flagged this as the field's biggest silent contradiction of the fixed company/domain-level-only KB decision (a hashed email→verdict store is still pseudonymized personal data / a person-level graph). Decisive: the arithmetic shows the cache is unnecessary — top-3 × $0.0004–0.004 = $0.0012–0.012/find, under the $0.02 target with zero cross-tenant caching. No legal risk taken for savings that aren't needed. Revisit post-v1 only with counsel sign-off |
| D2 | API namespace & compat | Single `/v2` namespace mirroring Hunter's actual surface (GET verbs, param names, `{data, meta}` envelope, status enum, 202-async); all native capability additive-only | Critics: dx-api-first's GET /v2 mirror is the only version of the "one-line migration" claim that is mechanically true; POST /v1 shapes falsified other proposals' own headline. Two namespaces double drift risk |
| D3 | Finder input contract | `domain` required at launch; `company`-only → documented `domain_required` error; Brandfetch resolver is P1-1 and completes Hunter parity | Critics' consensus best-idea (cuts a third-party integration from the critical path) combined with their honesty objection: ship the cut, fix the claim — the migration table documents the gap instead of marketing "drop-in" falsely |
| D4 | Sync vs async verify | Sync fast-path when cache/KB/DNS resolves in ~2s; otherwise `202` + `Location` polling (Hunter's documented pattern). Finder is sync with ~8s budget and `backend=none` degradation | Hunter-faithful (existing client retry logic works), maps 1:1 onto the fixed web+worker/SKIP LOCKED split, and never blocks a dyno on slow verifications |
| D5 | Suppression semantics | Salted-hash global list; checked pre-derivation and pre-verification; responses observationally equivalent to not-found; **no `suppressed_contact` error code**; mailbox-ownership confirmation on the objection form | Critics unanimously flagged dx's `suppressed_contact` code as a privacy leak (an objection-enumeration oracle) and endorsed compliance-first's design; deletion without suppression is non-compliant (re-derivation); ownership proof blocks list-poisoning of an irreversible list |
| D6 | Tenant DSAR delete vs global suppression | Tenant `DELETE /v2/data-subjects` removes only that tenant's rows; global suppression is written **only** via the subject-verified objection flow | A tenant cleaning its data is not the data subject objecting; conflating them would let any tenant globally and irreversibly suppress addresses it doesn't own |
| D7 | KB integrity enforcement | Schema-level: `kb.*` physically has no person columns + CI migration invariant; `verified_count` never incremented from accept-all-domain probes | Critics' top-rated idea (policy will eventually be violated by a convenient migration; schema cannot); the write-guard closes the KB-poisoning hole all five proposals missed (on catch-all domains every candidate "verifies") |
| D8 | Priors & scoring | All format-share percentages, size-bracket priors, and blend weights are tunable Postgres tables seeded from the BounceZero audit — never code constants | Dossier verification found vendor distribution numbers internally inconsistent marketing folklore; domain-local verified evidence must be able to overwrite seeds |
| D9 | Collision handling | Emit BOTH middle-initial and numeric-suffix candidates at equal prior weight + `collision_risk` flag; per-domain learning decides precedence | Verifier correction: middle-initial-first precedence is org-specific, not universal; assuming an ordering bakes in a known error |
| D10 | M365 / catch-all policy | Fingerprint-first short-circuit: skip paid verifier spend entirely; `accept_all` with pattern-driven score capped at 84; never `valid` from 250, never `invalid` from lone 550 5.4.1; published rationale = anti-enumeration + hybrid relay (corrected mechanism, not "DBEB off") | Honesty and unit economics from the same rule (critics' best-idea); ZeroBounce's July 2026 M365 update means the lane is contested — the differentiator is documented calibration + billing alignment, not the taxonomy alone |
| D11 | Billing unit | One credit type; bill only definitive verifier outcomes (`valid`/`invalid`, except free `invalid_syntax`) and finder results at score ≥ 70; everything else free; auto credit-back on 30-day downgrade; `X-Billed` on every response; every decision reconstructible from the ledger | Outcome-conditional billing is a day-one schema decision (attempt vs billable rows) and the strongest incentive-alignment signal; free non-answers are covered against abuse by D12 |
| D12 | Abuse & spend control | Rate-limit **attempts**, not billable results; per-tenant daily verifier-spend caps; global spend kill switch; email-verified signup + per-IP limits + disposable-domain blocking on the free tier | Critics: free unknowns make bulk fishing a direct cash drain in four of five designs; only attempt-level quotas close it |
| D13 | Idempotency | `Idempotency-Key` required on bulk POSTs (unique per tenant, stored response ref); GET unit endpoints deduped via 24h per-tenant request-hash cache — retries never double-bill or double-spend | Critics' missing-item consensus: with outcome-conditional metering, a retried request double-bills; this is a schema/contract decision that cannot be retrofitted cleanly |
| D14 | Greylist machinery | No greylist retry state machine in v1; job-level retries with backoff for vendor errors only. Full (domain,address)-keyed greylist handling ships with the P2 SMTP probe node | Critics: HTTPS verifier APIs absorb greylisting internally — the state machine is dead code on the v1 critical path |
| D15 | Feedback & calibration | P1 `POST /v2/feedback` is capture-only; **no credit-back-for-bounce-reports incentive** in v1 (P2 at earliest, gated on anti-gaming design); bands ship "audit-seeded, recalibrated monthly" | Critics unanimously: paying tenants (in credits) to report bounces incentivizes fabricating the exact ground truth the calibration moat depends on |
| D16 | OpenAPI & MCP sequencing | OpenAPI 3.1 hand-written source of truth at P0 (CI response validation, docs + fixture catalog generated from it); MCP server at P1 as the first post-freeze fast-follow, thin client of the public API | Brief says ship both near launch; critics flagged P2-MCP as a flaw but also flagged 14-item P0s as unbuildable. Ship-fast's P1 placement ("REST must stabilize first") drew no critic objection — that is the consensus position |
| D17 | Auth compat | Bearer primary; Hunter's `api_key=` query param accepted, marked deprecated, redacted from logs, `Deprecation` header emitted | Real Hunter integration code passes keys in query strings; rejecting it silently breaks the migration promise; accept-but-redact contains leakage risk |
| D18 | Error format | Hunter-style `{errors:[{id, code, details}]}` with a frozen code registry + remediation text; not RFC 9457 | Compat wins over purity: migrating clients already parse this envelope; DX value is stable machine codes, not media type |
| D19 | Transactional email | One ESP (Postmark-class) behind a thin interface at P0; SPF/DKIM/DMARC-aligned; used for signup verification, objection confirmation links, quota alerts | Critics' missing-item in all three reviews: signup and the objection flow *require* deliverable email, and an email-deliverability company whose signup mail lands in spam is dead on arrival |
| D20 | DB tooling & connections | `node-pg-migrate` on the unpooled URL; node-postgres app pools sized under Neon `max_connections` (web pooled, worker/cron unpooled); rate limiting via atomic UPDATE counters (no session advisory locks); worker idle backoff 30–60s | Fixed-stack translation of the brief's Python-flavored plan (critics' missing item); session advisory locks break behind PgBouncer; 1s polling burns Neon CU-hours |
| D21 | Verifier vendor risk | MillionVerifier-class vendor behind `VerifierBackend`; **pre-contract ToS review** confirming the right to power a commercial verification service; second adapter spec'd on the shelf (P2 to productionize) | Critics: a ToS termination on the default backend is existential and "second adapter" addresses outages, not contract risk — so the contract check is a launch-checklist item |
| D22 | Domain-search | Never build "list people at a company." P1 `GET /v2/domains/{domain}` returns the learned domain-level KB row instead | A person-listing endpoint requires exactly the cross-tenant person database that triggers data-broker duties; domain-intel monetizes the same KB legally and is a product surface database-less competitors cannot copy |
| D23 | Deploy posture | Paid Starter web + worker from day one (~$14–20/mo); never demo on free tier | Free-tier spin-down (~1 min cold start) makes an API product look broken; also free tier blocks SMTP ports |

---

## 9. Non-Goals (explicit)

- **Any LinkedIn fetching, scraping, accounts, browser extensions, or scraped-data vendor ingestion** — permanent architectural exclusion, not a deferral. LinkedIn URLs are parsed only as user-pasted text. Docs never cite hiQ as making scraping "legal."
- **Domain-search / employee-listing endpoint** (Hunter's flagship) — refused permanently; requires the cross-tenant person database the architecture forbids. `GET /v2/domains/{domain}` (P1) is the deliberate replacement.
- **Cross-tenant person-level data of any kind** — including hashed verification-verdict caches (v1 ruling, D1).
- **Email sending, sequences, or campaign features** — staying a finder/verifier keeps mailmetero outside CAN-SPAM initiator/facilitator scope.
- **Published headline accuracy percentage** — replaced by calibrated per-result confidence and a published methodology.
- **Web dashboard beyond minimal signup/key management/usage** — the API, docs, and OpenAPI spec are the v1 product surface.
- **Hand-maintained official SDKs** — the OpenAPI 3.1 spec + documented generator commands instead; SDKs are a demand-driven v2 decision.
- **Team seats, RBAC, SSO, multi-workspace orgs** — one tenant = one workspace = one owner in v1.
- **CSV upload / bulk-list UI** — bulk is JSON-array API only; CSV parsing is client-side.
- **Stripe self-serve checkout at launch** — free tier + manually provisioned paid keys first (ledger schema ships day one; automation is P1).
- **Self-hosted SMTP probing from Render** — never, on any tier; the probe node (P2) is external infrastructure only.
- **Company-homepage crawling** for observed emails — legally defensible but deferred; v1 sources are user input + DNS/MX + verifier API only.
- **Phone numbers or non-email enrichment.**
- **CA data-broker registration / DROP integration** — deliberately avoided by architecture, not implemented.

---

## 10. Success Metrics

**Adoption & DX**
1. Time-to-first-successful-call < 5 minutes from signup (signup → first 2xx on a live key); sandbox→live key conversion tracked.
2. Week-4 API-key retention (key still making calls 28 days after first call); free→paid conversion once P1 billing ships.

**Accuracy & honesty**
3. Top-3 verified hit rate ≥ 85% replaying the BounceZero 3,006-address audit through the hosted pipeline (parity with the offline tool); top-1 ≥ 77% on verifiable-provider domains.
4. Calibration error: realized deliverability per published band within ±7 points of the band's meaning; realized bounce rate < 2% on results with score ≥ 90 (the ESP kill-line the marketing promises).
5. Zero bare unknowns: 100% of responses carry status + score + ≥1 reason code + producing backend (automated contract test).

**Economics & flywheel**
6. Blended wholesale cost per billable find < $0.02 (verification bundled), measured from the attempt/billable ledger — with the no-cross-tenant-cache architecture (D1).
7. KB flywheel: % of finder requests answered with a learned per-domain pattern (70+ band via KB hit) > 35% by month 3, rising monotonically; paid-verifier calls per billable result trending down.
8. Attempt:billable ratio monitored from launch (catch-all-heavy traffic detection); credit-backs < 3% of billed events; zero unresolvable billing disputes (ledger + `X-Request-Id` reconstruction).

**Performance**
9. p95 < 2s for sync-resolvable requests on KB-warm domains; p95 < 8s including verifier calls; zero requests hang past budget (degrade to `backend=none` instead); 202-deferral rate and median job completion tracked.

**Compliance (measured, not vibes)**
10. Suppression checked on 100% of find/verify code paths (CI-enforced); zero person-level columns in `kb.*` (CI invariant green every release); zero tenant rows alive past TTL+24h (cron monitor); DSAR delete < 24h automated; egress-allowlist audit passes every release (zero LinkedIn-derived bytes); privacy notice + subprocessor list + objection form live before the first external API key.

**Infra**
11. Footprint holds at ~$14–20/mo at demo scale (validates backoff polling + TTL caching against Neon CU-hours).

---

## 11. Open Questions (tracked, non-blocking unless noted)

1. **Counsel review (pre-EU-marketing):** confirmation that per-tenant-only verdict storage + domain-level KB + salted-hash suppression list keeps mailmetero outside CA Delete Act data-broker scope and that the suppression hash's GDPR treatment (legal-obligation basis, indefinite retention) is sound.
2. **BounceZero audit dataset provenance:** confirm the 3,006-address dataset's collection context permits commercial reuse as domain-aggregated seed data (cheap to verify, embarrassing to discover later). **Launch-checklist item.**
3. **Verifier vendor ToS:** does the chosen vendor's contract permit powering a competing commercial verification service? **Blocking for vendor selection (D21).**
4. **Hunter domain-search dependence:** what fraction of real Hunter integrations call domain-search and would hard-break on switch? Determines how the migration table frames the refusal.
5. **Catch-all prevalence in real traffic** (vendor figures range 8–45%): measured from our own KB; if high, the billable-rate and pricing assumptions need revisiting.
6. **EDPB Guidelines 03/2026** (final text expected late 2026): may tighten expectations for scraping-adjacent services; privacy notice + LIA to be revisited on publication.
7. **Ledger/KB growth:** partitioning/archival plan for `usage_ledger` and `kb.domains` before they pressure Neon storage pricing (not a v1 problem; needs a trigger metric).
8. **Pepper rotation:** multi-pepper verification window design for `APP_PEPPER` rotation without invalidating customer keys (runbook item before first paying customer).
