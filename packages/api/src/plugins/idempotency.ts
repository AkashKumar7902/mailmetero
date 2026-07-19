// @mailmetero/api — idempotency (preHandler, before rate-limit).
//
// Two stores, one purpose — a retry never double-bills (P0-9, D13):
//   • GET unit endpoints: 24h request-hash dedupe. Same (tenant, endpoint, query) inside 24h
//     replays the stored response verbatim, so a client retry is free.
//   • POST bulk endpoints: `Idempotency-Key` header dedupe. Same key + same payload replays; same
//     key + different payload is a 409 `idempotency_conflict`.
//
// Replays are served in preHandler (short-circuiting the handler); fresh responses are captured in
// onSend and persisted. On replay the billing flag is taken from the stored response — never re-run.

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiDeps, StoredResponse } from '../deps.ts';
import type { EndpointId, RouteConfig } from '../types.ts';
import { errors } from '../errors.ts';
import { HEADER } from '../headers.ts';

function routeConfig(request: FastifyRequest): Partial<RouteConfig> {
  return (request.routeOptions?.config ?? {}) as Partial<RouteConfig>;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** sha256 over `GET:endpoint:<sorted query>`. `api_key` is stripped so the key never enters the hash. */
export function computeGetRequestHash(endpoint: EndpointId, query: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'api_key') continue;
    filtered[k] = v;
  }
  return createHash('sha256').update(`GET:${endpoint}:${stableStringify(filtered)}`).digest('hex');
}

/** sha256 over `POST:endpoint:<canonical body>`. */
export function computePostRequestHash(endpoint: EndpointId, body: unknown): string {
  return createHash('sha256').update(`POST:${endpoint}:${stableStringify(body)}`).digest('hex');
}

interface IdemState {
  mode: 'get' | 'post';
  endpoint: EndpointId;
  requestHash: string;
  idempotencyKey: string;
  replayed: boolean;
}

const STATE = new WeakMap<FastifyRequest, IdemState>();

function sendStored(request: FastifyRequest, stored: StoredResponse, replyStatusSetter: (n: number) => void, send: (b: unknown) => void, setHeader: (n: string, v: string) => void): void {
  request.mmCtx.billing = { billed: stored.billed };
  if (stored.locationHeader !== undefined) setHeader(HEADER.location, stored.locationHeader);
  // Stored bodies are the serialized JSON payload; replay them verbatim as application/json.
  if (typeof stored.body === 'string') setHeader('content-type', 'application/json; charset=utf-8');
  replyStatusSetter(stored.httpStatus);
  send(stored.body);
}

export function getIdempotencyPlugin(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('preHandler', async (request, reply) => {
    const cfg = routeConfig(request);
    if (cfg.getIdempotent !== true) return;
    const ctx = request.mmCtx;
    if (ctx.principal === null || ctx.isSandbox) return;

    const endpoint = cfg.endpoint as EndpointId;
    const requestHash = computeGetRequestHash(endpoint, (request.query as Record<string, unknown>) ?? {});
    STATE.set(request, { mode: 'get', endpoint, requestHash, idempotencyKey: requestHash, replayed: false });

    const stored = await deps.idempotency.lookupGet(ctx.principal.tenantId, requestHash, endpoint);
    if (stored !== null) {
      const st = STATE.get(request);
      if (st) st.replayed = true;
      sendStored(
        request,
        stored,
        (n) => reply.status(n),
        (b) => reply.send(b),
        (n, v) => reply.header(n, v),
      );
      return reply; // short-circuit: skip rate-limit + handler
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const st = STATE.get(request);
    if (!st || st.mode !== 'get' || st.replayed) return payload;
    // Only a serialized JSON body is replayable; never cache a non-string payload.
    if (typeof payload !== 'string') return payload;
    const ctx = request.mmCtx;
    if (ctx.principal === null) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      const stored: StoredResponse = {
        httpStatus: reply.statusCode,
        body: payload,
        billed: ctx.billing?.billed ?? false,
      };
      await deps.idempotency.recordGet(ctx.principal.tenantId, st.requestHash, st.endpoint, stored).catch(() => {});
    }
    return payload;
  });
}

export function postIdempotencyPlugin(app: FastifyInstance, deps: ApiDeps): void {
  app.addHook('preHandler', async (request, reply) => {
    const cfg = routeConfig(request);
    if (cfg.postIdempotent !== true) return;
    const ctx = request.mmCtx;
    if (ctx.principal === null || ctx.isSandbox) return;

    const endpoint = cfg.endpoint as EndpointId;
    const requestHash = computePostRequestHash(endpoint, request.body);
    const headerKey = request.headers['idempotency-key'];
    const idempotencyKey = typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : requestHash;
    STATE.set(request, { mode: 'post', endpoint, requestHash, idempotencyKey, replayed: false });

    const outcome = await deps.idempotency.reservePost({
      tenantId: ctx.principal.tenantId,
      idempotencyKey,
      endpoint,
      requestHash,
    });

    if (outcome.kind === 'conflict') throw errors.idempotencyConflict();
    if (outcome.kind === 'replay') {
      const st = STATE.get(request);
      if (st) st.replayed = true;
      sendStored(
        request,
        outcome.stored,
        (n) => reply.status(n),
        (b) => reply.send(b),
        (n, v) => reply.header(n, v),
      );
      return reply; // short-circuit
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const st = STATE.get(request);
    if (!st || st.mode !== 'post' || st.replayed) return payload;
    // Only a serialized JSON body is replayable; never cache a non-string payload.
    if (typeof payload !== 'string') return payload;
    const ctx = request.mmCtx;
    if (ctx.principal === null) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 400) {
      const location = reply.getHeader(HEADER.location);
      const stored: StoredResponse = {
        httpStatus: reply.statusCode,
        body: payload,
        billed: ctx.billing?.billed ?? false,
        ...(typeof location === 'string' ? { locationHeader: location } : {}),
      };
      await deps.idempotency
        .finalizePost({ tenantId: ctx.principal.tenantId, idempotencyKey: st.idempotencyKey, endpoint: st.endpoint, stored })
        .catch(() => {});
    }
    return payload;
  });
}
