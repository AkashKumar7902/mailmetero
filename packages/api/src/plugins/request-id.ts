// @mailmetero/api — request-id plugin (first in the chain).
//
// onRequest: mint/echo the request id and initialize the request context BEFORE any other hook.
// onSend: apply the standard headers + Deprecation on the way out (success AND error), so every
// response carries them and the values reflect the fully-settled context.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IsoTimestamp, RequestId } from '@mailmetero/contracts';
import type { ApiDeps } from '../deps.ts';
import type { RequestContext } from '../types.ts';
import { applyStandardHeaders, applyDeprecationHeader, HEADER } from '../headers.ts';

/** Accept a client-supplied X-Request-Id only when it is a short, safe token; else mint one. */
function resolveRequestId(raw: unknown): RequestId {
  if (typeof raw === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(raw)) {
    return raw as RequestId;
  }
  return randomUUID() as RequestId;
}

/**
 * Fill in the mandatory X-Credits-Remaining and X-RateLimit-* triple for any response that did not
 * already populate them (M6): every authenticated response — non-billed, deferred 202, and error
 * paths alike — must carry all six headers. The credit balance is a LIVE read; the rate-limit values
 * come from a read-only peek that never consumes a token. A 401 emits the unauthenticated bucket.
 */
async function snapshotHeaderState(deps: ApiDeps, ctx: RequestContext, statusCode: number): Promise<void> {
  const now = new Date().toISOString() as IsoTimestamp;
  if (ctx.principal !== null) {
    if (ctx.creditsRemaining === null) {
      try {
        ctx.creditsRemaining = await deps.ledger.creditsRemaining(ctx.principal.tenantId);
      } catch {
        // Leave null rather than fail the response; the header is simply omitted on a DB error.
      }
    }
    if (ctx.rateLimit === null) {
      try {
        const peek = await deps.rateLimiter.peek(ctx.principal, now);
        ctx.rateLimit = { limit: peek.limit, remaining: peek.remaining, resetEpochSeconds: peek.resetEpochSeconds, exceeded: false };
      } catch {
        // Leave null on a DB error.
      }
    }
  } else if (ctx.rateLimit === null && statusCode === 401) {
    try {
      const peek = await deps.rateLimiter.peek(null, now);
      ctx.rateLimit = { limit: peek.limit, remaining: peek.remaining, resetEpochSeconds: peek.resetEpochSeconds, exceeded: false };
    } catch {
      // Leave null on error.
    }
  }
}

export function requestIdPlugin(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('onRequest', async (request) => {
    const ctx: RequestContext = {
      requestId: resolveRequestId(request.headers['x-request-id']),
      principal: null,
      keyPresentation: 'none',
      isSandbox: false,
      rateLimit: null,
      creditsRemaining: null,
      billing: null,
      billedApplied: false,
      startedAtMs: Date.now(),
    };
    request.mmCtx = ctx;
    // Set the id immediately so it is present even if a later hook throws before onSend.
    request.raw.headers['x-request-id'] = ctx.requestId;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const ctx = request.mmCtx;
    if (ctx !== undefined) {
      // Snapshot credit + rate-limit state into ctx BEFORE emitting headers, so every response
      // (including non-billed, 202, and error paths) carries all six mandatory headers.
      await snapshotHeaderState(deps, ctx, reply.statusCode);
      applyStandardHeaders(reply, ctx);
      applyDeprecationHeader(reply, ctx);
    } else {
      reply.header(HEADER.requestId, randomUUID());
    }
    return payload;
  });
}
