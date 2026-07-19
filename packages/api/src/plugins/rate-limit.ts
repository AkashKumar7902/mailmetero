// @mailmetero/api — attempt-level rate limit (preHandler, after idempotency).
//
// D12: the limit is on attempts, enforced by an atomic per-key counter (RateLimiterPort →
// db.RateCountersRepo). Only routes flagged `rateLimited` and carrying an authenticated,
// non-sandbox principal consume a token. The X-RateLimit-* headers are populated on the context
// for every such response (including the 429 itself).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IsoTimestamp } from '@mailmetero/contracts';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';

function routeConfig(request: FastifyRequest): Partial<RouteConfig> {
  return (request.routeOptions?.config ?? {}) as Partial<RouteConfig>;
}

export function rateLimitPlugin(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('preHandler', async (request) => {
    const ctx = request.mmCtx;
    const cfg = routeConfig(request);
    if (cfg.rateLimited !== true) return;
    if (ctx.principal === null || ctx.isSandbox) return;

    const now = new Date().toISOString() as IsoTimestamp;
    const snapshot = await deps.rateLimiter.consumeAttempt(ctx.principal, now);
    ctx.rateLimit = {
      limit: snapshot.limit,
      remaining: snapshot.remaining,
      resetEpochSeconds: snapshot.resetEpochSeconds,
      exceeded: snapshot.exceeded,
    };

    if (snapshot.exceeded) {
      const retryAfter = Math.max(1, snapshot.resetEpochSeconds - Math.floor(Date.now() / 1000));
      throw errors.rateLimited(retryAfter);
    }
  });
}
