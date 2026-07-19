// @mailmetero/dns — createDnsResolver unit tests using a stub transport (no live network).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDnsResolver } from '../src/resolver.ts';
import type { DohTransport } from '../src/doh-transport.ts';
import type { DnsRecordType, DohEndpointId, DohResponse } from '../src/types.ts';
import type { Domain } from '@mailmetero/contracts';

const dom = (s: string): Domain => s as Domain;
const FIXED_MS = Date.UTC(2026, 6, 19, 12, 0, 0); // 2026-07-19T12:00:00.000Z
const clock = (): number => FIXED_MS;

interface Call {
  endpoint: DohEndpointId;
  name: string;
  type: DnsRecordType;
}

type Handler = (call: Call) => DohResponse | Promise<DohResponse>;

function stub(handler: Handler): { transport: DohTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: DohTransport = {
    async query(endpoint, name, type): Promise<DohResponse> {
      const call = { endpoint, name, type };
      calls.push(call);
      return handler(call);
    },
  };
  return { transport, calls };
}

const mxAns = (data: string) => ({ name: 'x', type: 15, TTL: 300, data });
const aAns = (data: string) => ({ name: 'x', type: 1, TTL: 300, data });
const txtAns = (data: string) => ({ name: 'x', type: 16, TTL: 300, data });

test('explicit MX with SPF+DMARC resolves fully via primary endpoint', async () => {
  const { transport, calls } = stub((c) => {
    if (c.type === 'MX') return { Status: 0, Answer: [mxAns('10 aspmx.l.google.com.')] };
    if (c.type === 'A') return { Status: 0, Answer: [aAns('1.2.3.4')] };
    if (c.type === 'TXT' && c.name.startsWith('_dmarc.')) return { Status: 0, Answer: [txtAns('"v=DMARC1; p=reject"')] };
    if (c.type === 'TXT') return { Status: 0, Answer: [txtAns('"v=spf1 include:_spf.google.com ~all"')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('acme.com'));

  assert.equal(r.mx, 'EXPLICIT_MX');
  assert.deepEqual(r.hosts, [{ exchange: 'aspmx.l.google.com', preference: 10 }]);
  assert.equal(r.hasAddress, true);
  assert.equal(r.spfPresent, true);
  assert.equal(r.dmarcPresent, true);
  assert.equal(r.resolvedVia, 'google');
  assert.equal(r.resolvedAt, '2026-07-19T12:00:00.000Z');
  assert.equal(r.domain, 'acme.com');
  // AAAA not queried because A already established an address.
  assert.ok(!calls.some((c) => c.type === 'AAAA'));
  // _dmarc TXT lookup used the prefixed name.
  assert.ok(calls.some((c) => c.type === 'TXT' && c.name === '_dmarc.acme.com'));
});

test('NXDOMAIN on MX → NO_MAIL_HOST, short-circuits before A/TXT', async () => {
  const { transport, calls } = stub((c) => {
    if (c.type === 'MX') return { Status: 3 }; // NXDOMAIN
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('nope.example'));

  assert.equal(r.mx, 'NO_MAIL_HOST');
  assert.deepEqual(r.hosts, []);
  assert.equal(r.hasAddress, false);
  assert.equal(r.spfPresent, false);
  assert.equal(r.dmarcPresent, false);
  assert.equal(r.resolvedVia, 'google');
  assert.equal(calls.length, 1); // only the MX query ran
});

test('implicit MX: no MX, A present → IMPLICIT_MX_FALLBACK', async () => {
  const { transport } = stub((c) => {
    if (c.type === 'MX') return { Status: 0 }; // NOERROR, no MX answers
    if (c.type === 'A') return { Status: 0, Answer: [aAns('93.184.216.34')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('webonly.com'));
  assert.equal(r.mx, 'IMPLICIT_MX_FALLBACK');
  assert.equal(r.hasAddress, true);
});

test('no MX and no A → queries AAAA then classifies NO_MAIL_HOST', async () => {
  const { transport, calls } = stub((c) => ({ Status: 0 }) as DohResponse);
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('empty.com'));
  assert.equal(r.mx, 'NO_MAIL_HOST');
  assert.ok(calls.some((c) => c.type === 'AAAA'));
});

test('Google→Cloudflare fallback: primary throws, fallback resolves', async () => {
  const { transport, calls } = stub((c) => {
    if (c.endpoint === 'google') throw new Error('google down');
    if (c.type === 'MX') return { Status: 0, Answer: [mxAns('10 mail.acme.com.')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('acme.com'));
  assert.equal(r.mx, 'EXPLICIT_MX');
  assert.equal(r.resolvedVia, 'cloudflare');
  assert.ok(calls.some((c) => c.endpoint === 'google'));
  assert.ok(calls.some((c) => c.endpoint === 'cloudflare'));
});

test('fallback also triggers on a non-NXDOMAIN failure RCODE (SERVFAIL)', async () => {
  const { transport } = stub((c) => {
    if (c.endpoint === 'google' && c.type === 'MX') return { Status: 2 }; // SERVFAIL
    if (c.type === 'MX') return { Status: 0, Answer: [mxAns('5 mx.acme.com.')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('acme.com'));
  assert.equal(r.resolvedVia, 'cloudflare');
  assert.equal(r.mx, 'EXPLICIT_MX');
});

test('never throws: every endpoint fails → NO_MAIL_HOST terminal', async () => {
  const { transport } = stub(() => {
    throw new Error('all resolvers down');
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('acme.com'));
  assert.equal(r.mx, 'NO_MAIL_HOST');
  assert.equal(r.resolvedVia, 'cloudflare'); // last endpoint tried
});

test('custom endpoint order is honored', async () => {
  const { transport, calls } = stub((c) => {
    if (c.type === 'MX') return { Status: 0, Answer: [mxAns('10 mx.acme.com.')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock, { endpointOrder: ['cloudflare'] });
  const r = await resolver.resolve(dom('acme.com'));
  assert.equal(r.resolvedVia, 'cloudflare');
  assert.ok(calls.every((c) => c.endpoint === 'cloudflare'));
});

test('SPF absent when no matching TXT record', async () => {
  const { transport } = stub((c) => {
    if (c.type === 'MX') return { Status: 0, Answer: [mxAns('10 mx.acme.com.')] };
    if (c.type === 'A') return { Status: 0, Answer: [aAns('1.1.1.1')] };
    if (c.type === 'TXT') return { Status: 0, Answer: [txtAns('"google-site-verification=abc"')] };
    return { Status: 0 };
  });
  const resolver = createDnsResolver(transport, clock);
  const r = await resolver.resolve(dom('acme.com'));
  assert.equal(r.spfPresent, false);
  assert.equal(r.dmarcPresent, false);
});
