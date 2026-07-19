// @mailmetero/api — the sandbox router.
//
// Deterministically maps a `sk_test_…` request to a fixture outcome by matching the sentinel
// inputs (email for verifier; first/last/domain for finder). Returns null when no fixture matches
// so the route can fall back to a generic sandbox response. Never bills, never calls the pipeline.

import type { FastifyRequest } from 'fastify';
import type { EndpointId } from '../types.ts';
import { FIXTURES, type FixtureCase } from './fixtures.ts';

export interface SandboxRouter {
  resolve(endpoint: EndpointId, req: FastifyRequest): FixtureCase['outcome'] | null;
}

function q(req: FastifyRequest): Record<string, string> {
  const raw = (req.query as Record<string, unknown>) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function matches(fixture: FixtureCase, query: Record<string, string>): boolean {
  const m = fixture.match;
  if (m.email !== undefined && !eq(m.email, query['email'])) return false;
  if (m.domain !== undefined && !eq(m.domain, query['domain'])) return false;
  if (m.firstName !== undefined && !eq(m.firstName, query['first_name'])) return false;
  if (m.lastName !== undefined && !eq(m.lastName, query['last_name'])) return false;
  if (m.query !== undefined) {
    for (const [k, v] of Object.entries(m.query)) {
      if (!eq(v, query[k])) return false;
    }
  }
  return true;
}

export function createSandboxRouter(): SandboxRouter {
  return {
    resolve(endpoint, req) {
      const query = q(req);
      for (const fixture of FIXTURES) {
        if (fixture.endpoint !== endpoint) continue;
        if (matches(fixture, query)) return fixture.outcome;
      }
      return null;
    },
  };
}
