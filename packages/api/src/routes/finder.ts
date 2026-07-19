// @mailmetero/api — GET /v2/email-finder.
//
// Flow: sandbox short-circuit → canonicalize inputs (name + domain) → pipeline.find → settleBilling
// → wire. Domain is REQUIRED in v1 (D3): a missing domain is `domain_required`, an unparseable one
// `invalid_domain`. Suppression is invisible — a suppressed subject returns the ordinary not-found
// shape, never a distinct code (D5); the route never branches on it.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { RequestId } from '@mailmetero/contracts';
import type { FinderRequest } from '@mailmetero/pipeline';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';
import { toFinderResult } from '../mapping/wire.ts';
import { settleBilling } from '../plugins/billing.ts';
import { finderQuerySchema } from '../schemas/routes.ts';
import { ctxOf, respondSandbox, sendSuccess } from './support.ts';

interface FinderQuery {
  domain?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  middle_name?: string;
  max_duration?: number;
}

function cacheHash(domain: string, first: string | null, last: string | null, middle: string | null): string {
  return createHash('sha256').update(`find:${domain}:${first ?? ''}:${last ?? ''}:${middle ?? ''}`).digest('hex');
}

const CONFIG: RouteConfig = {
  endpoint: 'email_finder',
  requiresAuth: true,
  rateLimited: true,
  getIdempotent: true,
  postIdempotent: false,
  sandboxable: true,
};

export function finderRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/v2/email-finder', { schema: { querystring: finderQuerySchema }, config: CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const query = (request.query as FinderQuery) ?? {};

    if (ctx.isSandbox) {
      const outcome = deps.sandbox.resolve('email_finder', request);
      if (outcome !== null) {
        return respondSandbox(reply, ctx, outcome);
      }
    }

    const domainRaw = (query.domain ?? '').trim();
    if (domainRaw.length === 0) throw errors.domainRequired();

    const domainInput = deps.core.classifyDomainInput(domainRaw, deps.core.classificationTables);
    if (domainInput === null) throw errors.invalidDomain(`Cannot parse a registrable domain from "${domainRaw}"`);

    const hasName =
      (query.first_name ?? '').trim().length > 0 ||
      (query.last_name ?? '').trim().length > 0 ||
      (query.full_name ?? '').trim().length > 0;
    if (!hasName) throw errors.validationError('A first_name/last_name or full_name is required');

    const name = deps.core.normalizeName(
      {
        ...(query.first_name !== undefined ? { firstName: query.first_name } : {}),
        ...(query.last_name !== undefined ? { lastName: query.last_name } : {}),
        ...(query.middle_name !== undefined ? { middleName: query.middle_name } : {}),
        ...(query.full_name !== undefined ? { fullName: query.full_name } : {}),
      },
      deps.core.nicknameMap,
      { domain: domainInput.domain },
    );

    const hash = cacheHash(domainInput.domain, name.normalized.firstName, name.normalized.lastName, name.normalized.middleName);
    const req: FinderRequest = {
      tenantId: ctx.principal!.tenantId,
      requestId: ctx.requestId,
      name,
      domain: domainInput,
      cacheKey: { kind: 'find', hash },
      ...(query.max_duration !== undefined ? { maxDurationMs: query.max_duration } : {}),
    };

    const out = await deps.pipeline.find(req);
    if (out.kind === 'input_error') {
      if (out.code === 'invalid_domain') throw errors.invalidDomain(out.details);
      throw errors.validationError(out.details);
    }
    if (out.kind === 'unavailable') throw errors.serviceUnavailable('The finder is temporarily unavailable');

    await settleBilling(deps, ctx, 'email_finder', out.result, out.billingInput);
    return sendSuccess(reply, ctx.requestId as RequestId, toFinderResult(out.result));
  });
}
