// @mailmetero/api — response validation against the OpenAPI document (CI response validation, P0-13).
//
// A compact, dependency-free JSON-schema checker (supply-chain minimalism: no ajv). It supports the
// subset the hand-written spec uses: type (incl. type-arrays and 'null'), enum, required, properties,
// items, minItems, oneOf, and $ref into components.schemas. Used by the route tests and CI to prove
// every emitted payload conforms to the served contract.

import { STATUSES, STATUS_SUBSTATUS } from '@mailmetero/contracts';
import type { Status, SubStatus } from '@mailmetero/contracts';
import { OPENAPI_DOCUMENT } from './spec.ts';
import type { EndpointId } from '../types.ts';

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minItems?: number;
  oneOf?: JsonSchema[];
  $ref?: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function componentSchemas(): Record<string, JsonSchema> {
  const components = (OPENAPI_DOCUMENT as { components?: { schemas?: Record<string, JsonSchema> } }).components;
  return components?.schemas ?? {};
}

function resolve(schema: JsonSchema): JsonSchema {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = componentSchemas()[name];
    if (target) return target;
  }
  return schema;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

function validate(schemaRaw: JsonSchema, value: unknown, path: string, errors: string[]): void {
  const schema = resolve(schemaRaw);

  if (schema.oneOf) {
    const ok = schema.oneOf.some((sub) => {
      const local: string[] = [];
      validate(sub, value, path, local);
      return local.length === 0;
    });
    if (!ok) errors.push(`${path}: did not match any oneOf variant`);
    return;
  }

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    if (!expected.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${expected.join('|')}, got ${actual}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
    return;
  }

  const actual = typeOf(value);
  if (actual === 'object' && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}.${req}: required property missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) validate(sub, obj[key], `${path}.${key}`, errors);
    }
  }

  if (actual === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: expected at least ${schema.minItems} items, got ${value.length}`);
    }
    if (schema.items) value.forEach((item, i) => validate(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
  }
}

function findResponseSchema(operationId: EndpointId, httpStatus: number): JsonSchema | null | undefined {
  const paths = (OPENAPI_DOCUMENT as { paths?: Record<string, Record<string, unknown>> }).paths ?? {};
  for (const methods of Object.values(paths)) {
    for (const method of HTTP_METHODS) {
      const op = methods[method] as { operationId?: string; responses?: Record<string, unknown> } | undefined;
      if (op?.operationId !== operationId) continue;
      const responses = op.responses ?? {};
      const resp = (responses[String(httpStatus)] ?? responses['default']) as
        | { content?: { 'application/json'?: { schema?: JsonSchema } } }
        | undefined;
      if (resp === undefined) return null; // no response documented for this status
      return resp.content?.['application/json']?.schema; // undefined = no body schema (e.g. 204)
    }
  }
  return null;
}

/**
 * Cross-check that every `{ status, sub_status }` pair carried in the payload is LEGAL per the
 * frozen STATUS_SUBSTATUS map (m4). The JSON-schema layer validates the Status and SubStatus enums
 * INDEPENDENTLY, so an illegal pair (e.g. `valid` + `timeout`, or `role` + a non-null sub_status)
 * would otherwise pass validation and reach the wire, contradicting the enum's own "Enforced in
 * response validation" contract. Walks the payload recursively so nested results are covered too.
 */
function assertStatusSubStatusPairs(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertStatusSubStatusPairs(item, `${path}[${i}]`, errors));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  const status = obj['status'];
  const subStatus = obj['sub_status'];
  if (typeof status === 'string' && (STATUSES as readonly string[]).includes(status) && typeof subStatus === 'string') {
    const legal = STATUS_SUBSTATUS[status as Status] as readonly SubStatus[];
    if (!legal.includes(subStatus as SubStatus)) {
      errors.push(`${path}.sub_status: "${subStatus}" is not a legal sub_status under status "${status}"`);
    }
  }
  for (const [key, sub] of Object.entries(obj)) {
    assertStatusSubStatusPairs(sub, `${path}.${key}`, errors);
  }
}

/**
 * Validate `payload` against the response schema the OpenAPI document declares for
 * (operationId, httpStatus). Bodies with no declared schema (204, raw spec/health) pass the schema
 * layer but still have any status/sub_status pairs checked for legality.
 */
export function validateResponseAgainstSpec(
  operationId: EndpointId,
  httpStatus: number,
  payload: unknown,
): { valid: boolean; errors: string[] } {
  const schema = findResponseSchema(operationId, httpStatus);
  if (schema === null) {
    return { valid: false, errors: [`no response documented for ${operationId} ${httpStatus}`] };
  }
  const errors: string[] = [];
  if (schema !== undefined) validate(schema, payload, '$', errors); // no body schema declared → skip schema layer
  assertStatusSubStatusPairs(payload, '$', errors);
  return { valid: errors.length === 0, errors };
}
