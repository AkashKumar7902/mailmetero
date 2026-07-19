// 0002 — shared KB (9 tables). NO person columns anywhere (D7 — CI-enforced at runtime).

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE kb.domains (
      domain              text PRIMARY KEY,
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
      pattern_token  text NOT NULL,
      observed_count integer NOT NULL DEFAULT 0,
      verified_count integer NOT NULL DEFAULT 0,
      winning_fold   text,
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (domain, pattern_token),
      CHECK (verified_count <= observed_count)
    );
    CREATE INDEX kb_patterns_domain_idx ON kb.domain_patterns(domain);

    CREATE TABLE kb.provider_fingerprints (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      mx_suffix text NOT NULL UNIQUE,
      provider text NOT NULL, verifiability_class text NOT NULL,
      priority integer NOT NULL DEFAULT 0,
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
      caps  jsonb NOT NULL,
      bands jsonb NOT NULL,
      is_active boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX kb_blend_weights_active_uk ON kb.blend_weights(is_active) WHERE is_active;

    CREATE TABLE kb.freemail_domains   ( domain text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now() );
    CREATE TABLE kb.disposable_domains ( domain text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now() );
    CREATE TABLE kb.role_locals        ( local_part text PRIMARY KEY, rfc2142 boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now() );
    CREATE TABLE kb.typo_domains       ( typo text PRIMARY KEY, correction text NOT NULL, created_at timestamptz NOT NULL DEFAULT now() );
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DROP TABLE IF EXISTS kb.typo_domains;
    DROP TABLE IF EXISTS kb.role_locals;
    DROP TABLE IF EXISTS kb.disposable_domains;
    DROP TABLE IF EXISTS kb.freemail_domains;
    DROP TABLE IF EXISTS kb.blend_weights;
    DROP TABLE IF EXISTS kb.pattern_priors;
    DROP TABLE IF EXISTS kb.provider_fingerprints;
    DROP TABLE IF EXISTS kb.domain_patterns;
    DROP TABLE IF EXISTS kb.domains;
  `);
};
