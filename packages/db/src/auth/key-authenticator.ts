// @mailmetero/db — HMAC KeyAuthenticator (the pepper lives HERE and nowhere else).
//
// Flow: parse `sk_{env}_{8}{secret}` → indexed prefix lookup (ApiKeysRepo.byPrefix) →
// recompute HMAC-SHA256(secret, APP_PEPPER) → CONSTANT-TIME compare against the stored
// hash. Supports one previous pepper for zero-downtime rotation (OQ8). Reads run on the
// pooled web pool. Revoked keys never authenticate.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TenantId, IsoTimestamp } from '@mailmetero/contracts';
import type { AppConfig } from '@mailmetero/config';
import type { DbPools } from '../pool.ts';
import type { Environment } from '../types.ts';
import { createApiKeysRepo, type ApiKeysRepo } from '../repositories/api-keys.ts';
import { createTenantsRepo, type TenantsRepo } from '../repositories/tenants.ts';

export interface AuthenticatedKey {
  tenantId: TenantId;
  keyId: string;
  keyPrefix: string;
  environment: Environment;
  scopes: string[];
  planName: string;
}

export interface KeyAuthenticator {
  authenticate(rawKey: string): Promise<AuthenticatedKey | null>;
}

/** `sk_live_XXXXXXXX` / `sk_test_XXXXXXXX` — 8-char scheme prefix + 8-char random tail. */
const PREFIX_LEN = 16;
const KEY_RE = /^sk_(live|test)_[a-z0-9]{8,}$/i;

function hmacHex(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

/** Constant-time hex compare. Equal-length SHA-256 hex (64 chars) always; guards anyway. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}

export function createKeyAuthenticator(pools: DbPools, cfg: AppConfig): KeyAuthenticator {
  const apiKeys: ApiKeysRepo = createApiKeysRepo();
  const tenants: TenantsRepo = createTenantsRepo();
  const peppers: string[] = [cfg.env.appPepper];
  if (cfg.env.appPepperPrevious) peppers.push(cfg.env.appPepperPrevious);

  return {
    async authenticate(rawKey) {
      if (typeof rawKey !== 'string' || !KEY_RE.test(rawKey)) return null;
      const keyPrefix = rawKey.slice(0, PREFIX_LEN);
      const secret = rawKey.slice(PREFIX_LEN);
      if (secret.length === 0) return null;

      const row = await apiKeys.byPrefix(pools.web, keyPrefix);
      if (row === null || row.revokedAt !== null) return null;

      // Recompute against the current pepper, then any rotation pepper. Constant-time.
      let matched = false;
      for (const pepper of peppers) {
        if (constantTimeEqualHex(hmacHex(secret, pepper), row.keyHashHex)) {
          matched = true;
          break;
        }
      }
      if (!matched) return null;

      const tenant = await tenants.byId(pools.web, row.tenantId);
      if (tenant === null || tenant.status !== 'active') return null;

      // Best-effort last-used stamp; must never block or fail authentication.
      void apiKeys.touchLastUsed(pools.web, row.id, new Date().toISOString() as IsoTimestamp).catch(() => {});

      return {
        tenantId: row.tenantId,
        keyId: row.id,
        keyPrefix: row.keyPrefix,
        environment: row.environment,
        scopes: row.scopes,
        planName: tenant.planName,
      };
    },
  };
}
