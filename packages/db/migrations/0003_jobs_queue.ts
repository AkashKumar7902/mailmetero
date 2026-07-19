// 0003 — SKIP LOCKED job queue: jobs, job_items (+ claim/sweep partial indexes) (D4/D20).

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('bulk_find','bulk_verify','async_verify')),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','running','done','failed')),
      total integer NOT NULL DEFAULT 0, done integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
      attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5, priority integer NOT NULL DEFAULT 0,
      run_after timestamptz NOT NULL DEFAULT now(),
      locked_by text, locked_at timestamptz, visibility_deadline timestamptz,
      idempotency_key text, request_id text NOT NULL, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    );
    CREATE INDEX idx_jobs_claim ON jobs (priority DESC, created_at) WHERE status = 'queued';
    CREATE INDEX idx_jobs_sweep ON jobs (visibility_deadline) WHERE status IN ('claimed','running');
    CREATE INDEX idx_jobs_tenant ON jobs (tenant_id, created_at DESC);

    CREATE TABLE job_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL,
      row_index integer NOT NULL,
      request_id text NOT NULL,
      input jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
      result jsonb,
      result_id uuid,
      error jsonb, processed_at timestamptz,
      UNIQUE (job_id, row_index)
    );
    CREATE INDEX idx_job_items_pending ON job_items (job_id) WHERE status = 'pending';
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS job_items;
    DROP TABLE IF EXISTS jobs;
  `);
};
