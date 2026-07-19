// CI invariant (P0-11, §7.6): outbound network is centralized. Zero raw HTTP clients
// outside @mailmetero/config; the only door out is egressFetch. Backstops the eslint
// rule so the audit passes even if lint is skipped. Also asserts the derived allowlist
// contains ONLY configured hosts (no wildcard, no LinkedIn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildEgressPolicy } from '@mailmetero/config';
import type { Env } from '@mailmetero/config';

const PKGS = join(process.cwd(), 'packages');

// Raw HTTP-client imports are NEVER allowed outside @mailmetero/config — there is no
// legitimate reason for any other package to pull node:http(s)/undici/axios/got/node-fetch.
const RAW_CLIENT = /\bfrom\s+['"](?:node:)?https?['"]|\bfrom\s+['"](?:undici|axios|got|node-fetch)['"]|\brequire\(\s*['"](?:node:)?https?['"]\s*\)/;
// A `fetch(` call site. In the design the ONLY sanctioned fetch caller outside config is a
// module that receives an injected `EgressFetch` (from @mailmetero/config) and calls it —
// the name `fetch` is deliberately shadowed by that injected parameter. So a `fetch(` in a
// file that does NOT wire in EgressFetch means someone reached for the global fetch directly.
const FETCH_CALL = /(?<![.\w$])fetch\s*\(/;
// Marker that a file goes out through the audited door: it references the EgressFetch type
// and imports it from the config choke point.
const USES_INJECTED_EGRESS = (body: string): boolean =>
  /\bEgressFetch\b/.test(body) && /['"]@mailmetero\/config['"]/.test(body);

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') yield* tsFiles(p); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p;
  }
}

test('no raw network APIs outside @mailmetero/config', async () => {
  const offenders: string[] = [];
  for await (const file of tsFiles(PKGS)) {
    if (file.includes('/config/src/')) continue; // the sanctioned choke point
    if (/\.(test|integration\.test)\.ts$/.test(file)) continue;
    const body = await readFile(file, 'utf8');
    if (RAW_CLIENT.test(body)) {
      offenders.push(`${file} (raw HTTP client import)`);
      continue;
    }
    // A global fetch call is only allowed via an injected EgressFetch.
    if (FETCH_CALL.test(body) && !USES_INJECTED_EGRESS(body)) {
      offenders.push(`${file} (global fetch outside injected EgressFetch)`);
    }
  }
  assert.deepEqual(offenders, [], `raw egress outside config:\n${offenders.join('\n')}`);
});

test('derived allowlist contains only configured hosts', () => {
  const env = {
    dohPrimaryUrl: 'https://dns.google/resolve',
    dohFallbackUrl: 'https://cloudflare-dns.com/dns-query',
    verifierApiBaseUrl: 'https://api.millionverifier.com',
    espApiBaseUrl: 'https://api.postmarkapp.com',
    egressExtraHosts: [],
  } as unknown as Env;
  const hosts = [...buildEgressPolicy(env).allowedHosts];
  assert.deepEqual(hosts.sort(), [
    'api.millionverifier.com', 'api.postmarkapp.com', 'cloudflare-dns.com', 'dns.google',
  ]);
  assert.ok(!hosts.some((h) => h.includes('linkedin')), 'LinkedIn must never be reachable');
});

void stat; // (reserved for future symlink checks)
