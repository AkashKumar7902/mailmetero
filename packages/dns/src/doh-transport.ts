// @mailmetero/dns — DoH transport (MODULE_CONTRACTS §3).
//
// Thin, injectable JSON-DoH client. It does NOT own retry/fallback policy (that is the
// resolver's job) and does NOT own the network door: every request goes through the
// injected `EgressFetch` from @mailmetero/config, which is the single audited egress
// choke point (P0-11). The `allowlist` here is a defense-in-depth pre-check so a
// mis-mapped endpoint host fails fast before a socket is opened.

import type { EgressFetch } from '@mailmetero/config';
import type { DnsRecordType, DohAnswer, DohEndpointId, DohResponse } from './types.ts';

/** Endpoint id → JSON-DoH GET URL. Hosts must be present in the egress allowlist. */
const DOH_ENDPOINT_URL: Readonly<Record<DohEndpointId, string>> = {
  google: 'https://dns.google/resolve',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
} as const;

export interface DohTransport {
  query(
    endpoint: DohEndpointId,
    name: string,
    type: DnsRecordType,
    signal?: AbortSignal,
  ): Promise<DohResponse>;
}

/** Raised when a DoH endpoint's host is not on the egress allowlist. Caught by the resolver. */
export class DohEndpointNotAllowedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`doh endpoint host not on egress allowlist: ${host}`);
    this.name = 'DohEndpointNotAllowedError';
    this.host = host;
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function isDohResponse(value: unknown): value is DohResponse {
  return typeof value === 'object' && value !== null && typeof (value as { Status: unknown }).Status === 'number';
}

function coerceAnswers(raw: unknown): DohAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: DohAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec['name'] === 'string' && typeof rec['type'] === 'number' && typeof rec['data'] === 'string') {
      out.push({
        name: rec['name'],
        type: rec['type'],
        TTL: typeof rec['TTL'] === 'number' ? rec['TTL'] : 0,
        data: rec['data'],
      });
    }
  }
  return out;
}

/**
 * Build a DohTransport over the injected egressFetch. `allowlist` is the set of hostnames
 * the transport may reach (typically the EgressPolicy hosts); an endpoint mapped to a host
 * outside it throws `DohEndpointNotAllowedError` rather than attempting the call.
 */
export function createFetchDohTransport(deps: { fetch: EgressFetch; allowlist: readonly string[] }): DohTransport {
  const allowed = new Set(deps.allowlist.map((h) => h.toLowerCase()));

  return {
    async query(endpoint, name, type, signal): Promise<DohResponse> {
      const base = DOH_ENDPOINT_URL[endpoint];
      const host = hostOf(base);
      if (!allowed.has(host)) {
        throw new DohEndpointNotAllowedError(host);
      }

      const url = new URL(base);
      url.searchParams.set('name', name);
      url.searchParams.set('type', type);

      const init: RequestInit = {
        method: 'GET',
        headers: { accept: 'application/dns-json' },
        redirect: 'follow',
      };
      if (signal) init.signal = signal;

      const res = await deps.fetch(url, init);
      if (!res.ok) {
        throw new Error(`doh ${endpoint} http ${res.status}`);
      }
      const body: unknown = await res.json();
      if (!isDohResponse(body)) {
        throw new Error(`doh ${endpoint} malformed response`);
      }

      const answers = coerceAnswers((body as { Answer?: unknown }).Answer);
      return answers.length > 0
        ? { Status: body.Status, Answer: answers }
        : { Status: body.Status };
    },
  };
}
