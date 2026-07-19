// @mailmetero/api — GET /v2/account (Hunter parity) and GET /v2/usage (live metering detail).
//
// Read-only, unbilled, not rate-limited. Both refresh the X-Credits-Remaining header from the live
// balance so a client can track credits without a separate call.

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { accountQuerySchema, usageQuerySchema } from '../schemas/routes.ts';
import { ctxOf, sendSuccess } from './support.ts';

const ACCOUNT_CONFIG: RouteConfig = {
  endpoint: 'account',
  requiresAuth: true,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: false,
  sandboxable: false,
};
const USAGE_CONFIG: RouteConfig = { ...ACCOUNT_CONFIG, endpoint: 'usage' };

export function accountRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v2/account', { schema: { querystring: accountQuerySchema }, config: ACCOUNT_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const account = await deps.account.getAccount(ctx.principal!.tenantId);
    ctx.creditsRemaining = await deps.ledger.creditsRemaining(ctx.principal!.tenantId).catch(() => null);
    return sendSuccess(reply, ctx.requestId, account);
  });

  app.get('/v2/usage', { schema: { querystring: usageQuerySchema }, config: USAGE_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const query = (request.query as { from?: string; to?: string }) ?? {};
    const usage = await deps.account.getUsage(ctx.principal!.tenantId, query.from, query.to);
    ctx.creditsRemaining = usage.credits_remaining;
    return sendSuccess(reply, ctx.requestId, usage);
  });
}
