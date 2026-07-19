# mailmetero — SCHEMA (final DDL, single owner: `@mailmetero/db`)

**Status:** BINDING. `@mailmetero/db` is the **sole owner** of every Postgres object (the verifier blocker
resolution). One migration history under `packages/db/migrations`, run by `node-pg-migrate` on the
**unpooled** DSN (D20). All migrations are TS files that emit DDL via `pgm.sql(...)` — one authoring style
so the CI kb-no-PII source grep is deterministic; the **authoritative** D7 gate is the runtime
`information_schema` introspection.

Conventions: `gen_random_uuid()` via `pgcrypto`; `citext` for case-insensitive email/owner. Person data
lives ONLY in the `public` (tenant) schema; `kb.*` is domain-level only.

---

## 1. Migration order (single history)

| File | Creates | Owner rationale |
|---|---|---|
| `0000_extensions_schemas.ts` | `pgcrypto`, `citext`; `CREATE SCHEMA kb`, `CREATE SCHEMA ops` | one place for extensions+schemas |
| `0001_tenant_core.ts` | `tenants`, `api_keys`, `results`, `rate_counters` (+ indexes) | tenant scope |
| `0002_kb_schema.ts` | `kb.domains`, `kb.domain_patterns`, `kb.provider_fingerprints`, `kb.pattern_priors`, `kb.blend_weights`, `kb.freemail_domains`, `kb.disposable_domains`, `kb.role_locals`, `kb.typo_domains` | shared KB (no person columns) |
| `0003_jobs_queue.ts` | `jobs`, `job_items` (+ claim/sweep partial indexes) | SKIP LOCKED queue (D4/D20) |
| `0004_billing.ts` | `usage_ledger`, `idempotency_keys` (+ exactly-once uniques) | outcome-conditional billing (D11/D13) |
| `0005_ops_spend_policy.ts` | `ops.verifier_spend`, `ops.verifier_policy` (+ singleton seed) | spend caps + single kill switch (D12) |
| `0006_compliance.ts` | `suppression_global`, `objection_requests` (hash-only) | global compliance (D5/D6) |
| `0007_seed_scoring_fingerprints.ts` | data: `kb.blend_weights` (active), `kb.pattern_priors`, `kb.provider_fingerprints`, `kb.role_locals`, `kb.typo_domains` via `seedScoringAndFingerprints(pgmClient)` | audit-seed |
| `0008_seed_classification.ts` | data: `kb.freemail_domains`, `kb.disposable_domains` via `seedClassificationTables(pgmClient, VENDOR_DIR)` (junk-filtered, punycode; idempotent) | vendored blocklists |

---

## 2. `0000_extensions_schemas`

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS kb;
CREATE SCHEMA IF NOT EXISTS ops;
```

## 3. `0001_tenant_core`

```sql
-- PINNED tenants contract: billing/spend read credits_remaining, daily_verifier_spend_cap_cents, quota_period_start.
CREATE TABLE tenants (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email                     citext NOT NULL UNIQUE,
  plan_name                       text NOT NULL DEFAULT 'free',
  retention_days                  integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  search_quota                    integer NOT NULL DEFAULT 50,
  verify_quota                    integer NOT NULL DEFAULT 50,
  credits_remaining               integer NOT NULL DEFAULT 50 CHECK (credits_remaining >= 0),
  daily_verifier_spend_cap_cents  integer NOT NULL DEFAULT 500,   -- CENTS (single unit)
  quota_period_start              timestamptz NOT NULL DEFAULT now(),
  status                          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_prefix   text NOT NULL,                 -- 'sk_live_########' / 'sk_test_########'
  key_hash     text NOT NULL,                 -- HMAC-SHA256(secret, APP_PEPPER) hex
  environment  text NOT NULL CHECK (environment IN ('live','test')),
  scopes       text[] NOT NULL DEFAULT '{}',
  label        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX api_keys_prefix_uk ON api_keys(key_prefix);   -- indexed constant-time-compare hot path
CREATE INDEX api_keys_tenant_idx ON api_keys(tenant_id);

-- Per-tenant person-level results + verdict cache (stage-3) + DSAR + provenance.
CREATE TABLE results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id     text NOT NULL,
  endpoint       text NOT NULL CHECK (endpoint IN ('finder','verifier')),
  request_hash   text NOT NULL,               -- stage-3 verdict cache key
  input_first_name text, input_last_name text, input_middle_name text, input_full_name text,
  input_domain   text, input_email citext,
  email          citext,
  status         text NOT NULL,
  sub_status     text,
  score          integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  reason_codes   text[] NOT NULL CHECK (cardinality(reason_codes) >= 1),   -- never bare unknown
  provider       text,
  backend        text NOT NULL CHECK (backend IN ('api','none','smtp')),
  evidence       text NOT NULL,
  collision_risk boolean NOT NULL DEFAULT false,
  accept_all boolean, webmail boolean, disposable boolean, mx_records boolean, smtp_check boolean,
  raw_smtp_code text, enhanced_code text,
  candidates     jsonb NOT NULL DEFAULT '[]',
  source         text NOT NULL DEFAULT 'derivation' CHECK (source = 'derivation'),
  billed         boolean NOT NULL DEFAULT false,
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL          -- TTL (person-level, default 90d)
);
CREATE UNIQUE INDEX results_tenant_request_uk ON results(tenant_id, request_id);
CREATE INDEX results_cache_idx ON results(tenant_id, request_hash, created_at DESC);   -- stage-3 lookup
CREATE INDEX results_dsar_input_idx ON results(tenant_id, input_email);
CREATE INDEX results_dsar_email_idx ON results(tenant_id, email);
CREATE INDEX results_ttl_idx   ON results(expires_at);

CREATE TABLE rate_counters (
  api_key_id     uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  window_start   timestamptz NOT NULL,
  window_seconds integer NOT NULL,
  count          integer NOT NULL DEFAULT 0,
  limit_max      integer NOT NULL,
  PRIMARY KEY (api_key_id, window_start)
);   -- atomic: INSERT .. ON CONFLICT (api_key_id,window_start) DO UPDATE SET count = rate_counters.count + 1 RETURNING count
```

## 4. `0002_kb_schema` — NO person columns anywhere (D7)

```sql
CREATE TABLE kb.domains (
  domain              text PRIMARY KEY,        -- registrable eTLD+1
  mx_enum             text, provider text, verifiability_class text, is_catch_all boolean,
  has_spf boolean, has_dmarc boolean, size_bracket text,
  mx_hosts            text[] NOT NULL DEFAULT '{}',
  observed_count      integer NOT NULL DEFAULT 0,
  last_probed_at      timestamptz,
  expires_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_domains_ttl_idx ON kb.domains(expires_at);

CREATE TABLE kb.domain_patterns (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain         text NOT NULL,
  pattern_token  text NOT NULL,                -- '{first}.{last}' template, NOT person data
  observed_count integer NOT NULL DEFAULT 0,
  verified_count integer NOT NULL DEFAULT 0,   -- D7 write-guard (never bumped on accept-all domains)
  winning_fold   text,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (domain, pattern_token),
  CHECK (verified_count <= observed_count)
);
CREATE INDEX kb_patterns_domain_idx ON kb.domain_patterns(domain);

CREATE TABLE kb.provider_fingerprints (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mx_suffix text NOT NULL UNIQUE,              -- '.mail.protection.outlook.com'
  provider text NOT NULL, verifiability_class text NOT NULL,
  priority integer NOT NULL DEFAULT 0,         -- longest-suffix-wins
  notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kb.pattern_priors (
  size_bracket text NOT NULL, pattern_token text NOT NULL,
  share numeric(6,5) NOT NULL CHECK (share >= 0 AND share <= 1), rank integer NOT NULL,
  PRIMARY KEY (size_bracket, pattern_token)
);

CREATE TABLE kb.blend_weights (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('audit_seed','recalibrated')),
  domain_verified_support numeric NOT NULL, verification_outcome_quality numeric NOT NULL,
  recency_decay numeric NOT NULL, size_conditioned_prior_floor numeric NOT NULL,
  caps  jsonb NOT NULL,   -- HardCaps (seeded from DEFAULT_SCORING_CONFIG)
  bands jsonb NOT NULL,   -- ConfidenceBand[]
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX kb_blend_weights_active_uk ON kb.blend_weights(is_active) WHERE is_active;
-- ScoringConfigRepo.activate() runs ONE tx: UPDATE ... SET is_active=false WHERE is_active;
--   then UPDATE ... SET is_active=true WHERE version=$1;  (partial-unique safe)

CREATE TABLE kb.freemail_domains   ( domain text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now() );
CREATE TABLE kb.disposable_domains ( domain text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now() );
CREATE TABLE kb.role_locals        ( local_part text PRIMARY KEY, rfc2142 boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now() );
CREATE TABLE kb.typo_domains       ( typo text PRIMARY KEY, correction text NOT NULL, created_at timestamptz NOT NULL DEFAULT now() );
```

## 5. `0003_jobs_queue`

```sql
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bulk_find','bulk_verify','async_verify')),   -- async_verify present (D4)
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','running','done','failed')),
  total integer NOT NULL DEFAULT 0, done integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, priority integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_by text, locked_at timestamptz, visibility_deadline timestamptz,
  idempotency_key text, request_id text NOT NULL, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE INDEX idx_jobs_claim ON jobs (priority DESC, created_at) WHERE status = 'queued';        -- SKIP LOCKED hot path
CREATE INDEX idx_jobs_sweep ON jobs (visibility_deadline) WHERE status IN ('claimed','running');
CREATE INDEX idx_jobs_tenant ON jobs (tenant_id, created_at DESC);

CREATE TABLE job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  row_index integer NOT NULL,
  request_id text NOT NULL,                -- deterministic `${job.request_id}:${row_index}` (ledger idempotency key)
  input jsonb NOT NULL,                    -- {first_name,last_name,domain} | {email}
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  result jsonb,                            -- WIRE FinderResult | VerifierResult | ErrorEnvelope
  result_id uuid,                          -- logical link to results(id); nulled on TTL purge
  error jsonb, processed_at timestamptz,
  UNIQUE (job_id, row_index)
);
CREATE INDEX idx_job_items_pending ON job_items (job_id) WHERE status = 'pending';
```

## 6. `0004_billing`

```sql
CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('attempt','credit_back')),
  endpoint text NOT NULL CHECK (endpoint IN ('finder','verifier')),
  billable boolean NOT NULL DEFAULT false,
  credits_delta integer NOT NULL DEFAULT 0,   -- -1 charge | +1 credit-back | 0 free
  result_status text, result_sub_status text, result_score integer,
  backend text, evidence text, billed_reason text,
  result_id uuid,                              -- nulled on TTL purge (person-field minimization)
  original_ledger_id uuid REFERENCES usage_ledger(id),   -- credit_back → attempt
  downgrade_reason text,
  occurred_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),   -- DEFAULT (STABLE ok); NOT a GENERATED column
  created_at timestamptz NOT NULL DEFAULT now()
);
-- exactly one attempt per (tenant,request_id) ⇒ retries physically cannot double-bill (D11/D13)
CREATE UNIQUE INDEX uq_ledger_attempt    ON usage_ledger (tenant_id, request_id) WHERE kind = 'attempt';
CREATE UNIQUE INDEX uq_ledger_creditback ON usage_ledger (original_ledger_id)   WHERE kind = 'credit_back';
CREATE INDEX idx_ledger_usage ON usage_ledger (tenant_id, occurred_on);
CREATE INDEX idx_ledger_creditback_scan ON usage_ledger (occurred_on) WHERE kind = 'attempt' AND billable = true;
CREATE INDEX idx_ledger_redact ON usage_ledger (created_at) WHERE result_id IS NOT NULL;   -- redactPastTtl range scan

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('header','request_hash')),
  idempotency_key text,                    -- explicit bulk key (scope='header')
  endpoint text NOT NULL, request_hash text NOT NULL,
  response_ref jsonb, status_code integer,
  expires_at timestamptz,                  -- 24h for request_hash (THE single GET replay store)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_idem_header  ON idempotency_keys (tenant_id, endpoint, idempotency_key) WHERE scope = 'header';
CREATE UNIQUE INDEX uq_idem_reqhash ON idempotency_keys (tenant_id, endpoint, request_hash)    WHERE scope = 'request_hash';
CREATE INDEX idx_idem_expiry ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;
```

## 7. `0005_ops_spend_policy` — single kill switch (D12)

```sql
CREATE TABLE ops.verifier_spend (
  scope_tenant_id uuid,                    -- NULL row = global aggregate
  spend_date date NOT NULL,
  spend_cents integer NOT NULL DEFAULT 0,  -- CENTS (single unit)
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_verifier_spend ON ops.verifier_spend (scope_tenant_id, spend_date) NULLS NOT DISTINCT;

-- The ONLY kill-switch/policy table (ops.service_flags and ops.feature_flags removed).
CREATE TABLE ops.verifier_policy (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
  kill_switch_enabled boolean NOT NULL DEFAULT false,
  global_daily_cap_cents integer,                     -- NULL = unlimited (CENTS)
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO ops.verifier_policy (id) VALUES (1) ON CONFLICT DO NOTHING;
```

## 8. `0006_compliance` — hash-only (D5/D6)

```sql
-- Salted SHA-256 only. No plaintext, no source attribution, no tenant_id. Retained indefinitely.
CREATE TABLE suppression_global (
  hash text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('address','domain')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Hash-only intake: NO plaintext email column. Plaintext exists only transiently in memory to send mail.
CREATE TABLE objection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,                        -- sha256 of emailed token
  subject_suppression_hash text NOT NULL,                 -- precomputed salted hash, written on confirm
  domain_suppression_hash text,                           -- optional (scope='address_and_domain')
  scope text NOT NULL DEFAULT 'address' CHECK (scope IN ('address','address_and_domain')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired','revoked','manual_review')),
  request_ip_hash text,
  expires_at timestamptz NOT NULL, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_objection_status ON objection_requests (status, expires_at);   -- hourly expiry sweep
CREATE INDEX idx_objection_ip     ON objection_requests (request_ip_hash, created_at);
```

## 9. `0007_seed_scoring_fingerprints` (data migration)

TS body calls `seedScoringAndFingerprints(pgmClient)`:
- `kb.blend_weights` ← `DEFAULT_SCORING_CONFIG` (validated by `validateScoringConfig`), `is_active=true`,
  `caps`+`bands` jsonb.
- `kb.pattern_priors` ← audit-seeded size-bracket format shares. **PLACEHOLDER** (research-brief-derived:
  `{first}.{last}` dominant, size-conditioned) until the real BounceZero 3,006-address audit export lands
  (PRD Open-Question #2). The schema is final; only the seed VALUES are provisional.
- `kb.provider_fingerprints` ← MX-suffix → `PROVIDER_VERIFIABILITY` seed (M365, Workspace, Proofpoint,
  Mimecast, IronPort, Barracuda, Zoho, Proton).
- `kb.role_locals` ← `SEED_ROLE_LOCALS` (RFC 2142 + info/sales/hr/careers/hello/contact/noreply…).
- `kb.typo_domains` ← `SEED_TYPO_DOMAINS` (gnail.com→gmail.com …).

## 10. `0008_seed_classification` (data migration)

TS body calls `seedClassificationTables(pgmClient, VENDOR_DIR)` where `VENDOR_DIR` is resolved from an
**absolute anchor** (`AppConfig.vendorDir` / `new URL('../../../data/vendor', import.meta.url)`), never a
cwd-relative literal. Loads `data/vendor/freemail_domains.txt` (junk-filtered: drops `404: not found`,
`asean-mail`, `housefancom`, `multiplechoices`, requires a dot) and the union of
`disposable_domains.txt` + `freemail_disposable.txt` (IDN→punycode via `url.domainToASCII`). Idempotent
(`ON CONFLICT DO NOTHING`). The `blocklist-sync` cron calls the SAME loader (`refreshClassificationTables`)
weekly — **no network egress**.

---

## 11. kb-no-PII CI invariant (D7) — authoritative gate

`packages/db/src/ci/kb-invariant.ts`:

```ts
export const KB_COLUMN_ALLOWLIST: ReadonlySet<string> = new Set([
  // kb.domains
  'domain','mx_enum','provider','verifiability_class','is_catch_all','has_spf','has_dmarc',
  'size_bracket','mx_hosts','observed_count','last_probed_at','expires_at','created_at','updated_at',
  // kb.domain_patterns
  'id','pattern_token','verified_count','winning_fold','last_seen_at',
  // kb.provider_fingerprints
  'mx_suffix','priority','notes',
  // kb.pattern_priors
  'share','rank',
  // kb.blend_weights
  'version','source','domain_verified_support','verification_outcome_quality','recency_decay',
  'size_conditioned_prior_floor','caps','bands','is_active',
  // kb.freemail_domains / kb.disposable_domains / kb.typo_domains / kb.role_locals
  'typo','correction','local_part','rfc2142',
]);
export const PERSON_COLUMN_DENYLIST =
  /(^|_)(first|last|middle|full|given|sur|display|person|people|contact)_?name|(^|_)e?mail(_|$)|(^|_)mailbox|(^|_)recipient|(^|_)phone/i;
```

Test spec (`packages/db/test/kb-no-person-columns.test.ts`):
1. Migrate a scratch DB (all migrations 0000–0008).
2. `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='kb'`.
3. **Fail** if any column is NOT in `KB_COLUMN_ALLOWLIST` (forces a reviewer to consciously extend the
   allowlist) OR matches `PERSON_COLUMN_DENYLIST`.
4. Secondary (config `tools/ci/check-kb-no-pii.test.ts`): source grep over `packages/db/migrations/*.ts`
   for `pgm.sql` blocks touching `kb.` tables + the denylist regex — best-effort backstop only; the
   runtime introspection above is the launch gate.

Note: `role_locals.local_part` (a role token like `info`) and `domain_patterns.pattern_token`
(`{first}.{last}` template) are intentionally allowlisted; the denylist regex is written to NOT match them.

---

## 12. `.node-pg-migraterc.json` (root)

```json
{ "migrationsTable": "pgmigrations", "dir": "packages/db/migrations", "schema": ["public","kb","ops"],
  "createSchema": false, "databaseUrl": "DATABASE_URL_UNPOOLED", "checkOrder": true }
```
Extensions/schemas are created by `0000` (not by node-pg-migrate `createSchema`) so the order is explicit.

---

## 13. Index summary (hot paths)

| Index | Purpose |
|---|---|
| `api_keys_prefix_uk` | Auth prefix lookup (then constant-time HMAC compare). |
| `results_tenant_request_uk` | Idempotent results insert per (tenant, request_id). |
| `results_cache_idx` | Stage-3 tenant verdict cache. |
| `results_dsar_input_idx` / `results_dsar_email_idx` | DSAR export/delete. |
| `results_ttl_idx` | Nightly TTL purge range. |
| `idx_jobs_claim` | `FOR UPDATE SKIP LOCKED` claim (partial `WHERE status='queued'`). |
| `idx_jobs_sweep` | Stuck-job sweep. |
| `uq_ledger_attempt` | Exactly-once billing (D11/D13). |
| `uq_ledger_creditback` | No double refund. |
| `idx_ledger_redact` | `redactPastTtl` range scan (partial `WHERE result_id IS NOT NULL`). |
| `uq_idem_reqhash` / `uq_idem_header` | GET dedupe + bulk idempotency. |
| `uq_verifier_spend` (`NULLS NOT DISTINCT`) | Per-tenant + global daily spend upsert (PG15+; Neon ok). |
| `idx_objection_status` | Hourly objection expiry sweep. |

---

## 14. Connection & pooling rules (D20)

- **web** → `createWebPool(cfg.database)` on the pooled `-pooler` DSN (PgBouncer txn mode): unnamed prepared
  statements only; **no** session `SET`, `LISTEN/NOTIFY`, or session advisory locks; `statement_timeout` /
  `idle_in_transaction_session_timeout` supplied via DSN `options=-c ...` (verified accepted by Neon
  pooler), never a post-connect `SET`; rate limiting via atomic UPDATE counters only.
- **worker / cron / migrations** → `createDirectPool(cfg.database)` on the unpooled DSN: `FOR UPDATE SKIP
  LOCKED`, long transactions, and any session-scoped `SET` are confined here.
