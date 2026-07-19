import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, verifierEnabled, EnvError } from '../src/env.ts';

const SECRET = 'x'.repeat(32);

function base(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://u:p@pooler.example/db',
    DATABASE_URL_UNPOOLED: 'postgres://u:p@direct.example/db',
    APP_PEPPER: SECRET,
    SUPPRESSION_SALT: SECRET,
    ...over,
  };
}

test('loads a minimal valid environment with sane defaults', () => {
  const env = loadEnv({ source: base() });
  assert.equal(env.nodeEnv, 'development');
  assert.equal(env.serviceRole, 'web');
  assert.equal(env.port, 8080);
  assert.equal(env.poolMaxWeb, 8);
  assert.equal(env.poolMaxWorker, 4);
  assert.equal(env.statementTimeoutMs, 8000);
  assert.equal(env.connTimeoutMs, 5000);
  assert.equal(env.bodyLimitBytes, 1_500_000);
  assert.equal(env.bulkMaxRows, 1000);
  assert.equal(env.jobPendingRetryAfterSeconds, 2);
  assert.equal(env.trustProxy, true);
  assert.equal(env.openApiVersion, '1.0.0');
  assert.ok(env.vendorDir.endsWith('/data/vendor'));
  assert.deepEqual(env.egressExtraHosts, []);
});

test('web role binds pooled DSN, worker binds unpooled', () => {
  const web = loadEnv({ source: base({ SERVICE_ROLE: 'web' }) });
  assert.equal(web.databaseUrlForRole, web.databaseUrl);
  const worker = loadEnv({ source: base({ SERVICE_ROLE: 'worker' }) });
  assert.equal(worker.databaseUrlForRole, worker.databaseUrlUnpooled);
  assert.equal(worker.port, 0);
});

test('USD spend caps are converted to integer cents AT LOAD', () => {
  const env = loadEnv({
    source: base({
      GLOBAL_DAILY_VERIFIER_SPEND_CAP_USD: '50',
      DEFAULT_TENANT_DAILY_VERIFIER_SPEND_CAP_USD: '5.25',
    }),
  });
  assert.equal(env.globalDailyVerifierSpendCapCents, 5000);
  assert.equal(env.defaultTenantDailyVerifierSpendCapCents, 525);
});

test('default spend caps convert to cents', () => {
  const env = loadEnv({ source: base() });
  assert.equal(env.globalDailyVerifierSpendCapCents, 5000);
  assert.equal(env.defaultTenantDailyVerifierSpendCapCents, 500);
});

test('aggregates every problem into a single EnvError', () => {
  try {
    loadEnv({ source: { APP_PEPPER: 'short' } });
    assert.fail('expected EnvError');
  } catch (e) {
    assert.ok(e instanceof EnvError);
    // DATABASE_URL, DATABASE_URL_UNPOOLED required; APP_PEPPER too short; SUPPRESSION_SALT required
    assert.ok(e.problems.length >= 4, `got ${e.problems.length} problems`);
    assert.ok(e.problems.some((p) => p.includes('DATABASE_URL')));
    assert.ok(e.problems.some((p) => p.includes('APP_PEPPER')));
    assert.ok(e.problems.some((p) => p.includes('SUPPRESSION_SALT')));
  }
});

test('production requires verifier + ESP keys', () => {
  assert.throws(
    () => loadEnv({ source: base({ NODE_ENV: 'production' }) }),
    (e: unknown) => e instanceof EnvError
      && (e).problems.some((p) => p.includes('VERIFIER_API_KEY'))
      && (e).problems.some((p) => p.includes('ESP_API_KEY')),
  );
  // supplying them clears the error
  const env = loadEnv({
    source: base({ NODE_ENV: 'production', VERIFIER_API_KEY: 'k'.repeat(12), ESP_API_KEY: 'k'.repeat(12) }),
  });
  assert.equal(env.nodeEnv, 'production');
});

test('non-https outbound URL is rejected', () => {
  assert.throws(
    () => loadEnv({ source: base({ VERIFIER_API_BASE_URL: 'http://insecure.example' }) }),
    (e: unknown) => e instanceof EnvError && (e).problems.some((p) => p.includes('VERIFIER_API_BASE_URL')),
  );
});

test('boolean env vars parse on/off forms; invalid rejected', () => {
  assert.equal(loadEnv({ source: base({ TRUST_PROXY: 'off' }) }).trustProxy, false);
  assert.equal(loadEnv({ source: base({ KILL_SWITCH_VERIFIER: 'yes' }) }).killSwitchVerifier, true);
  assert.throws(() => loadEnv({ source: base({ TRUST_PROXY: 'maybe' }) }), EnvError);
});

test('EGRESS_EXTRA_HOSTS is split, trimmed and lowercased', () => {
  const env = loadEnv({ source: base({ EGRESS_EXTRA_HOSTS: ' A.Example.com, b.example.com ,' }) });
  assert.deepEqual(env.egressExtraHosts, ['a.example.com', 'b.example.com']);
});

test('verifierEnabled reflects kill switch and key presence', () => {
  const withKey = loadEnv({ source: base({ VERIFIER_API_KEY: 'k'.repeat(12) }) });
  assert.equal(verifierEnabled(withKey), true);
  const killed = loadEnv({ source: base({ VERIFIER_API_KEY: 'k'.repeat(12), KILL_SWITCH_VERIFIER: 'on' }) });
  assert.equal(verifierEnabled(killed), false);
  const noKey = loadEnv({ source: base() });
  assert.equal(verifierEnabled(noKey), false);
});

test('VENDOR_DIR override is honoured', () => {
  const env = loadEnv({ source: base({ VENDOR_DIR: '/custom/vendor' }) });
  assert.equal(env.vendorDir, '/custom/vendor');
});
