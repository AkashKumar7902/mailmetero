import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppConfig, buildAppConfig } from '../src/app-config.ts';
import { loadEnv } from '../src/env.ts';

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

test('loadAppConfig projects the flat env into grouped sub-configs', () => {
  const cfg = loadAppConfig(base({ SERVICE_ROLE: 'web' }));

  assert.equal(cfg.database.pooledUrl, 'postgres://u:p@pooler.example/db');
  assert.equal(cfg.database.unpooledUrl, 'postgres://u:p@direct.example/db');
  assert.equal(cfg.database.urlForRole, cfg.database.pooledUrl);
  assert.equal(cfg.database.testUrl, null);
  assert.equal(cfg.database.poolMaxWeb, 8);
  assert.equal(cfg.database.poolMaxWorker, 4);
  assert.equal(cfg.database.statementTimeoutMs, 8000);
  assert.equal(cfg.database.connTimeoutMs, 5000);

  assert.equal(cfg.api.port, 8080);
  assert.equal(cfg.api.bodyLimitBytes, 1_500_000);
  assert.equal(cfg.api.bulkMaxRows, 1000);
  assert.equal(cfg.api.jobPendingRetryAfterSeconds, 2);
  assert.equal(cfg.api.trustProxy, true);
  assert.equal(cfg.api.openApiVersion, '1.0.0');

  assert.equal(cfg.spend.killSwitchVerifierDefault, false);
  assert.equal(cfg.spend.globalDailyVerifierSpendCapCents, 5000);
  assert.equal(cfg.spend.defaultTenantDailyVerifierSpendCapCents, 500);

  assert.ok(cfg.vendorDir.endsWith('/data/vendor'));
});

test('worker role routes DB to the unpooled url', () => {
  const cfg = loadAppConfig(base({ SERVICE_ROLE: 'worker' }));
  assert.equal(cfg.database.urlForRole, cfg.database.unpooledUrl);
});

test('buildAppConfig is a pure projection of a validated Env', () => {
  const env = loadEnv({ source: base({ KILL_SWITCH_VERIFIER: 'on' }) });
  const cfg = buildAppConfig(env);
  assert.equal(cfg.env, env);
  assert.equal(cfg.spend.killSwitchVerifierDefault, true);
});

test('sub-config objects are frozen', () => {
  const cfg = loadAppConfig(base());
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.database));
  assert.ok(Object.isFrozen(cfg.api));
  assert.ok(Object.isFrozen(cfg.spend));
});
