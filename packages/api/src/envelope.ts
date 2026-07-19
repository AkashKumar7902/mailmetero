// @mailmetero/api — success/error envelope builders (CONTRACTS_CORE §4.2).
//
// Success: `{ data, meta }`. Error: `{ errors: [{ id, code, details }] }` (Hunter-style, D18).
// `meta.request_id` is always present; bulk-results additionally carries pagination.

import { randomUUID } from 'node:crypto';
import type {
  RequestId,
  Meta,
  SuccessEnvelope,
  ErrorEnvelope,
  ApiError,
  ErrorCode,
} from '@mailmetero/contracts';

/** Build the response `meta`. Pagination fields are omitted (not set to undefined) when absent. */
export function makeMeta(requestId: RequestId, pagination?: { total: number; nextOffset: number | null }): Meta {
  const meta: Meta = { request_id: requestId };
  if (pagination !== undefined) {
    meta.total = pagination.total;
    meta.next_offset = pagination.nextOffset;
  }
  return meta;
}

export function successEnvelope<T>(data: T, meta: Meta): SuccessEnvelope<T> {
  return { data, meta };
}

export function errorEnvelope(errors: ApiError[]): ErrorEnvelope {
  return { errors };
}

/** One `ApiError`. `id` defaults to a fresh UUID so every error is reconstructible from logs. */
export function apiError(code: ErrorCode, details: string, id?: string): ApiError {
  return { id: id ?? randomUUID(), code, details };
}
