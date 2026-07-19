// @mailmetero/api — bulk endpoints (P0-7): POST finds/verifications (async jobs), GET status/results.
//
// POSTs are `Idempotency-Key`-idempotent (the postIdempotency hook replays a duplicate submission).
// A payload over `bulkMaxRows` is `payload_too_large` (413). Reads return the WIRE per-row shapes
// exactly as the worker stored them (job_items carry wire), paginated via meta.total/next_offset.

import type { FastifyInstance } from 'fastify';
import type { JobId } from '@mailmetero/contracts';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';
import {
  bulkFindsBodySchema,
  bulkVerificationsBodySchema,
  bulkJobParamsSchema,
  bulkResultsQuerySchema,
} from '../schemas/routes.ts';
import { ctxOf, sendSuccess } from './support.ts';

const POST_FINDS_CONFIG: RouteConfig = {
  endpoint: 'bulk_finds',
  requiresAuth: true,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: true,
  sandboxable: false,
};
const POST_VERIFY_CONFIG: RouteConfig = { ...POST_FINDS_CONFIG, endpoint: 'bulk_verifications' };
const STATUS_CONFIG: RouteConfig = {
  endpoint: 'bulk_status',
  requiresAuth: true,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: false,
  sandboxable: false,
};
const RESULTS_CONFIG: RouteConfig = { ...STATUS_CONFIG, endpoint: 'bulk_results' };

function idempotencyKeyOf(headers: Record<string, unknown>, fallback: string): string {
  const h = headers['idempotency-key'];
  return typeof h === 'string' && h.length > 0 ? h : fallback;
}

export function bulkRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v2/bulk/finds', { schema: { body: bulkFindsBodySchema }, config: POST_FINDS_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const rows = request.body as Array<{ first_name: string; last_name: string; domain: string }>;
    if (rows.length > deps.config.bulkMaxRows) {
      throw errors.payloadTooLarge(`Bulk finds accepts at most ${deps.config.bulkMaxRows} rows`);
    }
    const key = idempotencyKeyOf(request.headers as Record<string, unknown>, ctx.requestId);
    const accepted = await deps.jobs.enqueueBulkFinds(ctx.principal!.tenantId, ctx.requestId, key, rows);
    return sendSuccess(reply, ctx.requestId, accepted, 202);
  });

  app.post('/v2/bulk/verifications', { schema: { body: bulkVerificationsBodySchema }, config: POST_VERIFY_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const emails = request.body as string[];
    if (emails.length > deps.config.bulkMaxRows) {
      throw errors.payloadTooLarge(`Bulk verifications accepts at most ${deps.config.bulkMaxRows} rows`);
    }
    const key = idempotencyKeyOf(request.headers as Record<string, unknown>, ctx.requestId);
    const accepted = await deps.jobs.enqueueBulkVerifications(ctx.principal!.tenantId, ctx.requestId, key, emails);
    return sendSuccess(reply, ctx.requestId, accepted, 202);
  });

  app.get('/v2/bulk/:job_id', { schema: { params: bulkJobParamsSchema }, config: STATUS_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const jobId = (request.params as { job_id: string }).job_id as JobId;
    const status = await deps.jobs.getJob(ctx.principal!.tenantId, jobId);
    if (status === null) throw errors.notFound(`No job ${jobId}`);
    return sendSuccess(reply, ctx.requestId, status);
  });

  app.get(
    '/v2/bulk/:job_id/results',
    { schema: { params: bulkJobParamsSchema, querystring: bulkResultsQuerySchema }, config: RESULTS_CONFIG },
    async (request, reply) => {
      const ctx = ctxOf(request);
      const jobId = (request.params as { job_id: string }).job_id as JobId;
      const query = (request.query as { limit?: number; offset?: number }) ?? {};
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;
      const page = await deps.jobs.getJobResults(ctx.principal!.tenantId, jobId, limit, offset);
      if (page === null) throw errors.notFound(`No job ${jobId}`);
      return sendSuccess(reply, ctx.requestId, page.rows, 200, { total: page.total, nextOffset: page.nextOffset });
    },
  );
}
