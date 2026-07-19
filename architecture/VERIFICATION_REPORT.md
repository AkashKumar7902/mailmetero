# mailmetero v1 — Verification Report

**Verification lead summary of the multi-agent review.**
Date: 2026-07-19 · Scope: mailmetero v1 (api / pipeline / core / db / worker / cron / config packages) · Method: static verification of ranked findings + a live end-to-end run against the Neon-backed API.

Tally: **2 blockers · 12 majors · 9 minors** confirmed. Live E2E: **PASS** (6/6 scenarios).

---

## 1. Executive Summary

**Is v1 sound? Not for launch.** The core request/response machine is healthy — the live E2E confirms auth, key scheme (`sk_live_`/`sk_test_`), finder ranking, verifier sync→202 deferral, account/usage, bulk intake + idempotency replay, and the sandbox fixture path all behave correctly end-to-end against the real database. The build boots, migrates against Neon, and serves clean 200s with the expected billing/credit headers on synchronous paths.

**But the compliance spine — the product's flagship legal invariant — is non-functional.** Two blockers make the "suppression honored on every path" guarantee inert:

1. The **objection → global-suppression pipeline is completely unwired** (`adapters.ts:402`). `createObjection()` returns a throwaway UUID and never calls the real repo; there is no `/v2/objections/confirm` route; the suppression table can therefore *never* be populated, so every downstream suppression check silently returns `false`. PRD D5 / §7.2 is implemented in the leaves but dead at the root.
2. Even where suppression *is* wired (the finder path), an **address-suppressed candidate is SMTP-probed by the third-party vendor before the address-scope check runs** (`verifier-backend.ts:105`), violating PRD §7.1's P0, CI-enforced "checked before any verification call, on every code path." An address-only objector's real email leaks to a subprocessor.

**Risk profile:** The blockers are legal/compliance (GDPR/CAN-SPAM) and would ship a product that claims an opt-out guarantee it cannot honor. The 12 majors cluster into three themes: **billing integrity** (implicit-MX over-billing, non-atomic exactly-once debit, unpinned deploy runtime), **abuse surface** (two public unauthenticated intake endpoints with zero rate limiting → email-bombing + free-tier farming), and **untested financial/concurrency invariants** (exactly-once billing, catch-all guard, KB write-guard, SKIP LOCKED job claim, spend cap — all asserted only against fakes, so a regression ships green). The minors are correctness paper-cuts (attempt off-by-one, German name folding), contract/OpenAPI completeness gaps, and weak/mock-only test assertions.

**Bottom line:** v1's happy-path plumbing is solid, but it must not launch until the two suppression blockers are wired and the public intake is throttled. The billing majors are cash-correctness bugs that should land in the same cycle; the test-coverage majors are the reason none of these were caught earlier and should be closed to protect the fixes.

---

## 2. Live E2E Outcome

Booted `packages/api/dist/index.js` (NODE_ENV=development, SERVICE_ROLE=web) on port 8151 against live Neon with a freshly minted `pro` tenant (1000 credits) + live/test keys. `/healthz` → 200, `checks.db:true`.

| # | Scenario | HTTP | Result | Notes |
|---|----------|------|--------|-------|
| 0 | Setup: mint tenant + `sk_live_`/`sk_test_` keys vs Neon | n/a | PASS | HMAC-SHA256(secret, APP_PEPPER), prefix=16 chars; unpooled DSN insert |
| 1 | GET `/v2/email-finder` stripe.com / Patrick Collison | 200 | PASS | 7 ranked candidates, top `patrick.collison@stripe.com` (61). backend=none dev degrade; headers X-Request-Id, X-Billed:0, X-Credits-Remaining:1000 |
| 2 | GET `/v2/email-verifier` someone@stripe.com | 202 | PASS | backend=none → documented sync→202-async fallback, job queued. X-Credits-Remaining omitted (nothing debited) |
| 3a | GET `/v2/account` | 200 | PASS | plan=pro, searches used:1/1000, verifications used:1/1000 |
| 3b | GET `/v2/usage` | 200 | PASS | credits_used:0, remaining:1000, attempts:1, by_day breakdown |
| 4 | POST `/v2/bulk/verifications` (3 emails + Idempotency-Key) → job → results | 202 | PASS | body is bare JSON array (object shape correctly 400s); idempotency replay returns same job_id; status/results endpoints correct |
| 5 | Sandbox `sk_test_` verifier + finder fixtures | 200 | PASS | deterministic fixtures (valid/98, jane.doe/96), never bills, routed to sandbox catalog without touching pipeline/ledger |

**Overall: PASS.** Honest deviations (all correct-by-design): (a) scenario 2 defers to 202 because backend=none can't settle synchronously; (b) X-Credits-Remaining is present on synchronous 200s but not on deferred 202s; (c) bulk body is a raw array, not `{emails:[]}`; (d) verifier backend=none in dev (no VERIFIER_API_KEY). Temp mint script and server were cleaned up afterward.

> Note: the E2E ran in dev degrade mode (backend=none, worker not running), so it exercises the request/billing/header surface but not live third-party verify or the async worker drain. Several confirmed findings live specifically in those un-exercised paths.

---

## 3. Confirmed Findings by Severity

### BLOCKERS (2) — must fix before launch

**B1 · Objection → suppression pipeline is entirely unwired (suppression can never be written)**
`packages/api/src/adapters.ts:402` (+ `routes/compliance.ts`, `db/repositories/objections.ts:57`, `suppression.ts`)
`createObjection()` returns `{ token: randomUUID() }` and never calls `objections.createPending()`; the real objections repo (`adapters.ts:90`) is dead code. The confirmation email links to `/v2/objections/confirm?token=…` (`adapters.ts:385`) but **no such route is registered** anywhere. `writeSuppression` is a closed entry point called only by `ObjectionsRepo.confirm()`, which is never invoked in production — so `suppression_global` is never populated and every `isSuppressed` check returns false. The random UUID could never match the base64url `token_hash` `createPending` mints anyway. PRD D5 / §7.2 flagship invariant is inert.
**Fix:** In the `POST /v2/objections` handler call `objections.createPending` (persist `token_hash` + salted subject/domain suppression hashes) and email that token. Register `GET /v2/objections/confirm` running `objections.confirm(token)` inside `withTransaction` so the status flip and `writeSuppression` commit atomically. Add an integration test: objection → confirm → `suppression_global` row → subsequent find/verify returns canonical not-found.

**B2 · Finder SMTP-probes an address-suppressed candidate before the address check runs**
`packages/pipeline/src/stages/verifier-backend.ts:105`
In finder mode, stage-7 calls `ctx.deps.backend.verify(target.email, vctx)` (the paid third-party call) with no address-scope filter. Finder stage-1 suppression checks **domain scope only** (`suppression.ts:27-30`: address hash pushed only when `mode==='verifier'`); the address check is deferred to stage 8 on the single winning candidate (`score-writeback.ts:118-120`) — *after* the vendor call. An address-only objector, searched by name at a verifiable/non-catch-all/non-M365 domain, has their real address probed by an external subprocessor. (Verifier endpoint is correctly guarded — stage 1 checks both scopes.) Violates PRD §7.1 P0, CI-enforced.
**Fix:** Filter all candidates against address-scope suppression immediately after `ctx.deps.candidates.generate` (orchestrator.ts) via a single batch `isSuppressed`; drop suppressed candidates before stage 7. If all suppressed, return canonical not-found.

### MAJORS (12)

**M1 · Confirmed-valid fast path skips the implicit-MX cap → wrong billing**
`packages/core/src/scoring/score.ts:165`
Case-1 (`verdict==='valid' && verifiable && !catchAll && !m365 && !degraded`) has no `input.mx` guard and returns `Math.max(VERIFIED_BAND_MIN, …)` = 95 with `capsApplied:[]`, bypassing `applyCaps` (`caps.ts:88-92`) that enforces `IMPLICIT_MX_MAX`=60. An implicit-MX (A-record fallback, provider `other` → GATEWAY_CONFIG_DEPENDENT) domain that SMTP-verifies as valid scores 95 instead of 60; since 60 < FINDER_BILLABLE_MIN(70) ≤ 95, the finder **wrongly bills a credit** for a result that should be free. Violates the file's own documented invariant (`score.ts:10`). Untested combination.
**Fix:** Add `input.mx === 'EXPLICIT_MX'` to the case-1 guard, or `Math.min` the case-1 score against the implicit-MX ceiling.

**M2 · API exactly-once billing: debit gated on recomputed predicate, no transaction**
`packages/api/src/adapters.ts:250`
`ledger.settle` runs `recordAttempt` then `tryDebitCredit` as two separate awaits on the pooled client with **no `withTransaction`**, and debits based on locally recomputed `decision.billable` instead of the ledger's returned `creditsDeltaApplied` (discarded). `requestId` is client-controllable (`X-Request-Id` echo); GET idempotency keys on the request *hash*, not request_id. So two distinct billable queries sharing one X-Request-Id: the second's `recordAttempt` hits ON CONFLICT DO NOTHING (no ledger row) yet `tryDebitCredit` still fires — a credit debited with no ledger attempt, diverging balance from ledger. The worker (`item.ts:137-139`) does this correctly.
**Fix:** Mirror the worker — wrap `recordAttempt`+`tryDebitCredit` in one `withTransaction`, drive the debit from returned `creditsDeltaApplied < 0`.

**M3 · Signup/objection intake has no rate limiting (contract branch never implemented)**
`packages/api/src/adapters.ts:393`
`createSignup(email)` drops the `clientIp` the route passes (`compliance.ts:37`) and never returns the contract's `{rateLimited:true}` branch (`deps.ts:140-143`). The rate-limit plugin skips public routes (needs `rateLimited:true` AND a principal). Each call unconditionally emails an attacker-supplied address → unbounded free-tier farming + email-bombing.
**Fix:** Implement per-IP (and per-target-email) throttle in `createSignup`/`createObjection` using the passed `clientIp`, returning `{rateLimited:true}` when exceeded; persist counters keyed by IP/email hash.

**M4 · Objection opt-out confirmation link built from ESP host, not API host**
`packages/api/src/adapters.ts:385`
`confirmUrl` uses `env.espApiBaseUrl` (default `https://api.postmarkapp.com`) instead of `env.publicBaseUrl` (default `https://api.mailmetero.com`). The link a data subject clicks points at Postmark and never reaches `/v2/objections/confirm`, so the irreversible global suppression is never written — opt-outs silently fail (GDPR/CAN-SPAM). (Compounds B1.)
**Fix:** Build `confirmUrl` from `env.publicBaseUrl`.

**M5 · Public intake unthrottled — anti-poisoning constant-shaped ack requirement unmet**
`packages/api/src/routes/compliance.ts:16`
`PUBLIC = {rateLimited:false}` on SIGNUP_CONFIG/OBJECTIONS_CONFIG; rate-limit plugin skips them twice (no `rateLimited:true`, no principal). The intended throttle `objections.recentByIp` (`objections.ts:103`) exists but is dead. Each request emails an attacker-supplied address. Violates PRD §7.2 "rate-limited, constant-shaped acknowledgments."
**Fix:** IP/subject-hash throttle before sending mail (wire `recentByIp` + signup equivalent), returning the same constant 202 whether accepted or throttled. (Overlaps M3 — fix together.)

**M6 · Mandatory response headers missing on most routes and all error paths**
`packages/api/src/headers.ts:36`
`applyStandardHeaders` emits `X-Credits-Remaining` only when `ctx.creditsRemaining !== null` and the `X-RateLimit-*` triple only when `ctx.rateLimit !== null`. Those are populated on a subset of routes only — `X-RateLimit-*` appears solely on finder+verifier; `X-Credits-Remaining` is absent on bulk POST/status/results, the poll, the verifier 202, and **every error response** (402/429/4xx). Violates PRD §3 / CONTRACTS_CORE §4.2 "every response carries all six," and the file's own docstring.
**Fix:** Guarantee all six unconditionally — for any authenticated principal load a read-only rate-limit snapshot + live credit balance into ctx before onSend; populate `ctx.creditsRemaining` from the tenant balance even on non-billed/error responses; emit the rate-limit triple from the unauth bucket on 401.

**M7 · Node.js version unpinned for deploy (engine-strict + TS-at-deploy) [PLAUSIBLE]**
`render.yaml:58`
`package.json` requires `node >=26.0.0`, `.npmrc` sets `engine-strict=true` (pnpm hard-fails on mismatch), and migrations run from uncompiled `.ts` needing native type-stripping (Node ≥23.6). `render.yaml` declares only `runtime: node` on all 9 services, with no `NODE_VERSION` env var and no `.node-version`/`.nvmrc`. Risk: relying on a `>=` range (not an exact pin) for a bleeding-edge major on Render's resolver. *PLAUSIBLE, not confirmed:* Render's native Node runtime also reads `engines.node`, so a hard failure isn't proven — but it's real robustness risk.
**Fix:** Commit an exact `.node-version` or add `NODE_VERSION` to the `mailmetero-shared` env group, pinned to a Render-supported version satisfying `>=26` (and necessarily `>=23.6`). Confirm Render offers Node 26; if not, relax `engines.node`/`engine-strict`.

**M8 · Exactly-once billing invariant tested only against a fake ledger**
`packages/worker/test/idempotency.test.ts:31`
The D11/D13 "retries never double-bill" assertion is produced entirely by a hand-written fake (`fakes.ts:192-211`) that re-implements ON CONFLICT dedup. The real `LedgerRepo.recordAttempt` SQL (`usage-ledger.ts:48-73`) and the partial unique index are exercised by no test. Dropping the index / changing the ON CONFLICT target would double-bill with all tests green.
**Fix:** DB-backed integration test: call the real repo twice with same `(tenantId,requestId)`; assert exactly one `kind='attempt'` row, `creditsDeltaApplied` = -1 then 0, balance debited once, and that the migration created the partial unique index.

**M9 · Catch-all guard's protective behavior untested**
`packages/pipeline/test/orchestrator.test.ts:117`
No test sets `probeCatchAll:true` (harness supports it, `harness.ts:108,140`, but it's never used), so nothing verifies that on a catch-all domain the paid per-address verify is skipped and the result becomes `accept_all` (never valid/invalid). This is the D7 KB-poisoning / D10 anti-enumeration guard (`verifier-backend.ts:85-92`).
**Fix:** Orchestrator test with `makeDeps({mx:GOOGLE_HOSTS, probeCatchAll:true})` asserting `verify.length===0`, `status==='accept_all'`, `score <= CATCH_ALL_ACCEPT_ALL_MAX`, non-billable.

**M10 · D7 verified_count write-guard untested on both sides**
`packages/db/src/repositories/kb-patterns.ts:69`
`bumpVerified` computes `verifiedInc = domainIsAcceptAll ? 0 : 1` but no DB test calls it with `true` to assert `verified_count` stays flat while `observed_count` bumps. The pipeline harness stub (`harness.ts:163-164`) discards all args, so no orchestrator test asserts the accept-all flag propagates. Only the schema half of D7 is tested.
**Fix:** (1) DB test: `bumpVerified(…,true)` vs `(…,false)`, assert verified_count advances only on false and never exceeds observed_count. (2) Make the harness record args; assert propagation on a catch-all domain. (Note: `acceptAllDomain` is passed to `recordPatternObservation`, not `upsertDomainFacts` — aim the assertion there.)

**M11 · FOR UPDATE SKIP LOCKED job-claim (concurrency spine) untested**
`packages/db/src/repositories/jobs.ts:186`
`jobs.claim()` is the only SKIP LOCKED in exercised code, but the worker loop test drives a scripted fake `claim()` (`fakes.ts:234-240`); the real `UPDATE…FROM(SELECT…FOR UPDATE SKIP LOCKED)` never runs. Two workers claiming the same job (D4/D20 exclusivity) is asserted nowhere; dropping SKIP LOCKED / the `run_after<=now()`/`status='queued'` predicate / the attempts increment ships green.
**Fix:** DB integration test: insert N queued jobs, issue two concurrent overlapping `claim()` calls, assert disjoint id-sets, each row `status='claimed'` + locked_by set + attempts incremented, and future-`run_after` rows not claimed.

**M12 · D12 verifier spend-cap / kill-switch decision untested**
`packages/db/src/repositories/verifier-spend.ts:65`
`SpendGuard.check` short-circuits `kill_switch > global_cap > tenant_cap` with `>=` boundary tests and is unit-testable with a fake Queryable, but no test exists. The orchestrator's coverage only tests an already-injected NullBackend degrading, bypassing the guard that decides injection.
**Fix:** Unit test with scripted policy/spend rows: kill switch ⇒ `{allowed:false, reason:'kill_switch'}` regardless of spend; global at cap ⇒ `'global_cap'`; tenant at cap ⇒ `'tenant_cap'`; just-under ⇒ `allowed:true` (pin the `>=` boundary).

### MINORS (9)

**m1 · Job attempt budget exhausted one early (off-by-one)** — `packages/worker/src/loop.ts:72`
`claim` already increments (`jobs.ts:194`), so `job.attempts` counts the current attempt; `attemptsSoFar = job.attempts + 1` double-counts → maxAttempts=N fails after N-1 executions. The sweep path (`jobs.ts:387`) uses correct `>= maxAttempts` semantics, confirming the loop guard is wrong. **Fix:** `const attemptsSoFar = job.attempts;` (backoff at line 77 already uses the incremented value correctly).

**m2 · German name folding over-generates variants** — `packages/core/src/name/german.ts:58`
`germanFoldVariants` collapses any `ue`/`oe`/`ae` digraph unconditionally: Bauer→baur, Samuel→samul, Neuer→neur. These bogus candidates get scored and can consume a scarce VERIFY_TOP_N paid slot. **Fix:** Only emit the collapsed form when the original token actually contained ä/ö/ü.

**m3 · Sync finder/verifier results never persisted → DSAR/TTL cover bulk only** — `packages/api/src/adapters.ts:94`
`void results;` — sync routes never call `results.insert`, so DSAR export/delete and 90-day TTL purge see only async-job results (asymmetric D6/§7). Retention-safe direction, but DSAR/TTL are vestigial for the primary path (and diverge from ARCHITECTURE.md:112). **Fix:** Persist sync results via `ResultsRepo.insert`, or document sync results as non-retained and scope DSAR/TTL consistently.

**m4 · status/sub_status pair legality never cross-checked** — `packages/api/src/openapi/validate.ts:73`
The validator checks Status and SubStatus as independent enums; `STATUS_SUBSTATUS` is never referenced in `packages/api`. An illegal pair (e.g. `valid`+`timeout`, `role`+non-null) passes `validateResponseAgainstSpec` and reaches the wire, contradicting the enum's "Enforced in response validation" comment. **Fix:** Add a STATUS_SUBSTATUS legality assertion to the validator (or `wire.ts` mapping) + a `contract.test.ts` case.

**m5 · Served OpenAPI omits accepted request surface** — `packages/api/src/openapi/spec.ts:199`
Finder operation lists only domain/first_name/last_name/full_name, dropping middle_name/max_duration/company/linkedin_url (all accepted + in PRD §3); both bulk POSTs declare no requestBody at all. **Fix:** Add the missing query params and requestBody schemas (arrays, `≤bulkMaxRows`) so the source-of-truth spec matches the accepted surface.

**m6 · API-key log-redaction guarantee rests on dead code + non-matching wildcard** — `packages/api/src/plugins/auth.ts:14`
`logRedactionPaths` is exported but never imported; the real redactor uses `*.api_key` (single-level wildcard, won't match `req.query.api_key`). No leak today because API sets `logger:false`, but the "redacted by the auth hook" comment is vacuous. **Fix:** Remove the dead export + correct the comment, or wire the API logger to config's redactor with a path matching the nested query param (+ scrub `req.url`).

**m7 · Credit-back double-refund guard tested only against a mock** — `packages/db/src/repositories/usage-ledger.ts:85`
The cron test's credited/skipped split comes from a fake returning `applied:false`; the real `ON CONFLICT (original_ledger_id) WHERE kind='credit_back' DO NOTHING` + `kind='attempt'` SELECT guard are unexercised — a missing partial index allows repeated refunds, green. **Fix:** DB test: insert a billable attempt, call `issueCreditBack` twice, assert exactly one `credit_back` row and that `findCreditBackCandidates` excludes already-credited attempts.

**m8 · Finder not-billable cases assert `.billable` but never `.reason`** — `packages/db/test/billing-policy.test.ts:62`
`policy.ts:50` returns `free_non_definitive` for all non-billable finder outcomes (below-threshold, no-email, accept_all); the test never pins `.reason`, so a mislabel undermining D11 ledger reconstructability is invisible. **Fix:** Assert exact `.reason` for the score-69, no-email, and accept_all finder cases (optionally add a distinct `free_below_finder_min`).

**m9 · GET-idempotency test never asserts no-double-bill** — `packages/api/test/routes.test.ts:136`
Asserts body equality (which catches replay via request_id) but never checks that `ledger.settle` fires once; the fake `settle` doesn't count calls, so a regression re-billing on replay could pass. **Fix:** Make the fake `settle` count invocations; assert it's called exactly once across the two requests.

---

## 4. What Was Verified Clean

- **Live request/response spine** — auth, `sk_live_`/`sk_test_` key derivation (HMAC-SHA256 + APP_PEPPER, 16-char prefix), finder candidate ranking, verifier sync→202-async fallback, account/usage reporting, all validated end-to-end against real Neon.
- **Bulk intake correctness** — raw-array body validation (object shape correctly 400s), 202 with count, idempotency replay returning the same job_id, job status + results endpoints.
- **Sandbox path** — `sk_test_` deterministic fixtures route to the sandbox catalog without touching the pipeline or ledger, and never bill.
- **DB boot + migrations** — `/healthz` db check green; the API booted and served against live Neon.
- **Standard headers on synchronous 200s** — X-Request-Id / X-Billed / X-Credits-Remaining present on every synchronous success (the *gap* is on 202/error/non-billed paths — see M6).
- **Verifier-path suppression ordering** — the verifier endpoint correctly checks both address and domain scope at stage 1 before any paid verify (only the *finder* path is broken — B2).
- **Suppression leaf logic** — `suppression.ts` / `score-writeback.ts` checks are correctly implemented; they're merely never fed (B1).
- **Worker billing path** — `worker/item.ts` correctly wraps insert+recordAttempt+tryDebitCredit in one transaction and gates on the applied delta (the API path is what regressed — M2).
- **Partial unique indexes** — the exactly-once / credit-back / creditback SQL guards and their migrations are present and correct in code (the gaps are test coverage, not the SQL — M8, m7).

---

## 5. Prioritized Fix List (implementer-executable)

**Gate 1 — LAUNCH BLOCKERS (do first, do not ship without):**
1. **B1** `adapters.ts:402` + `routes/compliance.ts` — wire `POST /v2/objections` → `createPending`, register `GET /v2/objections/confirm` → `confirm()` in `withTransaction`, add objection→confirm→suppression→not-found integration test.
2. **B2** `verifier-backend.ts:105` / `orchestrator.ts` — batch address-scope `isSuppressed` filter on candidates right after generation, before stage 7.
3. **M4** `adapters.ts:385` — `confirmUrl` from `env.publicBaseUrl` (part of making B1 actually reachable).

**Gate 2 — BILLING + ABUSE MAJORS (same cycle):**
4. **M2** `adapters.ts:250` — wrap recordAttempt+tryDebitCredit in one `withTransaction`, debit from returned `creditsDeltaApplied < 0`.
5. **M1** `score.ts:165` — add `input.mx === 'EXPLICIT_MX'` to case-1 guard (or Math.min against IMPLICIT_MX_MAX).
6. **M3 + M5** `adapters.ts:393` / `compliance.ts:16` — implement per-IP/per-target throttle in `createSignup`/`createObjection` (wire `recentByIp`), return `{rateLimited:true}` collapsed into the constant 202. (Single fix covers both.)
7. **M6** `headers.ts:36` — emit all six headers unconditionally for authenticated principals (snapshot rate-limit + live credit balance into ctx; populate creditsRemaining on error/non-billed).
8. **M7** `render.yaml:58` — pin exact `NODE_VERSION`/`.node-version` (≥26, necessarily ≥23.6); verify Render offers it.

**Gate 3 — INVARIANT TEST COVERAGE (protects the above; a regression here ships green):**
9. **M8** `usage-ledger.ts` — DB integration test for real `recordAttempt` ON CONFLICT + partial index.
10. **M11** `jobs.ts:186` — DB test: two concurrent `claim()` → disjoint id-sets, attempts incremented, future run_after excluded.
11. **M12** `verifier-spend.ts:65` — unit test the kill_switch > global_cap > tenant_cap precedence + `>=` boundaries.
12. **M9** `orchestrator.test.ts` — `probeCatchAll:true` test: verify skipped, status accept_all, capped, non-billable.
13. **M10** `kb-patterns.ts:69` — DB test for verified_count write-guard + harness arg capture for accept-all propagation.

**Gate 4 — MINORS (correctness paper-cuts + contract/test hygiene):**
14. **m1** `loop.ts:72` — `attemptsSoFar = job.attempts;`
15. **m2** `german.ts:58` — only collapse when original token had ä/ö/ü.
16. **m3** `adapters.ts:94` — persist sync results (or document non-retention + scope DSAR/TTL consistently).
17. **m4** `validate.ts:73` — STATUS_SUBSTATUS pair legality assertion + test.
18. **m5** `spec.ts:199` — add missing finder params + bulk requestBody schemas.
19. **m7** `usage-ledger.ts:85` — credit-back double-refund DB test.
20. **m8** `billing-policy.test.ts:62` — assert `.reason` on finder free cases.
21. **m9** `routes.test.ts:136` — count `settle` calls, assert once across replay.
22. **m6** `auth.ts:14` — remove dead `logRedactionPaths` + fix comment (or wire nested-path redaction).

---

*Verification method: each finding above was independently re-derived against the cited source (line-level code inspection); one finding (M7) remains PLAUSIBLE because its failure hinges on external Render runtime behavior that cannot be confirmed from the repo. The live E2E exercised the request/billing/header surface in dev-degrade mode against production Neon.*
