// 0006 — global compliance, hash-only: suppression_global, objection_requests (D5/D6).
// No plaintext email, no source attribution, no tenant_id on suppression_global.

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE suppression_global (
      hash text PRIMARY KEY,
      scope text NOT NULL CHECK (scope IN ('address','domain')),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE objection_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      subject_suppression_hash text NOT NULL,
      domain_suppression_hash text,
      scope text NOT NULL DEFAULT 'address' CHECK (scope IN ('address','address_and_domain')),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired','revoked','manual_review')),
      request_ip_hash text,
      expires_at timestamptz NOT NULL, confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_objection_status ON objection_requests (status, expires_at);
    CREATE INDEX idx_objection_ip     ON objection_requests (request_ip_hash, created_at);
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS objection_requests;
    DROP TABLE IF EXISTS suppression_global;
  `);
};
