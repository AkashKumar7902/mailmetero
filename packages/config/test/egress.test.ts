import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEgressPolicy, createEgressFetch, EgressBlockedError } from '../src/egress.ts';
import { loadEnv, type Env } from '../src/env.ts';
import type { Logger } from '../src/logger.ts';

const SECRET = 'x'.repeat(32);

function env(over: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    source: {
      DATABASE_URL: 'postgres://u:p@pooler.example/db',
      DATABASE_URL_UNPOOLED: 'postgres://u:p@direct.example/db',
      APP_PEPPER: SECRET,
      SUPPRESSION_SALT: SECRET,
      ...over,
    },
  });
}

// silent logger stub (no stdout noise during tests)
const noopLogger = {
  warn() {}, info() {}, error() {}, debug() {}, trace() {}, fatal() {},
} as unknown as Logger;

test('policy contains only configured endpoint hosts — no wildcard', () => {
  const policy = buildEgressPolicy(env());
  assert.ok(policy.allowedHosts.has('dns.google'));
  assert.ok(policy.allowedHosts.has('cloudflare-dns.com'));
  assert.ok(policy.allowedHosts.has('api.millionverifier.com'));
  assert.ok(policy.allowedHosts.has('api.postmarkapp.com'));
  assert.ok(!policy.allowedHosts.has('*'));
});

test('LinkedIn and github are never on the allowlist, even via EGRESS_EXTRA_HOSTS', () => {
  const policy = buildEgressPolicy(env({
    EGRESS_EXTRA_HOSTS: 'www.linkedin.com, github.com, raw.githubusercontent.com, ops.example.com',
  }));
  assert.ok(!policy.allowedHosts.has('www.linkedin.com'));
  assert.ok(!policy.allowedHosts.has('github.com'));
  assert.ok(!policy.allowedHosts.has('raw.githubusercontent.com'));
  // a legitimate ops host still gets through
  assert.ok(policy.allowedHosts.has('ops.example.com'));
});

test('createEgressFetch throws EgressBlockedError before any network call for a blocked host', async () => {
  const fetchFn = createEgressFetch(buildEgressPolicy(env()), noopLogger);
  await assert.rejects(
    () => fetchFn('https://evil.example.com/steal'),
    (e: unknown) => e instanceof EgressBlockedError && (e).host === 'evil.example.com',
  );
});

test('createEgressFetch blocks a forbidden host even if somehow present', async () => {
  const fetchFn = createEgressFetch(buildEgressPolicy(env()), noopLogger);
  await assert.rejects(
    () => fetchFn('https://www.linkedin.com/in/someone'),
    (e: unknown) => e instanceof EgressBlockedError,
  );
});
