// 0005 — spend caps + the single kill switch: ops.verifier_spend, ops.verifier_policy (D12).

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE ops.verifier_spend (
      scope_tenant_id uuid,
      spend_date date NOT NULL,
      spend_cents integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_verifier_spend ON ops.verifier_spend (scope_tenant_id, spend_date) NULLS NOT DISTINCT;

    CREATE TABLE ops.verifier_policy (
      id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      kill_switch_enabled boolean NOT NULL DEFAULT false,
      global_daily_cap_cents integer,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
    );
    INSERT INTO ops.verifier_policy (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS ops.verifier_policy;
    DROP TABLE IF EXISTS ops.verifier_spend;
  `);
};
