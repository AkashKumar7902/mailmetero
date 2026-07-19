// @mailmetero/api — auth plugin (onRequest, second in the chain).
//
// Bearer is primary (`Authorization: Bearer sk_live_…`). Hunter's `api_key=` query param is
// accepted but DEPRECATED (D17): it is answered with a `Deprecation` header (set in the request-id
// onSend based on ctx.keyPresentation). HMAC verification runs in db's KeyAuthenticator (the pepper
// never leaves db). `sk_test_…` keys mark the request sandbox.
//
// NOTE: the API server runs with `logger:false` (see buildServer), so no request logger emits the
// credential. If a logger is ever enabled here it MUST be wired to config's pino redactor with paths
// that match the NESTED query param (`req.query.api_key`) and scrub `req.url` — a single-level
// `*.api_key` wildcard would not match, so log redaction is a deliberate no-op today, not a wildcard.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../deps.ts';
import type { KeyPresentation, RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';

/** Pull the raw key from Bearer (primary) or the deprecated `api_key=` query param. */
export function extractKey(request: FastifyRequest): { rawKey: string | null; presentation: KeyPresentation } {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return { rawKey: m[1].trim(), presentation: 'bearer' };
  }
  const q = request.query as Record<string, unknown> | undefined;
  const qKey = q?.['api_key'];
  if (typeof qKey === 'string' && qKey.length > 0) {
    return { rawKey: qKey, presentation: 'query_param' };
  }
  return { rawKey: null, presentation: 'none' };
}

function routeConfig(request: FastifyRequest): Partial<RouteConfig> {
  return (request.routeOptions?.config ?? {}) as Partial<RouteConfig>;
}

export function authPlugin(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('onRequest', async (request) => {
    const ctx = request.mmCtx;
    const cfg = routeConfig(request);
    const { rawKey, presentation } = extractKey(request);
    ctx.keyPresentation = presentation;

    // Public endpoints (objections, signup, openapi, healthz) never require a key.
    if (cfg.requiresAuth === false) return;

    if (rawKey === null) throw errors.invalidApiKey();

    const principal = await deps.auth.authenticate(rawKey);
    if (principal === null) throw errors.invalidApiKey();

    ctx.principal = {
      tenantId: principal.tenantId,
      keyId: principal.keyId,
      keyPrefix: principal.keyPrefix,
      environment: principal.environment,
      scopes: principal.scopes,
      planName: principal.planName,
    };
    ctx.isSandbox = principal.environment === 'test';
  });
}
