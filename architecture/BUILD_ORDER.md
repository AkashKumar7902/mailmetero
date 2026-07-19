# mailmetero — BUILD_ORDER (units in dependency order + acceptance)

Units come from `FILE_MANIFEST.md`. `parallel_group` N means all units in group N can be built
concurrently once every unit in groups `< N` is done and green. A unit is "done" only when its acceptance
check passes. Global gates (DAG, frozen registries, kb-no-PII, cap ceilings, suppression-on-all-paths,
OpenAPI response validation) are U12 and run last, but several are cheap enough to wire earlier.

```
group 0:  U0 (scaffolding)     U1 (contracts)
group 1:  U2 (config)          U3 (core)
group 2:  U4 (db)   U5 (dns)   U6 (verifier)   U7 (email)
group 3:  U8 (pipeline)
group 4:  U9 (api)   U10 (worker)   U11 (cron)
group 5:  U12 (CI compliance tests)
```

Critical path: **U1 → U2 → U4 → U8 → U9**. `core` (U3), `dns` (U5), `verifier` (U6), `email` (U7) are off
the critical path within their groups and unblock as soon as their group predecessors are green.

---

## Group 0

### U0 — Root scaffolding & workspace
- **Build:** `corepack enable && pnpm install --frozen-lockfile` resolves; `pnpm -r build` runs (empty
  packages ok); `dependency-cruiser --validate` loads config.
- **Acceptance:** `pnpm install` succeeds with isolated node-linker; `render.yaml` declares web + worker +
  **7** cron services; `.node-pg-migraterc.json` points at the unpooled DSN + `packages/db/migrations`;
  `.env.example` mirrors the extended `Env` (incl. `VENDOR_DIR`, pool/api/cents fields).

### U1 — @mailmetero/contracts
- **Build:** `pnpm --filter @mailmetero/contracts build` (tsc, strict).
- **Acceptance:** all 7 member modules compile; barrel exports resolve; `DEFAULT_SCORING_CONFIG` is
  `Object.freeze`d; `JOB_KINDS`/`JOB_ITEM_STATUSES`/`DomainPatternObservation`/`BillingInput` present. No
  `suppress|object|blocked_contact` token in any enum/registry (proven later by U12 grep, but assert here).

---

## Group 1

### U2 — @mailmetero/config
- **Build:** `pnpm --filter @mailmetero/config build` + unit tests.
- **Acceptance:** `loadAppConfig()` returns `{env, database, api, spend, vendorDir}`; spend caps are
  **cents** (USD env × 100); `EnvError` aggregates all problems; `buildEgressPolicy` yields only configured
  hosts (no wildcard, no `raw.githubusercontent.com`, no LinkedIn); `createEgressFetch` blocks a
  non-allowlisted host AND a redirect to one; `redactString` scrubs `sk_*`/`Bearer`/`api_key=`/DSN pw.

### U3 — @mailmetero/core
- **Build:** `pnpm --filter @mailmetero/core build` + unit tests.
- **Acceptance:** `parseNicknamesCsv` builds bidirectional map from the triple CSV (`bob→robert/rob/bobby`
  AND `robert→bob/bobby/rob`); `canonicalizeDomain` reduces to eTLD+1 + punycode; `generateCandidates`
  emits BOTH collision candidates at equal weight with `collision_risk`, dedupes, clamps to
  `MAX_CANDIDATES=25`, ≥1 reasonCode each; **cap-ceiling property test passes** —
  `m365||isCatchAll ⇒ score≤84 && status≠'valid'`, prior-only on those `≤55`, `IMPLICIT_MX_FALLBACK ≤60`,
  `NULL_MX ⇒ 'invalid'/'null_mx'`; no literal `84/60/55/70` in scoring source (ESLint green).

---

## Group 2 (all four parallel)

### U4 — @mailmetero/db (critical path)
- **Build:** `pnpm --filter @mailmetero/db build`; then integration (gated on `DATABASE_URL_TEST`):
  `pnpm migrate up` applies 0000–0008 with **zero errors** (proves no duplicate CREATE, no non-IMMUTABLE
  generated column).
- **Acceptance:**
  - Migrations round-trip (up→down→up) and seeds are idempotent (`migrations-roundtrip.test.ts`).
  - **`assertKbHasNoPersonColumns` passes** on the scratch-migrated DB; adding a person column to any
    `kb.*` table makes it fail (authoritative D7 gate).
  - `decideBilling`: verifier `null_mx`/`no_mail_host` (evidence `dns`, backend `none`) ⇒ **billable**;
    degraded (`evidence='degraded'`) ⇒ free; finder `score≥70 && !accept_all && !degraded && hasEmail` ⇒
    billable; `invalid_syntax` ⇒ free.
  - `LedgerRepo.recordAttempt` is idempotent on `(tenant_id, request_id)` (second call ⇒
    `creditsDeltaApplied=0`).
  - `JobsRepo.claim` uses `FOR UPDATE SKIP LOCKED`; two concurrent claimers never claim the same job.
  - `ScoringConfigRepo.activate` flips the active row in one tx without violating the partial unique.
  - `seedClassificationTables` filters the freemail junk lines (`404: not found`, `asean-mail`,
    `housefancom`, `multiplechoices`) and punycodes IDN disposables; vendor dir resolved via absolute anchor.
  - Single kill switch: `VerifierPolicyRepo.getPolicy` + `SpendGuard.check` read `ops.verifier_policy`
    only; spend is in **cents**.

### U5 — @mailmetero/dns
- **Acceptance:** `classifyMx` unit tests cover Null-MX (`MX 0 .`), implicit-MX fallback, no-mail-host,
  multi-MX preference sort — no network; `createDnsResolver` falls back Google→Cloudflare on
  timeout/error and returns `NO_MAIL_HOST` on NXDOMAIN (never throws); `fingerprintProvider` resolves
  `gmail.com→gmail_consumer` vs custom-domain-on-aspmx→`google_workspace`; longest-suffix wins; DoH uses
  the injected `EgressFetch`.

### U6 — @mailmetero/verifier
- **Acceptance:** `classifySmtpCode` maps 5.1.1→invalid_mailbox, 5.7.1→gateway_blocked, lone 550 5.4.1 on
  UNVERIFIABLE→accept_all (never invalid); `createHttpsApiBackend` **clamps** UNVERIFIABLE/UNKNOWN so they
  can never emit `valid` (D10 defense-in-depth); timeout→unknown; catch-all probe returns `isCatchAll` on
  random-local acceptance (deterministic rng). Zero live vendor calls in tests.

### U7 — @mailmetero/email
- **Acceptance:** template builders produce SPF/DKIM/DMARC-aligned `OutboundEmail` with `tag===kind`;
  `makePostmarkBackend` posts via injected `EgressFetch` (allowlisted host only); `makeNoopBackend`
  captures without sending; imports `Logger` from config (no re-declaration).

---

## Group 3

### U8 — @mailmetero/pipeline (critical path)
- **Build:** `pnpm --filter @mailmetero/pipeline build` + tests with ALL ports/DnsResolver/VerifierBackend
  faked (zero live network).
- **Acceptance:**
  - `buildStages()` returns stages ordered 0..8; `buildStages()[1] === makeSuppressionStage()` with
    `appliesTo ⊇ {finder,verifier}`.
  - M365 short-circuit: fingerprint `microsoft365` ⇒ capped `accept_all` (≤84), **no** verifier call made.
  - Null-MX ⇒ `invalid`/`null_mx` terminal; catch-all guard runs for `google_workspace` before per-address
    verify; budget exceeded ⇒ `backend='none'`, `evidence='degraded'`, `deferred` on verifiable provider.
  - Suppression: suppressed domain (finder) and suppressed address (verifier) both return the constant
    not-found-shaped output; finder stage 8 filters an address-suppressed chosen candidate.
  - Every output carries ≥1 reason code; pipeline writes `kb.*` only (no results/ledger); output carries
    `BillingInput` and (finder) `deferrable:false`, (verifier) `deferred` variant.
  - `createCoreAdapter` injects priors/config into `core.generateCandidates` and decomposes
    `VerificationEvidence` into `core.scoreDerivation`; `ScoreOutput.status` is `VerifyVerdict`.
  - `toFinderResult`/`toVerifierResult` produce spec-valid wire shapes.

---

## Group 4 (all three parallel)

### U9 — @mailmetero/api (critical path)
- **Build:** `pnpm --filter @mailmetero/api build` + route tests with faked ports.
- **Acceptance:**
  - Hook chain order: request-id→auth (onRequest); getIdempotency→rateLimit (preHandler); settleBilling in
    handler; standard+deprecation headers on onSend for success AND error.
  - Every response carries `X-Request-Id`/`X-Billed`/`X-Credits-Remaining`/`X-RateLimit-*`; `api_key=`
    emits `Deprecation` and is redacted from logs.
  - `settleBilling` uses db `decideBilling` (no local predicate); exactly-once via `ctx.billedApplied`;
    `X-Credits-Remaining` accurate before send. GET replay (idempotency_keys request_hash) does NOT
    consume an attempt or re-bill.
  - Verifier: sync `ok`→200; `deferred`→202 + `Location:/v2/verifications/{id}`, `X-Billed:0`; poll
    `pending`→`job_pending` 202+`Retry-After`; `failed`→503; missing→404. `getVerification` returns **wire**
    `VerifierResult` (no re-map).
  - Bulk: `Idempotency-Key` reserve/replay/conflict; `>1000`→`payload_too_large`; 202 `{job_id,status,count}`.
  - Sandbox (`sk_test_`): `FIXTURE_STATUS_COVERAGE` all-true (every Status + 202 + error cases), 0 credits,
    isolated limit. `validateResponseAgainstSpec` passes for every operation/status AND every fixture
    (status + numeric score + ≥1 reason_code + backend present).
  - `domain` missing→`domain_required`; suppression is invisible (no code branches on it).

### U10 — @mailmetero/worker
- **Acceptance:** `runWorkerLoop` claims a batch, processes items under the concurrency semaphore,
  heartbeats, and completes; empty claim ⇒ sleeps random [30s,60s]; per-item `requestId =
  ${job.requestId}:${rowIndex}` is stable across a requeue so `recordAttempt` never double-bills and never
  under-bills; item results stored as **wire**; SIGTERM drains within grace. Runs on the unpooled pool.

### U11 — @mailmetero/cron
- **Acceptance:** `runCron(name)` dispatches each of the 7 jobs and exits non-zero on failure; `ttl-purge`
  asserts zero overdue rows after purge (Success Metric 10) and nulls `usage_ledger.result_id`;
  `credit-back-sweep` issues one credit-back per downgraded attempt (no double refund); `blocklist-sync`
  re-seeds from the vendored dir with **no network egress**; `objection-expiry` nulls stale pending tokens.
  Each returns a `CronJobReport{ok,durationMs,metrics}`.

---

## Group 5

### U12 — CI compliance tests
- **Acceptance (launch-gating):**
  1. `check-dag` — every `@mailmetero/*` import edge ∈ ALLOWED (§2); no cycles.
  2. `check-frozen-registries` — snapshot pins all enum/registry members.
  3. `check-no-suppression-leak` — no `suppress|object|blocked_contact` member.
  4. `check-kb-no-pii` — source-grep backstop of db migrations (db runtime test is the primary gate).
  5. `check-suppression-paths` — asserts `buildStages()[1]===makeSuppressionStage`,
     `appliesTo⊇{finder,verifier}`, and stage 8 references `SuppressionPort`.
  6. `check-egress-allowlist` — no raw network APIs outside `@mailmetero/config`; derived allowlist has only
     configured hosts.
  - `tools/test/setup-integration.ts` skips (never fails) Neon suites when `DATABASE_URL_TEST` is absent.

---

## Definition of done (whole system)

All units green + `pnpm -r build` + `pnpm -r test` (unit) + the six U12 invariants + an integration run of
`pnpm migrate up` on a throwaway Neon branch that ends with `assertKbHasNoPersonColumns` passing and a
smoke `GET /healthz` 200. render.yaml boots web+worker+7 crons; the OpenAPI doc at `/v2/openapi.json`
validates against every handler's real output.

**Known launch-checklist follow-ups (not blockers):** replace the placeholder `kb.pattern_priors` /
`kb.blend_weights` seed VALUES with the real BounceZero 3,006-address audit export (PRD OQ#2); complete the
D21 verifier-vendor ToS review before enabling live paid verification.
