# mailmetero v1 — Final Status (2026-07-19)

Built end-to-end via multi-agent workflows: **research→verify → ideate → architect → implement → verify → fix → re-verify**.

## Green gate (reproduce with `pnpm ci:all` + integration)
- `pnpm -r build` — 11 packages compile (TS strict, project references). ✓
- Unit tests — **287 pass / 0 fail** (`node --test packages/*/test/**/*.test.ts`); 4 DB-integration tests self-skip without `DATABASE_URL_TEST`. ✓
- `pnpm run depgraph:check` — no dependency-DAG violations. ✓
- 6 CI compliance invariants — kb-no-PII, no-suppression-leak, egress-allowlist, frozen-registries, suppression-paths, DAG — all pass. ✓
- DB integration tests vs **live Neon** (`DATABASE_URL_TEST=<unpooled>`) — **4 pass / 0 fail** (exactly-once ledger, SKIP LOCKED claim exclusivity, KB verified_count write-guard, credit-back idempotency), no residue. ✓
- Migrations `0000–0009` applied to Neon project `mailmetero` (`sweet-base-24102562`); seeds loaded (freemail 4,462 · disposable 93,794 · priors 35 · fingerprints 13 · roles 35 · typos 14). ✓
- `assertKbHasNoPersonColumns` passes against the **live** schema (D7). ✓
- API boots on Neon: `/healthz` 200, `/v2/openapi.json` served, Bearer auth + Hunter-style error envelope. ✓

## Live functional e2e (dev mode, backend=none)
Finder returns ranked candidates + `≥1 reason_code` + headers; verifier sync→202 deferral; account/usage; bulk + idempotency replay; `sk_test_` sandbox fixtures (never bill). All PASS.

## Verification → remediation
Adversarial review produced **23 confirmed findings** (2 blockers, 12 majors, 9 minors); all fixed. The live re-verify then caught a deeper defect the unit tests missed:

- **Suppression hash-scheme mismatch (critical).** Write path salted (`computeSuppressionHash(value, SUPPRESSION_SALT)`); pipeline read path used an unsalted scope-prefixed placeholder → suppression could never match. **Fixed**: `SuppressionPort` now takes raw canonical values; the db-backed impl hashes with the deployment salt (single source of truth), and objection intake canonicalizes the subject email. **Live-verified**: an objected address returns 0 finder candidates (no leak) and a synchronous canonical verifier result (never enqueued for probing); a control lookup is unaffected.
- **Neon pooler `08P01`.** The pooled pool sent `statement_timeout` as a startup param (Neon rejects it). **Fixed**: pooled pool carries no startup options; timeout backstop is a role-level default (migration `0009`); the unpooled pool keeps env-configurable DSN options.

## Known minor follow-ups (non-blocking)
- Verifier suppression short-circuits **synchronously** (200) while a non-suppressed unverifiable address may defer (202) in dev-degrade mode — a weak sync/async shape difference; largely moot in production (backend=api resolves most verifies synchronously). Consider normalizing.
- Integration tests prefer a dedicated Neon **test branch** over the shared dev branch (the M11 test is now isolation-safe + residue-free regardless).
- Launch-checklist (from PRD open questions): replace placeholder `kb.pattern_priors`/`kb.blend_weights` seeds with the real BounceZero 3,006-address audit export; verifier-vendor ToS review (D21); counsel review of the data-broker posture.

## Deploy readiness
`render.yaml` declares web + worker + 7 crons (paid Starter); migrations run in web `preDeployCommand` on the unpooled DSN; `.node-version` pins Node. **Not yet pushed to GitHub or deployed to Render.** Secrets live only in the gitignored `.env`.
