// @mailmetero/api — shared route helpers.
//
// Small, dependency-light utilities the route handlers reuse: reading the request context, sending
// the success envelope, and turning a sandbox fixture outcome into an HTTP response.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Meta, RequestId } from '@mailmetero/contracts';
import { successEnvelope, makeMeta } from '../envelope.ts';
import { HEADER } from '../headers.ts';
import type { FixtureCase } from '../sandbox/fixtures.ts';
import type { RequestContext } from '../types.ts';

export function ctxOf(request: FastifyRequest): RequestContext {
  return request.mmCtx;
}

/**
 * Send `{ data, meta }` at the given status (default 200). Returns the reply so the handler can
 * `return sendSuccess(...)`: with async onSend hooks the raw response is not ended synchronously, so
 * returning the reply is what tells Fastify the response is handled and prevents a second (undefined)
 * send from the async-handler wrapper.
 */
export function sendSuccess<T>(
  reply: FastifyReply,
  requestId: RequestId,
  data: T,
  status = 200,
  pagination?: { total: number; nextOffset: number | null },
): FastifyReply {
  const meta: Meta = makeMeta(requestId, pagination);
  return reply.status(status).send(successEnvelope(data, meta));
}

/** The Location target for an async verification job. */
export function verificationLocation(jobId: string): string {
  return `/v2/verifications/${jobId}`;
}

/**
 * Render a sandbox fixture outcome and return the reply (so the handler can `return respondSandbox(...)`);
 * for the `error` outcome it throws the carried ApiException (handled by the error handler). Sandbox
 * never bills: the billing flag stays 0 and no credit is debited.
 */
export function respondSandbox(reply: FastifyReply, ctx: RequestContext, outcome: FixtureCase['outcome']): FastifyReply {
  ctx.billing = { billed: false };
  ctx.creditsRemaining = 0;
  switch (outcome.kind) {
    case 'finder':
      return sendSuccess(reply, ctx.requestId, outcome.result);
    case 'verifier':
      return sendSuccess(reply, ctx.requestId, outcome.result);
    case 'async_202':
      reply.header(HEADER.location, verificationLocation(outcome.jobId));
      return sendSuccess(reply, ctx.requestId, { job_id: outcome.jobId, status: 'queued' }, 202);
    case 'error':
      throw outcome.error;
    default: {
      const _never: never = outcome;
      return _never;
    }
  }
}
