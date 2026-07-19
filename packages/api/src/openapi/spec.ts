// @mailmetero/api — the hand-written OpenAPI 3.1 document (the contract source of truth, P0-13/D16).
//
// Every enum is generated from the frozen `@mailmetero/contracts` const-arrays via `enumSchema`, so
// the spec, runtime validation, and the wire types cannot drift. Served verbatim at
// /v2/openapi.json and consumed by `validateResponseAgainstSpec` for CI response validation.

import {
  STATUSES,
  SUB_STATUSES,
  REASON_CODES,
  PROVIDERS,
  BACKENDS,
  EVIDENCE_TIERS,
  ERROR_CODES,
  SOURCE_TAGS,
  JOB_STATUSES,
} from '@mailmetero/contracts';
import { enumSchema } from '../schemas/enums.ts';

const OPENAPI_VERSION = '1.0.0';

// Upper bound the served spec advertises for a bulk POST body (mirrors the default BULK_MAX_ROWS;
// the handler enforces the live, DB-tunable cap and 413s past it).
const BULK_MAX_ROWS = 1000;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ oneOf: [schema, { type: 'null' }] });
const jsonBody = (schema: object) => ({ content: { 'application/json': { schema } } });
const okResponse = (schema: object, description = 'Success') => ({ description, ...jsonBody(schema) });
const errorResponse = (description: string) => ({ description, ...jsonBody(ref('ErrorEnvelope')) });

const META = {
  type: 'object',
  required: ['request_id'],
  properties: {
    request_id: { type: 'string' },
    total: { type: 'integer' },
    next_offset: { type: ['integer', 'null'] },
  },
} as const;

function successEnvelopeSchema(dataSchema: object): object {
  return {
    type: 'object',
    required: ['data', 'meta'],
    properties: { data: dataSchema, meta: ref('Meta') },
  };
}

const COMPONENTS_SCHEMAS: Record<string, object> = {
  Status: enumSchema(STATUSES),
  SubStatus: enumSchema(SUB_STATUSES),
  ReasonCode: enumSchema(REASON_CODES),
  Provider: enumSchema(PROVIDERS),
  Backend: enumSchema(BACKENDS),
  EvidenceTier: enumSchema(EVIDENCE_TIERS),
  ErrorCode: enumSchema(ERROR_CODES),
  JobStatus: enumSchema(JOB_STATUSES),

  ApiError: {
    type: 'object',
    required: ['id', 'code', 'details'],
    properties: { id: { type: 'string' }, code: ref('ErrorCode'), details: { type: 'string' } },
  },
  ErrorEnvelope: {
    type: 'object',
    required: ['errors'],
    properties: { errors: { type: 'array', items: ref('ApiError') } },
  },
  Meta: META,

  WireCandidate: {
    type: 'object',
    required: ['email', 'score', 'reason_codes'],
    properties: {
      email: { type: 'string' },
      score: { type: 'integer' },
      reason_codes: { type: 'array', items: ref('ReasonCode') },
    },
  },
  VerificationSummary: {
    type: 'object',
    required: ['status', 'date'],
    properties: { status: ref('Status'), date: { type: ['string', 'null'] } },
  },
  FinderResult: {
    type: 'object',
    required: [
      'email', 'score', 'status', 'domain', 'first_name', 'last_name', 'sources', 'verification',
      'sub_status', 'reason_codes', 'provider', 'backend', 'evidence', 'collision_risk', 'candidates',
      'verified_at', 'stale',
    ],
    properties: {
      email: { type: ['string', 'null'] },
      score: { type: 'integer' },
      status: ref('Status'),
      domain: { type: 'string' },
      first_name: { type: ['string', 'null'] },
      last_name: { type: ['string', 'null'] },
      sources: { type: 'array', items: enumSchema(SOURCE_TAGS) },
      verification: ref('VerificationSummary'),
      sub_status: nullable(ref('SubStatus')),
      reason_codes: { type: 'array', minItems: 1, items: ref('ReasonCode') },
      provider: nullable(ref('Provider')),
      backend: ref('Backend'),
      evidence: ref('EvidenceTier'),
      collision_risk: { type: 'boolean' },
      candidates: { type: 'array', items: ref('WireCandidate') },
      verified_at: { type: ['string', 'null'] },
      stale: { type: 'boolean' },
    },
  },
  VerifierResult: {
    type: 'object',
    required: [
      'email', 'status', 'score', 'accept_all', 'disposable', 'webmail', 'mx_records', 'smtp_check',
      'sub_status', 'reason_codes', 'provider', 'backend', 'evidence', 'raw_smtp_code', 'verified_at',
    ],
    properties: {
      email: { type: 'string' },
      status: ref('Status'),
      score: { type: 'integer' },
      accept_all: { type: 'boolean' },
      disposable: { type: 'boolean' },
      webmail: { type: 'boolean' },
      mx_records: { type: 'boolean' },
      smtp_check: { type: 'boolean' },
      sub_status: nullable(ref('SubStatus')),
      reason_codes: { type: 'array', minItems: 1, items: ref('ReasonCode') },
      provider: nullable(ref('Provider')),
      backend: ref('Backend'),
      evidence: ref('EvidenceTier'),
      raw_smtp_code: { type: ['string', 'null'] },
      verified_at: { type: ['string', 'null'] },
    },
  },
  AsyncAccepted: {
    type: 'object',
    required: ['job_id', 'status'],
    properties: { job_id: { type: 'string' }, status: ref('JobStatus') },
  },
  BulkAccepted: {
    type: 'object',
    required: ['job_id', 'status', 'count'],
    properties: { job_id: { type: 'string' }, status: ref('JobStatus'), count: { type: 'integer' } },
  },
  BulkJobStatus: {
    type: 'object',
    required: ['status', 'total', 'done', 'failed', 'created_at', 'finished_at'],
    properties: {
      status: ref('JobStatus'),
      total: { type: 'integer' },
      done: { type: 'integer' },
      failed: { type: 'integer' },
      created_at: { type: 'string' },
      finished_at: { type: ['string', 'null'] },
    },
  },
  AccountInfo: {
    type: 'object',
    required: ['email', 'plan_name', 'requests', 'reset_date'],
    properties: {
      email: { type: 'string' },
      plan_name: { type: 'string' },
      requests: {
        type: 'object',
        required: ['searches', 'verifications'],
        properties: {
          searches: { type: 'object', required: ['used', 'available'], properties: { used: { type: 'integer' }, available: { type: 'integer' } } },
          verifications: { type: 'object', required: ['used', 'available'], properties: { used: { type: 'integer' }, available: { type: 'integer' } } },
        },
      },
      reset_date: { type: 'string' },
    },
  },
  UsageInfo: {
    type: 'object',
    required: ['credits_used', 'credits_remaining', 'attempts', 'billable', 'credit_backs', 'by_day'],
    properties: {
      credits_used: { type: 'integer' },
      credits_remaining: { type: 'integer' },
      attempts: { type: 'integer' },
      billable: { type: 'integer' },
      credit_backs: { type: 'integer' },
      by_day: { type: 'array', items: { type: 'object' } },
    },
  },
  MessageAck: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
};

const strParam = (name: string, where: 'query' | 'path', required: boolean) => ({
  name,
  in: where,
  required,
  schema: { type: 'string' },
});

const intParam = (name: string, where: 'query' | 'path', required: boolean, schema: object) => ({
  name,
  in: where,
  required,
  schema,
});

const jsonRequestBody = (schema: object) => ({
  required: true,
  content: { 'application/json': { schema } },
});

const bulkFindsRequestBody = jsonRequestBody({
  type: 'array',
  maxItems: BULK_MAX_ROWS,
  items: {
    type: 'object',
    required: ['first_name', 'last_name', 'domain'],
    properties: {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      domain: { type: 'string' },
      middle_name: { type: 'string' },
      full_name: { type: 'string' },
    },
  },
});

const bulkVerificationsRequestBody = jsonRequestBody({
  type: 'array',
  maxItems: BULK_MAX_ROWS,
  items: { type: 'string' },
});

const OPENAPI_PATHS: Record<string, unknown> = {
  '/v2/email-finder': {
    get: {
      operationId: 'email_finder',
      summary: 'Derive + verify the most likely address for a person at a domain',
      parameters: [
        strParam('domain', 'query', true),
        strParam('first_name', 'query', false),
        strParam('last_name', 'query', false),
        strParam('full_name', 'query', false),
        strParam('middle_name', 'query', false),
        strParam('company', 'query', false),
        strParam('linkedin_url', 'query', false),
        intParam('max_duration', 'query', false, { type: 'integer', minimum: 100, maximum: 30000 }),
      ],
      responses: {
        '200': okResponse(successEnvelopeSchema(ref('FinderResult'))),
        default: errorResponse('Error'),
      },
    },
  },
  '/v2/email-verifier': {
    get: {
      operationId: 'email_verifier',
      summary: 'Verify a single address (sync fast-path, else 202 async)',
      parameters: [strParam('email', 'query', true)],
      responses: {
        '200': okResponse(successEnvelopeSchema(ref('VerifierResult'))),
        '202': okResponse(successEnvelopeSchema(ref('AsyncAccepted')), 'Accepted (async verification)'),
        default: errorResponse('Error'),
      },
    },
  },
  '/v2/verifications/{id}': {
    get: {
      operationId: 'verifications_get',
      summary: 'Poll an async verification',
      parameters: [strParam('id', 'path', true)],
      responses: {
        '200': okResponse(successEnvelopeSchema(ref('VerifierResult'))),
        '202': errorResponse('Job pending'),
        default: errorResponse('Error'),
      },
    },
  },
  '/v2/bulk/finds': {
    post: {
      operationId: 'bulk_finds',
      summary: 'Bulk find (async job)',
      requestBody: bulkFindsRequestBody,
      responses: { '202': okResponse(successEnvelopeSchema(ref('BulkAccepted')), 'Accepted'), default: errorResponse('Error') },
    },
  },
  '/v2/bulk/verifications': {
    post: {
      operationId: 'bulk_verifications',
      summary: 'Bulk verify (async job)',
      requestBody: bulkVerificationsRequestBody,
      responses: { '202': okResponse(successEnvelopeSchema(ref('BulkAccepted')), 'Accepted'), default: errorResponse('Error') },
    },
  },
  '/v2/bulk/{job_id}': {
    get: {
      operationId: 'bulk_status',
      summary: 'Job status',
      parameters: [strParam('job_id', 'path', true)],
      responses: { '200': okResponse(successEnvelopeSchema(ref('BulkJobStatus'))), default: errorResponse('Error') },
    },
  },
  '/v2/bulk/{job_id}/results': {
    get: {
      operationId: 'bulk_results',
      summary: 'Paginated per-row results',
      parameters: [strParam('job_id', 'path', true), strParam('limit', 'query', false), strParam('offset', 'query', false)],
      responses: { '200': okResponse(successEnvelopeSchema({ type: 'array', items: { type: 'object' } })), default: errorResponse('Error') },
    },
  },
  '/v2/account': {
    get: { operationId: 'account', summary: 'Account/plan info', responses: { '200': okResponse(successEnvelopeSchema(ref('AccountInfo'))), default: errorResponse('Error') } },
  },
  '/v2/usage': {
    get: { operationId: 'usage', summary: 'Live metering detail', responses: { '200': okResponse(successEnvelopeSchema(ref('UsageInfo'))), default: errorResponse('Error') } },
  },
  '/v2/signup': {
    post: { operationId: 'signup', summary: 'Public self-serve signup', responses: { '202': okResponse(successEnvelopeSchema(ref('MessageAck')), 'Accepted'), default: errorResponse('Error') } },
  },
  '/v2/objections': {
    post: { operationId: 'objections', summary: 'Public objection/erasure intake', responses: { '202': okResponse(successEnvelopeSchema(ref('MessageAck')), 'Accepted'), default: errorResponse('Error') } },
  },
  '/v2/objections/confirm': {
    get: {
      operationId: 'objections_confirm',
      summary: 'Confirm an emailed objection token (writes global suppression)',
      parameters: [strParam('token', 'query', true)],
      responses: { '200': okResponse(successEnvelopeSchema(ref('MessageAck'))), default: errorResponse('Error') },
    },
  },
  '/v2/data-subjects/export': {
    get: { operationId: 'data_subjects_export', summary: 'Tenant DSAR export', parameters: [strParam('email', 'query', true)], responses: { '200': okResponse(successEnvelopeSchema({ type: 'array', items: { type: 'object' } })), default: errorResponse('Error') } },
  },
  '/v2/data-subjects': {
    delete: { operationId: 'data_subjects_delete', summary: 'Tenant DSAR delete', parameters: [strParam('email', 'query', true)], responses: { '204': { description: 'Deleted' }, default: errorResponse('Error') } },
  },
  '/v2/openapi.json': {
    get: { operationId: 'openapi', summary: 'The OpenAPI 3.1 contract', responses: { '200': { description: 'Spec document' } } },
  },
  '/healthz': {
    get: { operationId: 'healthz', summary: 'Health check', responses: { '200': { description: 'Healthy' }, '503': { description: 'Degraded' } } },
  },
};

export const OPENAPI_DOCUMENT: Readonly<Record<string, unknown>> = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'mailmetero API',
    version: OPENAPI_VERSION,
    description: 'Hosted email finder + verifier. Hunter-mirror /v2 surface with additive-only native fields.',
  },
  servers: [{ url: '/' }],
  paths: OPENAPI_PATHS,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: COMPONENTS_SCHEMAS,
  },
  security: [{ bearerAuth: [] }],
});
