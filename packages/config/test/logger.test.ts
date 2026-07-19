import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactString, createLogger, REDACT_PATHS } from '../src/logger.ts';
import { loadEnv } from '../src/env.ts';

const SECRET = 'x'.repeat(32);
const baseEnv = loadEnv({
  source: {
    DATABASE_URL: 'postgres://u:p@pooler.example/db',
    DATABASE_URL_UNPOOLED: 'postgres://u:p@direct.example/db',
    APP_PEPPER: SECRET,
    SUPPRESSION_SALT: SECRET,
    LOG_LEVEL: 'error',
  },
});

test('redactString scrubs sk_ secret bodies but keeps env prefix', () => {
  assert.equal(redactString('key sk_live_ABCDEF123456 end'), 'key sk_live_*** end');
  assert.equal(redactString('key sk_test_ABCDEF123456 end'), 'key sk_test_*** end');
  assert.equal(redactString('key sk_ABCDEF123456 end'), 'key sk_*** end');
});

test('redactString scrubs Bearer tokens', () => {
  assert.equal(redactString('Authorization: Bearer abc.def.ghi123'), 'Authorization: Bearer ***');
});

test('redactString scrubs api_key= query values (D17 deprecated param)', () => {
  assert.equal(
    redactString('GET /v1/find?domain=x&api_key=sk_live_TOPSECRET&foo=1'),
    'GET /v1/find?domain=x&api_key=***&foo=1',
  );
});

test('redactString scrubs DSN passwords', () => {
  assert.equal(
    redactString('postgres://user:supersecret@host:5432/db'),
    'postgres://user:***@host:5432/db',
  );
  assert.equal(
    redactString('postgresql://user:supersecret@host/db'),
    'postgresql://user:***@host/db',
  );
});

test('redactString leaves non-secret text untouched', () => {
  assert.equal(redactString('plain log line, count=5'), 'plain log line, count=5');
});

test('REDACT_PATHS covers auth headers and known secret fields', () => {
  assert.ok(REDACT_PATHS.includes('req.headers.authorization'));
  assert.ok(REDACT_PATHS.some((p) => p.includes('appPepper')));
  assert.ok(REDACT_PATHS.some((p) => p.includes('suppressionSalt')));
});

test('createLogger returns a pino logger bound to the service role', () => {
  const logger = createLogger(baseEnv);
  assert.equal(typeof logger.info, 'function');
  assert.equal(logger.level, 'error');
});
