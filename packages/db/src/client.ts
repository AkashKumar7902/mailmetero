// @mailmetero/db — the shared query surface.
//
// Every repository is a set of FREE FUNCTIONS taking a `Queryable` (a Pool, a
// PoolClient, or a migration DB adapter). This lets billing/results/ledger/debit
// compose inside ONE `withTransaction` on a single connection, while cheap reads
// can run straight off the pool.

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Anything that can run a parameterized query: a Pool, a checked-out PoolClient,
 *  or the node-pg-migrate DB adapter. Repos accept this so callers control the tx. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Run a query and return the (possibly empty) list of rows, typed. */
export async function rows<R extends QueryResultRow = QueryResultRow>(
  q: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const res = (await q.query(text, params as unknown[])) as QueryResult<R>;
  return res.rows;
}

/** Run a query expected to return at most one row. */
export async function maybeOne<R extends QueryResultRow = QueryResultRow>(
  q: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<R | null> {
  const res = (await q.query(text, params as unknown[])) as QueryResult<R>;
  return res.rows.length > 0 ? (res.rows[0] as R) : null;
}

/** Run a mutating query and return the number of rows affected. */
export async function rowCount(
  q: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const res = await q.query(text, params as unknown[]);
  return res.rowCount ?? 0;
}

/**
 * Run `fn` inside a single BEGIN/COMMIT on a dedicated PoolClient. Rolls back and
 * re-throws on any error, and always releases the client. This is the ONLY place a
 * transaction is opened; repositories never manage their own connections.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed ROLLBACK (e.g. dead connection) must not mask the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}
