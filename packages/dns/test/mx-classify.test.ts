// @mailmetero/dns — classifyMx unit tests (pure; no network).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyMx } from '../src/mx-classify.ts';
import type { DohAnswer } from '../src/types.ts';

function mx(data: string): DohAnswer {
  return { name: 'example.com', type: 15, TTL: 300, data };
}

test('NULL_MX: single "0 ." null exchange → NULL_MX, no hosts', () => {
  const out = classifyMx({ mxAnswers: [mx('0 .')], hasAddress: true });
  assert.equal(out.mx, 'NULL_MX');
  assert.deepEqual(out.hosts, []);
});

test('NULL_MX is definitive even when the domain has an A record', () => {
  const out = classifyMx({ mxAnswers: [mx('0 .')], hasAddress: true });
  assert.equal(out.mx, 'NULL_MX');
});

test('EXPLICIT_MX: single real MX → EXPLICIT_MX with canonicalized host', () => {
  const out = classifyMx({ mxAnswers: [mx('10 ASPMX.L.GOOGLE.COM.')], hasAddress: false });
  assert.equal(out.mx, 'EXPLICIT_MX');
  assert.deepEqual(out.hosts, [{ exchange: 'aspmx.l.google.com', preference: 10 }]);
});

test('EXPLICIT_MX: multi-MX sorted by preference ascending (most-preferred first)', () => {
  const out = classifyMx({
    mxAnswers: [
      mx('30 alt2.aspmx.l.google.com.'),
      mx('10 aspmx.l.google.com.'),
      mx('20 alt1.aspmx.l.google.com.'),
    ],
    hasAddress: false,
  });
  assert.equal(out.mx, 'EXPLICIT_MX');
  assert.deepEqual(
    out.hosts.map((h) => h.preference),
    [10, 20, 30],
  );
  assert.equal(out.hosts[0]?.exchange, 'aspmx.l.google.com');
});

test('EXPLICIT_MX: equal preferences preserve input order (stable sort)', () => {
  const out = classifyMx({
    mxAnswers: [mx('10 b.example.com.'), mx('10 a.example.com.')],
    hasAddress: false,
  });
  assert.deepEqual(
    out.hosts.map((h) => h.exchange),
    ['b.example.com', 'a.example.com'],
  );
});

test('EXPLICIT_MX wins if a stray null exchange co-exists with real hosts', () => {
  const out = classifyMx({ mxAnswers: [mx('0 .'), mx('10 mail.example.com.')], hasAddress: false });
  assert.equal(out.mx, 'EXPLICIT_MX');
  assert.deepEqual(out.hosts, [{ exchange: 'mail.example.com', preference: 10 }]);
});

test('IMPLICIT_MX_FALLBACK: no MX but has address → implicit, empty hosts', () => {
  const out = classifyMx({ mxAnswers: [], hasAddress: true });
  assert.equal(out.mx, 'IMPLICIT_MX_FALLBACK');
  assert.deepEqual(out.hosts, []);
});

test('NO_MAIL_HOST: no MX and no address', () => {
  const out = classifyMx({ mxAnswers: [], hasAddress: false });
  assert.equal(out.mx, 'NO_MAIL_HOST');
  assert.deepEqual(out.hosts, []);
});

test('non-MX answer types are ignored', () => {
  const noise: DohAnswer = { name: 'example.com', type: 46 /* RRSIG */, TTL: 300, data: 'MX 8 2 300 ...' };
  const out = classifyMx({ mxAnswers: [noise, mx('5 mail.example.com.')], hasAddress: false });
  assert.equal(out.mx, 'EXPLICIT_MX');
  assert.deepEqual(out.hosts, [{ exchange: 'mail.example.com', preference: 5 }]);
});

test('malformed MX rdata is skipped, falling back to address posture', () => {
  const out = classifyMx({ mxAnswers: [mx('not-a-record')], hasAddress: true });
  assert.equal(out.mx, 'IMPLICIT_MX_FALLBACK');
});
