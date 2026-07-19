// @mailmetero/api — GET /v2/email-verifier (sync fast-path → 202 async) and GET /v2/verifications/{id}.
//
// email-verifier: sandbox → canonicalize → pipeline.verify. Resolvable inside the sync budget →
// 200 + settled billing. Otherwise the pipeline defers: we enqueue a background job and answer 202
// + Location (Hunter's own pattern). verifications/{id}: poll — `job_pending` (202 + Retry-After)
// while running, the wire VerifierResult when done. Billing for the async path is settled by the
// worker, never here.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { JobId } from '@mailmetero/contracts';
import type { VerifierRequest } from '@mailmetero/pipeline';
import { validateEmailSyntax } from '@mailmetero/core';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';
import { toVerifierResult } from '../mapping/wire.ts';
import { settleBilling } from '../plugins/billing.ts';
import { verifierQuerySchema, verificationsParamsSchema } from '../schemas/routes.ts';
import { ctxOf, respondSandbox, sendSuccess, verificationLocation } from './support.ts';
import { HEADER } from '../headers.ts';

const VERIFIER_CONFIG: RouteConfig = {
  endpoint: 'email_verifier',
  requiresAuth: true,
  rateLimited: true,
  getIdempotent: true,
  postIdempotent: false,
  sandboxable: true,
};

const POLL_CONFIG: RouteConfig = {
  endpoint: 'verifications_get',
  requiresAuth: true,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: false,
  sandboxable: false,
};

function cacheHash(email: string): string {
  return createHash('sha256').update(`verify:${email}`).digest('hex');
}

export function verifierRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v2/email-verifier', { schema: { querystring: verifierQuerySchema }, config: VERIFIER_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const emailRaw = ((request.query as { email?: string }).email ?? '').trim();

    if (ctx.isSandbox) {
      const outcome = deps.sandbox.resolve('email_verifier', request);
      if (outcome !== null) {
        return respondSandbox(reply, ctx, outcome);
      }
    }

    const verdict = validateEmailSyntax(emailRaw);
    if (!verdict.ok) throw errors.invalidEmail(`"${emailRaw}" is not a valid email address`);

    const domainInput = deps.core.classifyDomainInput(verdict.domain, deps.core.classificationTables);
    if (domainInput === null) throw errors.invalidEmail(`"${emailRaw}" has no registrable domain`);

    const req: VerifierRequest = {
      tenantId: ctx.principal!.tenantId,
      requestId: ctx.requestId,
      email: verdict.email,
      domain: domainInput,
      cacheKey: { kind: 'verify', hash: cacheHash(verdict.email) },
    };

    const out = await deps.pipeline.verify(req);
    if (out.kind === 'input_error') {
      if (out.code === 'invalid_email') throw errors.invalidEmail(out.details);
      throw errors.validationError(out.details);
    }
    if (out.kind === 'unavailable') throw errors.verificationUnavailable();
    if (out.kind === 'deferred') {
      const { jobId } = await deps.jobs.enqueueVerification(ctx.principal!.tenantId, verdict.email, ctx.requestId);
      reply.header(HEADER.location, verificationLocation(jobId));
      return sendSuccess(reply, ctx.requestId, { job_id: jobId, status: 'queued' }, 202);
    }

    await settleBilling(deps, ctx, 'email_verifier', out.result, out.billingInput);
    return sendSuccess(reply, ctx.requestId, toVerifierResult(out.result));
  });

  app.get('/v2/verifications/:id', { schema: { params: verificationsParamsSchema }, config: POLL_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const jobId = (request.params as { id: string }).id as JobId;

    const outcome = await deps.jobs.getVerification(ctx.principal!.tenantId, jobId);
    if (outcome === null) throw errors.notFound(`No verification job ${jobId}`);
    if (outcome.kind === 'failed') throw errors.verificationUnavailable('The verification job failed');
    if (outcome.kind === 'pending') {
      throw errors.jobPending(
        { retryAfterSeconds: deps.config.jobPendingRetryAfterSeconds, location: verificationLocation(jobId) },
        'Verification still in progress',
      );
    }
    return sendSuccess(reply, ctx.requestId, outcome.result);
  });
}
