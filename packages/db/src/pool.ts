// @mailmetero/db — node-postgres pool factories (D20).
//
// TWO pools, deliberately distinct:
//   • createWebPool  → the pooled (-pooler / PgBouncer txn-mode) DSN. Unnamed prepared
//     statements only; NO session `SET`, `LISTEN/NOTIFY`, or session advisory locks.
//     The Neon pooler REJECTS `statement_timeout` / `idle_in_transaction_session_timeout`
//     as startup parameters (`08P01 unsupported startup parameter in options`), so the
//     pooled connection carries NO `options=-c ...`. Those timeouts are instead applied
//     as a ROLE-LEVEL default (migration 0009 `ALTER ROLE ... SET statement_timeout`),
//     which Postgres applies server-side on every backend the pooler opens — pooled included.
//   • createDirectPool → the unpooled direct DSN. `FOR UPDATE SKIP LOCKED`, long
//     transactions and any session-scoped SET are confined here (worker/cron/migrations).
//     The direct endpoint DOES accept startup `options`, so its timeouts travel on the DSN
//     (env-configurable) and override the role default for those sessions.

import { Pool } from 'pg';
import type { AppConfig, DatabaseConfig } from '@mailmetero/config';
import type { Queryable } from './client.ts';

export interface DbPools {
  readonly web: Pool;
  readonly direct: Pool;
}

/**
 * Append `options=-c statement_timeout=...&-c idle_in_transaction_session_timeout=...`
 * to a DSN so the timeouts travel with the connection string rather than a post-connect
 * `SET` (which PgBouncer txn-mode would reject / leak across pooled sessions).
 */
function withTimeoutOptions(dsn: string, statementTimeoutMs: number): string {
  const url = new URL(dsn);
  // libpq `options` passes backend -c flags. Space-separated; URL encoding handles it.
  const idleTxnMs = statementTimeoutMs * 2;
  const opts = `-c statement_timeout=${statementTimeoutMs} -c idle_in_transaction_session_timeout=${idleTxnMs}`;
  const existing = url.searchParams.get('options');
  url.searchParams.set('options', existing ? `${existing} ${opts}` : opts);
  return url.toString();
}

/**
 * Pooled web pool (PgBouncer-safe). NO startup `options` — the Neon pooler rejects
 * `statement_timeout` there. The timeout backstop comes from the role-level default set
 * in migration 0009 (applied server-side, transparent to the pooler).
 */
export function createWebPool(cfg: DatabaseConfig): Pool {
  return new Pool({
    connectionString: cfg.pooledUrl,
    max: cfg.poolMaxWeb,
    connectionTimeoutMillis: cfg.connTimeoutMs,
    // PgBouncer txn-mode: keep unnamed statements; do not hold idle clients too long.
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
}

/** Unpooled direct pool for worker/cron/migrations (SKIP LOCKED, long tx, session SET ok). */
export function createDirectPool(cfg: DatabaseConfig): Pool {
  return new Pool({
    connectionString: withTimeoutOptions(cfg.unpooledUrl, cfg.statementTimeoutMs),
    max: cfg.poolMaxWorker,
    connectionTimeoutMillis: cfg.connTimeoutMs,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
}

/** Build both pools from the full AppConfig (its `.database` view). */
export function createPools(cfg: AppConfig): DbPools {
  return { web: createWebPool(cfg.database), direct: createDirectPool(cfg.database) };
}

/** Gracefully drain both pools. Safe to call once during shutdown. */
export async function closePools(pools: DbPools): Promise<void> {
  await Promise.all([pools.web.end(), pools.direct.end()]);
}

/** Liveness probe: `SELECT 1`. Returns false rather than throwing on failure. */
export async function healthCheck(q: Queryable): Promise<boolean> {
  try {
    const res = await q.query('SELECT 1 AS ok');
    return res.rows.length === 1;
  } catch {
    return false;
  }
}
