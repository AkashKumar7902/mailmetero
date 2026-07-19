// @mailmetero/api — per-route Fastify schemas (request validation).
//
// Request querystring/params/body validation only. Response shapes are validated in CI by
// `validateResponseAgainstSpec` against the hand-written OpenAPI document, and are intentionally
// NOT attached as serializer schemas here (so no additive-only wire field is ever silently
// dropped by fast-json-stringify).

/** GET /v2/email-finder — domain required in v1; name via first/last or full_name. */
export const finderQuerySchema = {
  type: 'object',
  properties: {
    domain: { type: 'string' },
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    full_name: { type: 'string' },
    middle_name: { type: 'string' },
    company: { type: 'string' },
    linkedin_url: { type: 'string' },
    max_duration: { type: 'integer', minimum: 100, maximum: 30000 },
    api_key: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** GET /v2/email-verifier — a single email. */
export const verifierQuerySchema = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', minLength: 1 },
    api_key: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** GET /v2/verifications/{id}. */
export const verificationsParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
  additionalProperties: false,
} as const;

/** POST /v2/bulk/finds — array of {first_name,last_name,domain}, ≤ bulkMaxRows (checked in handler). */
export const bulkFindsBodySchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['first_name', 'last_name', 'domain'],
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      domain: { type: 'string' },
    },
    additionalProperties: true,
  },
} as const;

/** POST /v2/bulk/verifications — array of emails. */
export const bulkVerificationsBodySchema = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
} as const;

export const bulkJobParamsSchema = {
  type: 'object',
  required: ['job_id'],
  properties: { job_id: { type: 'string', minLength: 1 } },
  additionalProperties: false,
} as const;

export const bulkResultsQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    offset: { type: 'integer', minimum: 0 },
    api_key: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const usageQuerySchema = {
  type: 'object',
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    api_key: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const accountQuerySchema = {
  type: 'object',
  properties: { api_key: { type: 'string' } },
  additionalProperties: false,
} as const;

export const signupBodySchema = {
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string', minLength: 3 } },
  additionalProperties: false,
} as const;

export const objectionsBodySchema = {
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string', minLength: 3 } },
  additionalProperties: false,
} as const;

/** GET /v2/objections/confirm — the emailed opt-out token (base64url). */
export const objectionConfirmQuerySchema = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1 } },
  additionalProperties: false,
} as const;

export const dsarQuerySchema = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', minLength: 3 },
    api_key: { type: 'string' },
  },
  additionalProperties: false,
} as const;
