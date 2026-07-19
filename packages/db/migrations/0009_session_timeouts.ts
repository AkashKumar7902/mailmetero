// 0009 — role-level statement/idle timeouts (the pooled-connection backstop).
//
// The Neon POOLED endpoint rejects `statement_timeout` / `idle_in_transaction_session_timeout`
// when passed as startup `options` (`08P01 unsupported startup parameter`), so the pooled web
// pool cannot carry them on its DSN. Setting them as a ROLE default here makes Postgres apply
// them server-side on every backend the pooler opens — pooled sessions included — without any
// per-connection startup parameter. The unpooled worker/cron/migration pool overrides these via
// its own DSN `options` when a different ceiling is wanted. Values are conservative backstops:
// the real per-request bounds live in the app (FINDER_BUDGET_MS, SYNC_VERIFY_BUDGET_MS).
import type { MigrationBuilder } from 'node-pg-migrate';

const STATEMENT_TIMEOUT = '30s';
const IDLE_IN_TXN_TIMEOUT = '60s';

export const up = (pgm: MigrationBuilder): void => {
  // CURRENT_USER is the role the app connects as (Neon: neondb_owner). ALTER ROLE ... SET
  // records a per-role default GUC; it takes effect on the next session of that role.
  pgm.sql(`
    ALTER ROLE CURRENT_USER SET statement_timeout = '${STATEMENT_TIMEOUT}';
    ALTER ROLE CURRENT_USER SET idle_in_transaction_session_timeout = '${IDLE_IN_TXN_TIMEOUT}';
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    ALTER ROLE CURRENT_USER RESET statement_timeout;
    ALTER ROLE CURRENT_USER RESET idle_in_transaction_session_timeout;
  `);
};
