// Stage 3 — per-tenant TTL-fresh result cache (verdict reuse, FREE on hit).
//
// Read-only reuse of a fresh prior verdict for THIS tenant (never cross-tenant — D1). api/worker
// own the write side via ResultsRepo; here we only look up. A hit short-circuits the rest of the
// pipeline. The billing no-double-bill guarantee is enforced by the api 24h request-hash
// idempotency layer (§4); this cache carries a `cache_hit_tenant` provenance reason. PRD §6 stage 3.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
  finderOk,
  verifierOk,
} from '../stage.ts';
import type { InternalFinderResult, InternalVerifierResult } from '../types.ts';
import type { ReasonCode } from '@mailmetero/contracts';

function withCacheReason<T extends { reasonCodes: ReasonCode[] }>(r: T): T {
  if (!r.reasonCodes.includes('cache_hit_tenant')) {
    return { ...r, reasonCodes: ['cache_hit_tenant', ...r.reasonCodes] };
  }
  return r;
}

export function makeTenantCacheStage(): Stage {
  return {
    id: 'tenant_cache',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const hit = await ctx.deps.tenantCache.lookup(ctx.tenantId, ctx.cacheKey);
      if (hit === null) return CONTINUE;

      if (ctx.mode === 'finder') {
        return finderOk(withCacheReason(hit.result as InternalFinderResult));
      }
      return verifierOk(withCacheReason(hit.result as InternalVerifierResult));
    },
  };
}
