// @mailmetero/api — response header setters (PRD §3, CONTRACTS_CORE §4.2).
//
// Every response (success AND error) carries X-Request-Id, X-Billed, X-Credits-Remaining and
// the X-RateLimit-* triple. Conditional headers (Location, Retry-After, Deprecation) are set by
// the error handler / route as needed. The onSend hook calls `applyStandardHeaders` last so the
// values reflect the fully-settled context.

import type { FastifyReply } from 'fastify';
import type { RequestContext } from './types.ts';

/** Canonical header names — the single source referenced by hooks, routes, and the error handler. */
export const HEADER = {
  requestId: 'X-Request-Id',
  billed: 'X-Billed',
  creditsRemaining: 'X-Credits-Remaining',
  rlLimit: 'X-RateLimit-Limit',
  rlRemaining: 'X-RateLimit-Remaining',
  rlReset: 'X-RateLimit-Reset',
  location: 'Location',
  retryAfter: 'Retry-After',
  deprecation: 'Deprecation',
} as const;

/**
 * Set the mandatory headers from the request context. Idempotent: safe to call from onSend even
 * if the route already emitted a Location/Retry-After.
 */
export function applyStandardHeaders(reply: FastifyReply, ctx: RequestContext): void {
  reply.header(HEADER.requestId, ctx.requestId);
  reply.header(HEADER.billed, ctx.billing?.billed ? '1' : '0');

  if (ctx.creditsRemaining !== null) {
    reply.header(HEADER.creditsRemaining, String(ctx.creditsRemaining));
  }

  if (ctx.rateLimit !== null) {
    reply.header(HEADER.rlLimit, String(ctx.rateLimit.limit));
    reply.header(HEADER.rlRemaining, String(Math.max(0, ctx.rateLimit.remaining)));
    reply.header(HEADER.rlReset, String(ctx.rateLimit.resetEpochSeconds));
  }
}

/**
 * Emit the `Deprecation` header when the caller used the legacy `api_key=` query param (D17). The
 * value is a stable sunset marker; the key itself is already redacted from logs by the auth hook.
 */
export function applyDeprecationHeader(reply: FastifyReply, ctx: RequestContext): void {
  if (ctx.keyPresentation === 'query_param') {
    reply.header(HEADER.deprecation, 'true');
  }
}
