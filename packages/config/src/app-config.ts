// @mailmetero/config — structured AppConfig views (fixes B2).
// `loadEnv` produces the flat, fully-validated Env; this module projects it into the
// grouped sub-configs each consumer wants:
//   • db.pool.ts     → AppConfig.database (createWebPool/createDirectPool/createPools)
//   • api server     → AppConfig.api     (static Fastify tunables)
//   • billing/spend  → AppConfig.spend   (kill switch default + cents caps)
// No new parsing happens here — it is a pure re-shaping of Env, so there is exactly one
// place (env.ts) that reads and validates the process environment.
//
// NOTE (D8): finder/sync BUDGETS are intentionally absent from ApiConfig — they are
// DB-tunable and read from ScoringConfig.caps, never from env.

import { loadEnv, type Env } from './env.ts';

export interface DatabaseConfig {
  readonly pooledUrl: string;
  readonly unpooledUrl: string;
  readonly urlForRole: string;
  readonly testUrl: string | null;
  readonly poolMaxWeb: number;
  readonly poolMaxWorker: number;
  readonly statementTimeoutMs: number;
  readonly connTimeoutMs: number;
}

export interface ApiConfig {
  readonly port: number;
  readonly bodyLimitBytes: number;
  readonly bulkMaxRows: number;
  readonly jobPendingRetryAfterSeconds: number;
  readonly trustProxy: boolean;
  readonly openApiVersion: string;
  // NOTE: finder/sync budgets are NOT here — read from ScoringConfig.caps (DB-tunable, D8).
}

export interface SpendConfig {
  readonly killSwitchVerifierDefault: boolean;
  readonly globalDailyVerifierSpendCapCents: number;
  readonly defaultTenantDailyVerifierSpendCapCents: number;
}

export interface AppConfig {
  readonly env: Env;
  readonly database: DatabaseConfig;
  readonly api: ApiConfig;
  readonly spend: SpendConfig;
  readonly vendorDir: string;
}

/** Pure projection of a validated Env into the grouped AppConfig sub-views. */
export function buildAppConfig(env: Env): AppConfig {
  const database: DatabaseConfig = {
    pooledUrl: env.databaseUrl,
    unpooledUrl: env.databaseUrlUnpooled,
    urlForRole: env.databaseUrlForRole,
    testUrl: env.databaseUrlTest,
    poolMaxWeb: env.poolMaxWeb,
    poolMaxWorker: env.poolMaxWorker,
    statementTimeoutMs: env.statementTimeoutMs,
    connTimeoutMs: env.connTimeoutMs,
  };
  const api: ApiConfig = {
    port: env.port,
    bodyLimitBytes: env.bodyLimitBytes,
    bulkMaxRows: env.bulkMaxRows,
    jobPendingRetryAfterSeconds: env.jobPendingRetryAfterSeconds,
    trustProxy: env.trustProxy,
    openApiVersion: env.openApiVersion,
  };
  const spend: SpendConfig = {
    killSwitchVerifierDefault: env.killSwitchVerifier,
    globalDailyVerifierSpendCapCents: env.globalDailyVerifierSpendCapCents,
    defaultTenantDailyVerifierSpendCapCents: env.defaultTenantDailyVerifierSpendCapCents,
  };
  return Object.freeze({
    env,
    database: Object.freeze(database),
    api: Object.freeze(api),
    spend: Object.freeze(spend),
    vendorDir: env.vendorDir,
  });
}

/** Load + validate the environment and return the structured AppConfig. Throws EnvError. */
export function loadAppConfig(source?: Record<string, string | undefined>): AppConfig {
  return buildAppConfig(loadEnv(source ? { source } : {}));
}
