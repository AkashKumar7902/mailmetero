// @mailmetero/db — IdempotencyRepo.
//
// TWO scopes over one table:
//   • 'header' — explicit Idempotency-Key on bulk POSTs. lookupOrReserve atomically
//     reserves a fresh slot or reports replay/conflict; finalize stores the response.
//   • 'request_hash' — the single 24h GET replay store (dedupe of identical reads).

import type { TenantId, IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';

export type ReserveResult =
  | { kind: 'fresh'; id: string }
  | { kind: 'replay'; responseRef: unknown; statusCode: number }
  | { kind: 'conflict' };

export interface IdempotencyRepo {
  lookupOrReserveHeaderKey(
    q: Queryable,
    input: { tenantId: TenantId; endpoint: string; idempotencyKey: string; requestHash: string },
  ): Promise<ReserveResult>;
  finalizeHeaderKey(q: Queryable, id: string, responseRef: unknown, statusCode: number): Promise<void>;
  lookupRequestHash(
    q: Queryable,
    tenantId: TenantId,
    endpoint: string,
    requestHash: string,
  ): Promise<{ responseRef: unknown; statusCode: number } | null>;
  storeRequestHash(
    q: Queryable,
    input: {
      tenantId: TenantId;
      endpoint: string;
      requestHash: string;
      responseRef: unknown;
      statusCode: number;
      ttlSeconds: number;
    },
  ): Promise<void>;
  purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>;
}

export function createIdempotencyRepo(): IdempotencyRepo {
  return {
    async lookupOrReserveHeaderKey(q, input) {
      // Try to reserve. If the key already exists, DO NOTHING returns no row.
      const reserved = await maybeOne<{ id: string }>(
        q,
        `INSERT INTO idempotency_keys (tenant_id, scope, idempotency_key, endpoint, request_hash)
         VALUES ($1, 'header', $2, $3, $4)
         ON CONFLICT (tenant_id, endpoint, idempotency_key) WHERE scope = 'header' DO NOTHING
         RETURNING id`,
        [input.tenantId, input.idempotencyKey, input.endpoint, input.requestHash],
      );
      if (reserved !== null) return { kind: 'fresh', id: reserved.id };

      // Existing slot: same request_hash ⇒ replay (if finalized); different ⇒ conflict.
      const existing = await maybeOne<{ request_hash: string; response_ref: unknown; status_code: number | null }>(
        q,
        `SELECT request_hash, response_ref, status_code
           FROM idempotency_keys
          WHERE tenant_id = $1 AND endpoint = $2 AND idempotency_key = $3 AND scope = 'header'
          LIMIT 1`,
        [input.tenantId, input.endpoint, input.idempotencyKey],
      );
      if (existing === null) return { kind: 'conflict' };
      if (existing.request_hash !== input.requestHash) return { kind: 'conflict' };
      if (existing.status_code === null) {
        // Reserved but not yet finalized (in-flight duplicate) — treat as conflict to force a retry.
        return { kind: 'conflict' };
      }
      return { kind: 'replay', responseRef: existing.response_ref, statusCode: existing.status_code };
    },

    async finalizeHeaderKey(q, id, responseRef, statusCode) {
      await q.query(
        `UPDATE idempotency_keys SET response_ref = $2::jsonb, status_code = $3 WHERE id = $1`,
        [id, JSON.stringify(responseRef ?? null), statusCode],
      );
    },

    async lookupRequestHash(q, tenantId, endpoint, requestHash) {
      const row = await maybeOne<{ response_ref: unknown; status_code: number | null }>(
        q,
        `SELECT response_ref, status_code
           FROM idempotency_keys
          WHERE tenant_id = $1 AND endpoint = $2 AND request_hash = $3 AND scope = 'request_hash'
            AND (expires_at IS NULL OR expires_at > now())
          LIMIT 1`,
        [tenantId, endpoint, requestHash],
      );
      if (row === null || row.status_code === null) return null;
      return { responseRef: row.response_ref, statusCode: row.status_code };
    },

    async storeRequestHash(q, input) {
      await q.query(
        `INSERT INTO idempotency_keys
           (tenant_id, scope, endpoint, request_hash, response_ref, status_code, expires_at)
         VALUES ($1, 'request_hash', $2, $3, $4::jsonb, $5, now() + ($6 || ' seconds')::interval)
         ON CONFLICT (tenant_id, endpoint, request_hash) WHERE scope = 'request_hash'
           DO UPDATE SET response_ref = EXCLUDED.response_ref,
                         status_code = EXCLUDED.status_code,
                         expires_at = EXCLUDED.expires_at`,
        [input.tenantId, input.endpoint, input.requestHash, JSON.stringify(input.responseRef ?? null), input.statusCode, String(input.ttlSeconds)],
      );
    },

    async purgeExpired(q, now, limit) {
      return rowCount(
        q,
        `DELETE FROM idempotency_keys
          WHERE id IN (
            SELECT id FROM idempotency_keys
             WHERE expires_at IS NOT NULL AND expires_at < $1
             ORDER BY expires_at
             LIMIT $2)`,
        [now, limit],
      );
    },
  };
}
