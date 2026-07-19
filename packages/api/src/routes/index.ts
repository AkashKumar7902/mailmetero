// @mailmetero/api — route registration.
//
// Registers every /v2 route module against the instance. The cross-cutting hook chain is installed
// separately in buildServer (request-id → auth → idempotency → rate-limit → onSend headers); each
// route only declares its handler + per-route RouteConfig.

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.ts';
import { finderRoutes } from './finder.ts';
import { verifierRoutes } from './verifier.ts';
import { bulkRoutes } from './bulk.ts';
import { accountRoutes } from './account.ts';
import { complianceRoutes } from './compliance.ts';
import { metaRoutes } from './meta.ts';

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  finderRoutes(app, deps);
  verifierRoutes(app, deps);
  bulkRoutes(app, deps);
  accountRoutes(app, deps);
  complianceRoutes(app, deps);
  metaRoutes(app, deps);
}
