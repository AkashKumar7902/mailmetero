// @mailmetero/api — buildServer: assemble the Fastify instance with the FIXED hook chain.
//
// onRequest:  request-id (mint ctx)          → auth (Bearer / deprecated api_key=)
// preHandler: getIdempotency → postIdempotency → rate-limit (attempt-level)
// handler:    route (settleBilling inside)
// onSend:     applyStandardHeaders + Deprecation (success AND error), then idempotency store
//
// Registration order is what fixes the chain: hooks of the same phase run in the order they were
// added, so request-id's onRequest/onSend bracket everything, and idempotency precedes rate-limit.

import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiDeps } from './deps.ts';
import { registerSchemas } from './schemas/index.ts';
import { registerErrorHandlers } from './errors.ts';
import { requestIdPlugin } from './plugins/request-id.ts';
import { authPlugin } from './plugins/auth.ts';
import { getIdempotencyPlugin, postIdempotencyPlugin } from './plugins/idempotency.ts';
import { rateLimitPlugin } from './plugins/rate-limit.ts';
import { registerRoutes } from './routes/index.ts';

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: deps.config.bodyLimitBytes,
    trustProxy: deps.config.trustProxy,
    logger: false,
    // We mint/echo X-Request-Id ourselves in the request-id plugin.
    genReqId: () => 'pending',
  });

  registerSchemas(app);
  registerErrorHandlers(app);

  // onRequest: request-id BEFORE auth.
  requestIdPlugin(app, deps);
  authPlugin(app, deps);

  // preHandler: idempotency (GET dedupe, POST header) BEFORE rate-limit.
  getIdempotencyPlugin(app, deps);
  postIdempotencyPlugin(app, deps);
  rateLimitPlugin(app, deps);

  await registerRoutes(app, deps);
  await app.ready();
  return app;
}
