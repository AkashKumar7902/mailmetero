// Integration-test global setup (node:test --test-setup). Gates the Neon-backed suites:
// integration tests require DATABASE_URL_TEST (a throwaway Neon branch); when absent
// (e.g. a fork PR with no secret) the suite is skipped, not failed. Unit tests never
// touch this file and need no DB. Owned by config-deploy-ops.
import { before, type TestContext } from 'node:test';

export const INTEGRATION_DSN = process.env.DATABASE_URL_TEST ?? null;
export const hasDb = INTEGRATION_DSN !== null;

before(() => {
  if (!hasDb) {
    // eslint-disable-next-line no-console
    console.warn('[integration] DATABASE_URL_TEST unset — integration tests will skip.');
    return;
  }
  process.env.NODE_ENV = 'test';
  process.env.SERVICE_ROLE = 'worker'; // unpooled path
  process.env.DATABASE_URL = INTEGRATION_DSN!;
  process.env.DATABASE_URL_UNPOOLED = INTEGRATION_DSN!;
});

/**
 * Helper each *.integration.test.ts calls at the top: `if (skipUnlessDb(t)) return;`.
 * When DATABASE_URL_TEST is absent (e.g. a fork PR with no Neon secret) the test is SKIPPED,
 * never failed — the Neon-backed suites are opt-in on that secret.
 */
export function skipUnlessDb(t: TestContext): boolean {
  if (!hasDb) {
    t.skip('DATABASE_URL_TEST unset — integration test skipped');
    return true;
  }
  return false;
}

/** Returns the integration DSN, or throws — use only after `skipUnlessDb` has gated the test. */
export function requireDb(): string {
  if (!hasDb) throw new Error('DATABASE_URL_TEST required for this integration test');
  return INTEGRATION_DSN!;
}
