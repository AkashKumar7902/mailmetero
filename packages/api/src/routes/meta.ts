// @mailmetero/api — meta routes: GET /v2/openapi.json (the contract source of truth) and GET /healthz.
//
// Both are public and un-enveloped. openapi.json returns the hand-written OpenAPI 3.1 document
// verbatim. healthz pings the DB dependency and returns 503 if it is unreachable (for Render's
// health check).

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { OPENAPI_DOCUMENT } from '../openapi/spec.ts';
import { ctxOf } from './support.ts';

const OPENAPI_CONFIG: RouteConfig = {
  endpoint: 'openapi',
  requiresAuth: false,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: false,
  sandboxable: false,
};
const HEALTHZ_CONFIG: RouteConfig = { ...OPENAPI_CONFIG, endpoint: 'healthz' };

export function metaRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v2/openapi.json', { config: OPENAPI_CONFIG }, async (_request, reply) => {
    return reply.header('content-type', 'application/json').send(OPENAPI_DOCUMENT);
  });

  app.get('/healthz', { config: HEALTHZ_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    let dbOk = false;
    try {
      dbOk = await deps.compliance.healthPing();
    } catch {
      dbOk = false;
    }
    return reply.status(dbOk ? 200 : 503).send({ status: dbOk ? 'ok' : 'degraded', request_id: ctx.requestId, checks: { db: dbOk } });
  });
}
