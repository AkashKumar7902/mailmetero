// @mailmetero/api — the frozen ErrorCode → HTTP-status mapping, the ApiException carrier, and the
// Fastify error/not-found handlers. This is the ONLY place a status code is attached to an error
// code; routes throw `ApiException`s built by the factory helpers below.

import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';
import type { ErrorCode, ErrorEnvelope } from '@mailmetero/contracts';
import { ERROR_CODES } from '@mailmetero/contracts';
import { apiError, errorEnvelope } from './envelope.ts';
import { HEADER } from './headers.ts';

/**
 * Frozen, exhaustive ErrorCode → HTTP status. Changing an entry is a spec change (bumps the
 * OpenAPI version). `job_pending` maps to 202 (consumers poll); the rest follow PRD §3 / D18.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  invalid_api_key: 401,
  insufficient_credits: 402,
  rate_limited: 429,
  invalid_domain: 400,
  domain_required: 400,
  verification_unavailable: 503,
  job_pending: 202,
  idempotency_conflict: 409,
  payload_too_large: 413,
  invalid_email: 400,
  validation_error: 400,
  not_found: 404,
  signup_disposable_blocked: 400,
  service_unavailable: 503,
  internal_error: 500,
});

// Compile-time exhaustiveness: every frozen ErrorCode has a status above.
const _EXHAUSTIVE: Record<(typeof ERROR_CODES)[number], number> = ERROR_HTTP_STATUS;
void _EXHAUSTIVE;

export interface ApiExceptionOptions {
  id?: string;
  retryAfterSeconds?: number;
  locationHeader?: string;
}

/** A domain error that already knows its wire code, HTTP status, and conditional headers. */
export class ApiException extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: string;
  readonly id: string;
  readonly retryAfterSeconds?: number;
  readonly locationHeader?: string;

  constructor(code: ErrorCode, details: string, opts: ApiExceptionOptions = {}) {
    super(details);
    this.name = 'ApiException';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.details = details;
    this.id = opts.id ?? apiError(code, details).id;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.locationHeader !== undefined) this.locationHeader = opts.locationHeader;
  }

  toEnvelope(): ErrorEnvelope {
    return errorEnvelope([apiError(this.code, this.details, this.id)]);
  }
}

// ── factory helpers (routes/plugins throw these) ─────────────────────────────
export const errors = {
  invalidApiKey: (details = 'Invalid or missing API key') => new ApiException('invalid_api_key', details),
  insufficientCredits: (details = 'Insufficient credits') => new ApiException('insufficient_credits', details),
  rateLimited: (retryAfterSeconds: number, details = 'Rate limit exceeded') =>
    new ApiException('rate_limited', details, { retryAfterSeconds }),
  invalidDomain: (details = 'Invalid domain') => new ApiException('invalid_domain', details),
  domainRequired: (details = 'A domain is required in v1') => new ApiException('domain_required', details),
  verificationUnavailable: (details = 'Verification is temporarily unavailable') =>
    new ApiException('verification_unavailable', details),
  jobPending: (locationOrRetry: { retryAfterSeconds: number; location?: string }, details = 'Job pending') =>
    new ApiException('job_pending', details, {
      retryAfterSeconds: locationOrRetry.retryAfterSeconds,
      ...(locationOrRetry.location !== undefined ? { locationHeader: locationOrRetry.location } : {}),
    }),
  idempotencyConflict: (details = 'Idempotency-Key already used with a different payload') =>
    new ApiException('idempotency_conflict', details),
  payloadTooLarge: (details = 'Payload exceeds the maximum allowed size') =>
    new ApiException('payload_too_large', details),
  invalidEmail: (details = 'Invalid email address') => new ApiException('invalid_email', details),
  validationError: (details = 'Invalid or missing parameter') => new ApiException('validation_error', details),
  notFound: (details = 'Not found') => new ApiException('not_found', details),
  signupDisposableBlocked: (details = 'Signup from disposable domains is not allowed') =>
    new ApiException('signup_disposable_blocked', details),
  serviceUnavailable: (details = 'Service temporarily unavailable') =>
    new ApiException('service_unavailable', details),
  internalError: (details = 'Internal error') => new ApiException('internal_error', details),
} as const;

/** Attach conditional headers (Retry-After, Location) an ApiException carries. */
function applyConditionalHeaders(reply: FastifyReply, exc: ApiException): void {
  if (exc.retryAfterSeconds !== undefined) reply.header(HEADER.retryAfter, String(exc.retryAfterSeconds));
  if (exc.locationHeader !== undefined) reply.header(HEADER.location, exc.locationHeader);
}

/**
 * The single Fastify error handler. ApiExceptions serialize to their frozen status + envelope.
 * Fastify schema-validation failures become `validation_error` (400). Everything else is an
 * `internal_error` (500) — the message is never leaked to the client. onSend still runs, so the
 * standard headers are applied on top of whatever this sets.
 */
export function errorHandler(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
  let exc: ApiException;
  if (error instanceof ApiException) {
    exc = error;
  } else if (isFastifyValidation(error)) {
    exc = errors.validationError(String((error as { message?: unknown }).message ?? 'Validation failed'));
  } else {
    request.log?.error?.({ err: error }, 'unhandled route error');
    exc = errors.internalError();
  }
  applyConditionalHeaders(reply, exc);
  reply.status(exc.httpStatus).send(exc.toEnvelope());
}

/** 404 for any unmatched route. */
export function notFoundHandler(_request: FastifyRequest, reply: FastifyReply): void {
  const exc = errors.notFound('Unknown route');
  reply.status(exc.httpStatus).send(exc.toEnvelope());
}

function isFastifyValidation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    Array.isArray((error as { validation?: unknown }).validation)
  );
}

/** Wire both handlers onto an instance (called from buildServer). */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
}
