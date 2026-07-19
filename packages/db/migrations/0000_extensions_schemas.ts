// 0000 — extensions + schemas. Run FIRST on the UNPOOLED DSN (D20). Extensions/schemas are
// created here explicitly (not by node-pg-migrate createSchema) so the order is deterministic.

import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS citext;
    CREATE SCHEMA IF NOT EXISTS kb;
    CREATE SCHEMA IF NOT EXISTS ops;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  // Drop the app schemas; leave extensions (may be shared) in place.
  pgm.sql(`
    DROP SCHEMA IF EXISTS ops CASCADE;
    DROP SCHEMA IF EXISTS kb CASCADE;
  `);
};
