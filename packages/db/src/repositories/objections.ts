// @mailmetero/db — ObjectionsRepo (hash-only intake, D5/D6).
//
// NO plaintext email is ever stored. createPending records salted suppression hashes + the
// SHA-256 of the emailed token, and returns the RAW token (used once, in memory, to build
// the confirmation email). confirm writes the suppression row(s) in the SAME transaction as
// the status flip — so a subject is suppressed only after a verified opt-out.
//
// NOTE: `confirm` must be invoked with a transaction Queryable (a PoolClient) so the status
// update and the suppression write commit atomically. The composition root wraps it in
// withTransaction.

import { randomBytes } from 'node:crypto';
import type { EmailAddress, Domain, IsoTimestamp, SuppressionHash } from '@mailmetero/contracts';
import type { PoolClient } from 'pg';
import type { Queryable } from '../client.ts';
import { maybeOne, rowCount } from '../client.ts';
import { computeSuppressionHash, sha256Hex } from '../hash.ts';
import type { ObjectionScope, SuppressionScope } from '../types.ts';
import type { SuppressionRepo } from './suppression.ts';

export interface ObjectionsRepo {
  createPending(
    q: Queryable,
    input: { email: EmailAddress; domain: Domain; scope: ObjectionScope; requestIp: string; ttlSeconds: number },
  ): Promise<{ objectionId: string; token: string }>;
  confirm(
    q: Queryable,
    token: string,
  ): Promise<{ kind: 'confirmed' | 'already_confirmed' | 'expired' | 'not_found' }>;
  expireStale(q: Queryable, now: IsoTimestamp): Promise<number>;
  recentByIp(q: Queryable, requestIp: string, windowSeconds: number): Promise<number>;
}

export function createObjectionsRepo(deps: { salt: string; suppression: SuppressionRepo }): ObjectionsRepo {
  const { salt, suppression } = deps;

  return {
    async createPending(q, input) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = sha256Hex(token);
      const subjectHash = computeSuppressionHash(input.email, salt);
      const domainHash =
        input.scope === 'address_and_domain' ? computeSuppressionHash(input.domain, salt) : null;
      const ipHash = sha256Hex(input.requestIp);

      const row = await maybeOne<{ id: string }>(
        q,
        `INSERT INTO objection_requests
           (token_hash, subject_suppression_hash, domain_suppression_hash, scope, status, request_ip_hash, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, now() + ($6::text || ' seconds')::interval)
         RETURNING id`,
        [tokenHash, subjectHash, domainHash, input.scope, ipHash, String(input.ttlSeconds)],
      );
      return { objectionId: (row as { id: string }).id, token };
    },

    async confirm(q, token) {
      const tokenHash = sha256Hex(token);
      const row = await maybeOne<{
        id: string;
        subject_suppression_hash: string;
        domain_suppression_hash: string | null;
        scope: ObjectionScope;
        status: string;
        expired: boolean;
      }>(
        q,
        `SELECT id, subject_suppression_hash, domain_suppression_hash, scope, status,
                (expires_at < now()) AS expired
           FROM objection_requests
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash],
      );
      if (row === null) return { kind: 'not_found' };
      if (row.status === 'confirmed') return { kind: 'already_confirmed' };
      if (row.status === 'expired' || (row.status === 'pending' && row.expired)) return { kind: 'expired' };

      // Flip status + write suppression atomically (caller supplies the tx as `q`).
      await q.query(
        `UPDATE objection_requests SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
        [row.id],
      );
      const entries: Array<{ hash: SuppressionHash; scope: SuppressionScope }> = [
        { hash: row.subject_suppression_hash as SuppressionHash, scope: 'address' },
      ];
      if (row.domain_suppression_hash !== null) {
        entries.push({ hash: row.domain_suppression_hash as SuppressionHash, scope: 'domain' });
      }
      await suppression.writeSuppression(q, entries, q as unknown as PoolClient);
      return { kind: 'confirmed' };
    },

    async expireStale(q, now) {
      return rowCount(
        q,
        `UPDATE objection_requests SET status = 'expired'
          WHERE status = 'pending' AND expires_at < $1`,
        [now],
      );
    },

    async recentByIp(q, requestIp, windowSeconds) {
      const ipHash = sha256Hex(requestIp);
      const row = await maybeOne<{ n: string }>(
        q,
        `SELECT count(*)::text AS n
           FROM objection_requests
          WHERE request_ip_hash = $1
            AND created_at > now() - ($2::text || ' seconds')::interval`,
        [ipHash, String(windowSeconds)],
      );
      return row ? Number(row.n) : 0;
    },
  };
}
