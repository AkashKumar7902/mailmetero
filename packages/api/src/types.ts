// @mailmetero/api — request-scoped types, endpoint identifiers, per-route config, and the
// Fastify request-decorator augmentation. The hook chain reads/writes `request.mmCtx`.

import type { RequestId } from '@mailmetero/contracts';
import type { AuthPrincipal } from './deps.ts';

/** Every operationId in the OpenAPI document — the closed set of routes. */
export const ENDPOINT_IDS = [
  'email_finder',
  'email_verifier',
  'verifications_get',
  'bulk_finds',
  'bulk_verifications',
  'bulk_status',
  'bulk_results',
  'account',
  'usage',
  'signup',
  'objections',
  'data_subjects_export',
  'data_subjects_delete',
  'openapi',
  'healthz',
] as const;
export type EndpointId = (typeof ENDPOINT_IDS)[number];

/** How the caller presented their key. `query_param` triggers the Deprecation header (D17). */
export type KeyPresentation = 'bearer' | 'query_param' | 'none';

/** The rate-limit snapshot attached to the context after the limiter runs. */
export interface RateLimitState {
  limit: number;
  remaining: number;
  resetEpochSeconds: number;
  exceeded: boolean;
}

/**
 * Per-route static config, carried on Fastify's route `config`. The global hooks read this to
 * decide whether to authenticate, rate-limit, or apply idempotency — so the hook chain stays
 * fixed while individual routes opt in/out declaratively.
 */
export interface RouteConfig {
  endpoint: EndpointId;
  /** Public endpoints (objections, signup, openapi, healthz) set this false. */
  requiresAuth: boolean;
  /** Billable unit endpoints consume an attempt-level rate token in preHandler. */
  rateLimited: boolean;
  /** GET unit endpoints get 24h request-hash dedupe. */
  getIdempotent: boolean;
  /** Bulk POST endpoints honor the `Idempotency-Key` header. */
  postIdempotent: boolean;
  /** Sandbox (`sk_test_…`) requests short-circuit to deterministic fixtures at 0 credits. */
  sandboxable: boolean;
}

/** Request-scoped mutable context threaded through the hook chain (MODULE_CONTRACTS §8). */
export interface RequestContext {
  requestId: RequestId;
  principal: AuthPrincipal | null;
  keyPresentation: KeyPresentation;
  isSandbox: boolean;
  rateLimit: RateLimitState | null;
  creditsRemaining: number | null;
  billing: { billed: boolean } | null;
  /** Exactly-once guard so settleBilling never double-records for one request. */
  billedApplied: boolean;
  startedAtMs: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the request-id onRequest hook; mutated by auth/rate-limit/billing. */
    mmCtx: RequestContext;
  }
  interface FastifyContextConfig extends Partial<RouteConfig> {}
}
