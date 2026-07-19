// @mailmetero/api — shared JSON schemas (enum-driven) + registration.
//
// These are the reusable building blocks (status/enum fragments + the error envelope) generated
// from the frozen registries. `registerSchemas` adds them to a Fastify instance under stable $ids
// so route schemas and the OpenAPI document can $ref them.

import type { FastifyInstance } from 'fastify';
import {
  STATUSES,
  SUB_STATUSES,
  REASON_CODES,
  PROVIDERS,
  BACKENDS,
  EVIDENCE_TIERS,
  ERROR_CODES,
} from '@mailmetero/contracts';
import { enumSchema } from './enums.ts';

/** Reusable schema fragments keyed by their $id. */
export const SHARED_SCHEMAS: Record<string, object> = {
  'mm.status': { $id: 'mm.status', ...enumSchema(STATUSES) },
  'mm.subStatus': { $id: 'mm.subStatus', ...enumSchema(SUB_STATUSES) },
  'mm.reasonCode': { $id: 'mm.reasonCode', ...enumSchema(REASON_CODES) },
  'mm.provider': { $id: 'mm.provider', ...enumSchema(PROVIDERS) },
  'mm.backend': { $id: 'mm.backend', ...enumSchema(BACKENDS) },
  'mm.evidence': { $id: 'mm.evidence', ...enumSchema(EVIDENCE_TIERS) },
  'mm.errorCode': { $id: 'mm.errorCode', ...enumSchema(ERROR_CODES) },
  'mm.apiError': {
    $id: 'mm.apiError',
    type: 'object',
    required: ['id', 'code', 'details'],
    properties: {
      id: { type: 'string' },
      code: enumSchema(ERROR_CODES),
      details: { type: 'string' },
    },
  },
  'mm.errorEnvelope': {
    $id: 'mm.errorEnvelope',
    type: 'object',
    required: ['errors'],
    properties: {
      errors: { type: 'array', items: { $ref: 'mm.apiError#' } },
    },
  },
};

/** Register every shared schema on the instance (idempotent per instance). */
export function registerSchemas(app: FastifyInstance): void {
  for (const schema of Object.values(SHARED_SCHEMAS)) {
    app.addSchema(schema);
  }
}
