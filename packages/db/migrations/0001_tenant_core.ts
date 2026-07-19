// 0001 — tenant scope: tenants, api_keys, results, rate_counters (+ indexes).

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE tenants (
      id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_email                     citext NOT NULL UNIQUE,
      plan_name                       text NOT NULL DEFAULT 'free',
      retention_days                  integer NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
      search_quota                    integer NOT NULL DEFAULT 50,
      verify_quota                    integer NOT NULL DEFAULT 50,
      credits_remaining               integer NOT NULL DEFAULT 50 CHECK (credits_remaining >= 0),
      daily_verifier_spend_cap_cents  integer NOT NULL DEFAULT 500,
      quota_period_start              timestamptz NOT NULL DEFAULT now(),
      status                          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at                      timestamptz NOT NULL DEFAULT now(),
      updated_at                      timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE api_keys (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key_prefix   text NOT NULL,
      key_hash     text NOT NULL,
      environment  text NOT NULL CHECK (environment IN ('live','test')),
      scopes       text[] NOT NULL DEFAULT '{}',
      label        text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      revoked_at   timestamptz,
      last_used_at timestamptz
    );
    CREATE UNIQUE INDEX api_keys_prefix_uk ON api_keys(key_prefix);
    CREATE INDEX api_keys_tenant_idx ON api_keys(tenant_id);

    CREATE TABLE results (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id     text NOT NULL,
      endpoint       text NOT NULL CHECK (endpoint IN ('finder','verifier')),
      request_hash   text NOT NULL,
      input_first_name text, input_last_name text, input_middle_name text, input_full_name text,
      input_domain   text, input_email citext,
      email          citext,
      status         text NOT NULL,
      sub_status     text,
      score          integer NOT NULL CHECK (score BETWEEN 0 AND 100),
      reason_codes   text[] NOT NULL CHECK (cardinality(reason_codes) >= 1),
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
      expires_at     timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX results_tenant_request_uk ON results(tenant_id, request_id);
    CREATE INDEX results_cache_idx ON results(tenant_id, request_hash, created_at DESC);
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
    );
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS rate_counters;
    DROP TABLE IF EXISTS results;
    DROP TABLE IF EXISTS api_keys;
    DROP TABLE IF EXISTS tenants;
  `);
};
