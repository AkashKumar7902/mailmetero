// @mailmetero/db — ApiKeysRepo.
//
// Stores only the key PREFIX (indexed for the auth hot path) and the HMAC hash hex
// (never the plaintext secret). `byPrefix` is the single indexed lookup the
// KeyAuthenticator uses before the constant-time HMAC compare.

import type { TenantId, IsoTimestamp } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rows } from '../client.ts';
import type { ApiKeyRow, Environment } from '../types.ts';

interface ApiKeyRaw {
  id: string;
  tenant_id: string;
  key_prefix: string;
  key_hash: string;
  environment: Environment;
  scopes: string[];
  label: string | null;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

function mapKey(r: ApiKeyRaw): ApiKeyRow {
  return {
    id: r.id,
    tenantId: r.tenant_id as TenantId,
    keyPrefix: r.key_prefix,
    keyHashHex: r.key_hash,
    environment: r.environment,
    scopes: r.scopes,
    label: r.label,
    createdAt: r.created_at as IsoTimestamp,
    revokedAt: r.revoked_at as IsoTimestamp | null,
    lastUsedAt: r.last_used_at as IsoTimestamp | null,
  };
}

const SELECT = `
  SELECT id, tenant_id, key_prefix, key_hash, environment, scopes, label,
         created_at, revoked_at, last_used_at
    FROM api_keys`;

export interface ApiKeysRepo {
  insert(
    q: Queryable,
    input: {
      tenantId: TenantId;
      keyPrefix: string;
      keyHashHex: string;
      environment: Environment;
      scopes: string[];
      label?: string;
    },
  ): Promise<ApiKeyRow>;
  byPrefix(q: Queryable, keyPrefix: string): Promise<ApiKeyRow | null>;
  touchLastUsed(q: Queryable, id: string, at: IsoTimestamp): Promise<void>;
  revoke(q: Queryable, id: string, at: IsoTimestamp): Promise<void>;
  listForTenant(q: Queryable, tenantId: TenantId): Promise<ApiKeyRow[]>;
}

export function createApiKeysRepo(): ApiKeysRepo {
  return {
    async insert(q, input) {
      const row = await maybeOne<ApiKeyRaw>(
        q,
        `INSERT INTO api_keys (tenant_id, key_prefix, key_hash, environment, scopes, label)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, tenant_id, key_prefix, key_hash, environment, scopes, label,
                   created_at, revoked_at, last_used_at`,
        [input.tenantId, input.keyPrefix, input.keyHashHex, input.environment, input.scopes, input.label ?? null],
      );
      return mapKey(row as ApiKeyRaw);
    },

    async byPrefix(q, keyPrefix) {
      const row = await maybeOne<ApiKeyRaw>(q, `${SELECT} WHERE key_prefix = $1`, [keyPrefix]);
      return row ? mapKey(row) : null;
    },

    async touchLastUsed(q, id, at) {
      await q.query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [id, at]);
    },

    async revoke(q, id, at) {
      await q.query(`UPDATE api_keys SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`, [id, at]);
    },

    async listForTenant(q, tenantId) {
      const rs = await rows<ApiKeyRaw>(q, `${SELECT} WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
      return rs.map(mapKey);
    },
  };
}
