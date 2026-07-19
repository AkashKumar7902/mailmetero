// @mailmetero/api — compliance routes: signup, public objection intake, and tenant DSAR.
//
// signup (public): email-verified free-tier key delivered by email; disposable domains are blocked
// (D12). objections (public, UNAUTHENTICATED): constant-shaped, rate-limited acknowledgment — the
// confirmation link is what actually writes the irreversible global suppression hash later (D5).
// data-subjects export/delete: tenant-scoped DSAR; delete removes ONLY this tenant's rows and never
// writes global suppression (D6).

import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.ts';
import type { RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';
import {
  signupBodySchema,
  objectionsBodySchema,
  objectionConfirmQuerySchema,
  dsarQuerySchema,
} from '../schemas/routes.ts';
import { ctxOf, sendSuccess } from './support.ts';

const PUBLIC = { requiresAuth: false, rateLimited: false, getIdempotent: false, postIdempotent: false, sandboxable: false } as const;

const SIGNUP_CONFIG: RouteConfig = { endpoint: 'signup', ...PUBLIC };
const OBJECTIONS_CONFIG: RouteConfig = { endpoint: 'objections', ...PUBLIC };
// The confirm click is public + unauthenticated; it shares the objections endpoint label (no
// rate-limit token, no idempotency) since the underlying repo is idempotent on already-confirmed.
const OBJECTIONS_CONFIRM_CONFIG: RouteConfig = { endpoint: 'objections', ...PUBLIC };
const DSAR_EXPORT_CONFIG: RouteConfig = {
  endpoint: 'data_subjects_export',
  requiresAuth: true,
  rateLimited: false,
  getIdempotent: false,
  postIdempotent: false,
  sandboxable: false,
};
const DSAR_DELETE_CONFIG: RouteConfig = { ...DSAR_EXPORT_CONFIG, endpoint: 'data_subjects_delete' };

const SIGNUP_ACK = 'If the address is eligible, a confirmation email with your API key has been sent.';
const OBJECTION_ACK = 'If the address is eligible, a confirmation link has been sent to it.';
const OBJECTION_CONFIRM_ACK = 'If the link was valid, your request has been recorded.';

export function complianceRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post('/v2/signup', { schema: { body: signupBodySchema }, config: SIGNUP_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const email = (request.body as { email: string }).email.trim();
    const outcome = await deps.compliance.createSignup(email, request.ip);

    if ('blocked' in outcome) throw errors.signupDisposableBlocked();
    if ('token' in outcome) {
      await deps.email.sendSignupConfirmation(email, outcome.token).catch(() => {});
    }
    // Constant-shaped ack for success and rate-limited alike (no account enumeration).
    return sendSuccess(reply, ctx.requestId, { message: SIGNUP_ACK }, 202);
  });

  app.post('/v2/objections', { schema: { body: objectionsBodySchema }, config: OBJECTIONS_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const email = (request.body as { email: string }).email.trim();
    const outcome = await deps.compliance.createObjection(email, request.ip);
    // Only email a confirmation token when the intake was accepted; a throttled request collapses
    // into the SAME constant 202 below (no signal to the caller whether it was accepted or limited).
    if ('token' in outcome) {
      await deps.email.sendObjectionConfirmation(email, outcome.token).catch(() => {});
    }
    // Always 202 + constant body regardless of whether the address exists anywhere (anti-poisoning).
    return sendSuccess(reply, ctx.requestId, { message: OBJECTION_ACK }, 202);
  });

  // The link a data subject clicks from the confirmation email — verifying the emailed token writes
  // the irreversible global suppression atomically (B1). Constant-shaped: never reveals whether the
  // token matched, expired, or was already used (anti-enumeration).
  app.get('/v2/objections/confirm', { schema: { querystring: objectionConfirmQuerySchema }, config: OBJECTIONS_CONFIRM_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const token = (request.query as { token: string }).token;
    await deps.compliance.confirmObjection(token);
    return sendSuccess(reply, ctx.requestId, { message: OBJECTION_CONFIRM_ACK }, 200);
  });

  app.get('/v2/data-subjects/export', { schema: { querystring: dsarQuerySchema }, config: DSAR_EXPORT_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const email = (request.query as { email: string }).email.trim();
    const rows = await deps.compliance.dsarExport(ctx.principal!.tenantId, email);
    return sendSuccess(reply, ctx.requestId, rows);
  });

  app.delete('/v2/data-subjects', { schema: { querystring: dsarQuerySchema }, config: DSAR_DELETE_CONFIG }, async (request, reply) => {
    const ctx = ctxOf(request);
    const email = (request.query as { email: string }).email.trim();
    await deps.compliance.dsarDelete(ctx.principal!.tenantId, email);
    return reply.status(204).send();
  });
}
