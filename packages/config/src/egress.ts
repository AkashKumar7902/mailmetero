// @mailmetero/config — the code-level egress allowlist (P0-11, §7.6, D-non-goal LinkedIn).
// THE single outbound-network choke point. Every package that talks to the network
// (dns, verifier, email) imports `egressFetch` from here; the eslint rule in
// eslint.config.js forbids raw fetch / node:http(s) / undici everywhere else, so this
// is mechanically the only door out. Hosts not derived from configured endpoints are
// blocked; cross-host redirects are re-validated; the check is CI-audited by
// tools/ci/check-egress-allowlist.test.ts.

import type { Env } from './env.ts';
import type { Logger } from './logger.ts';

/** Immutable set of hostnames this process may reach. Built once at boot from Env. */
export interface EgressPolicy {
  readonly allowedHosts: ReadonlySet<string>;
}

export class EgressBlockedError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`egress blocked: ${host} is not on the allowlist`);
    this.name = 'EgressBlockedError';
    this.host = host;
  }
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/**
 * Hard denylist. mailmetero performs NO scraping (D-non-goal): LinkedIn and code hosts
 * are never legitimate egress destinations. These are refused even if an operator
 * mistakenly lists them in EGRESS_EXTRA_HOSTS — defense-in-depth over the allowlist,
 * asserted by tools/ci/check-egress-allowlist.test.ts.
 */
const FORBIDDEN_EGRESS_SUFFIXES: readonly string[] = [
  'linkedin.com',
  'licdn.com',
  'github.com',
  'githubusercontent.com',
  'github.io',
];

function isForbiddenHost(host: string): boolean {
  return FORBIDDEN_EGRESS_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/**
 * Derive the allowlist from configured endpoints ONLY (plus the ops escape hatch).
 * There is deliberately no wildcard: adding a destination means changing config,
 * which is what the per-release egress audit inspects. Forbidden hosts (LinkedIn/github)
 * are dropped from the extras before the set is frozen.
 */
export function buildEgressPolicy(env: Env): EgressPolicy {
  const hosts = new Set<string>();
  // DoH resolvers (DNS stage)
  hosts.add(hostOf(env.dohPrimaryUrl));
  hosts.add(hostOf(env.dohFallbackUrl));
  // verifier vendor (paid verify)
  hosts.add(hostOf(env.verifierApiBaseUrl));
  // ESP (signup/objection/quota mail)
  hosts.add(hostOf(env.espApiBaseUrl));
  // ops-controlled extras (empty in prod) — forbidden destinations are never admitted
  for (const h of env.egressExtraHosts) {
    if (!isForbiddenHost(h)) hosts.add(h);
  }
  return Object.freeze({ allowedHosts: Object.freeze(hosts) as ReadonlySet<string> });
}

export type EgressFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build the allowlist-enforcing fetch. Semantics:
 *  - target host must be in policy.allowedHosts, else EgressBlockedError (never a network call)
 *  - redirects are followed manually and each hop re-checked against the allowlist
 *    (blocks an allowed host 302-ing to an arbitrary destination / SSRF via redirect)
 *  - blocked attempts are logged at warn (host only; never the full URL, which may carry api_key=)
 */
export function createEgressFetch(policy: EgressPolicy, logger: Logger): EgressFetch {
  const assertAllowed = (url: string): void => {
    const host = hostOf(url);
    if (isForbiddenHost(host) || !policy.allowedHosts.has(host)) {
      logger.warn({ event: 'egress_blocked', host }, 'outbound request blocked by allowlist');
      throw new EgressBlockedError(host);
    }
  };

  const MAX_REDIRECTS = 5;

  return async function egressFetch(input, init) {
    let url = typeof input === 'string' ? input : input.toString();
    let req: RequestInit = { ...init, redirect: 'manual' };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertAllowed(url);
      const res = await fetch(url, req);
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        const next = new URL(res.headers.get('location')!, url).toString();
        // re-validate the redirect target BEFORE following it
        assertAllowed(next);
        url = next;
        // per fetch spec, 303 (and 301/302 for non-GET in practice) drop the body/method to GET
        if (res.status === 303) {
          const { body: _body, ...rest } = req;
          req = { ...rest, method: 'GET' };
        }
        continue;
      }
      return res;
    }
    throw new Error('egress: too many redirects');
  };
}
