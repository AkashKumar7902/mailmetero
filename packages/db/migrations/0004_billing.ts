// 0004 — outcome-conditional billing: usage_ledger, idempotency_keys (+ exactly-once uniques)
// (D11/D13).

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE usage_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      request_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('attempt','credit_back')),
      endpoint text NOT NULL CHECK (endpoint IN ('finder','verifier')),
      billable boolean NOT NULL DEFAULT false,
      credits_delta integer NOT NULL DEFAULT 0,
      result_status text, result_sub_status text, result_score integer,
      backend text, evidence text, billed_reason text,
      result_id uuid,
      original_ledger_id uuid REFERENCES usage_ledger(id),
      downgrade_reason text,
      occurred_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_ledger_attempt    ON usage_ledger (tenant_id, request_id) WHERE kind = 'attempt';
    CREATE UNIQUE INDEX uq_ledger_creditback ON usage_ledger (original_ledger_id)   WHERE kind = 'credit_back';
    CREATE INDEX idx_ledger_usage ON usage_ledger (tenant_id, occurred_on);
    CREATE INDEX idx_ledger_creditback_scan ON usage_ledger (occurred_on) WHERE kind = 'attempt' AND billable = true;
    CREATE INDEX idx_ledger_redact ON usage_ledger (created_at) WHERE result_id IS NOT NULL;

    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      scope text NOT NULL CHECK (scope IN ('header','request_hash')),
      idempotency_key text,
      endpoint text NOT NULL, request_hash text NOT NULL,
      response_ref jsonb, status_code integer,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_idem_header  ON idempotency_keys (tenant_id, endpoint, idempotency_key) WHERE scope = 'header';
    CREATE UNIQUE INDEX uq_idem_reqhash ON idempotency_keys (tenant_id, endpoint, request_hash)    WHERE scope = 'request_hash';
    CREATE INDEX idx_idem_expiry ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS idempotency_keys;
    DROP TABLE IF EXISTS usage_ledger;
  `);
};
