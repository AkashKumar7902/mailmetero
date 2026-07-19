// @mailmetero/config — public surface. Typed env, structured AppConfig, egress choke
// point, logger, scoring boot.
export * from './env.ts';        // Env, loadEnv, verifierEnabled, EnvError, ServiceRole, NodeEnv, LogLevel
export * from './app-config.ts'; // AppConfig, DatabaseConfig, ApiConfig, SpendConfig, loadAppConfig, buildAppConfig
export * from './egress.ts';     // EgressPolicy, buildEgressPolicy, createEgressFetch, EgressFetch, EgressBlockedError
export * from './logger.ts';     // Logger, createLogger, redactString, REDACT_PATHS
export * from './scoring.ts';    // DEFAULT_SCORING_CONFIG, validateScoringConfig, ScoringConfig, ScoringConfigError

// Convenience: assemble the shared boot context once per process entrypoint.
import { loadEnv, type Env } from './env.ts';
import { buildAppConfig, type AppConfig } from './app-config.ts';
import { buildEgressPolicy, createEgressFetch, type EgressFetch } from './egress.ts';
import { createLogger, type Logger } from './logger.ts';

export interface BootContext {
  readonly env: Env;
  readonly logger: Logger;
  readonly egressFetch: EgressFetch;
  readonly appConfig: AppConfig;
}

/**
 * One call at the top of every entrypoint (api/worker/cron): validate env, then build
 * the logger, egress choke point and structured AppConfig. Env is loaded exactly once.
 */
export function boot(source?: Record<string, string | undefined>): BootContext {
  const env = loadEnv(source ? { source } : {});
  const logger = createLogger(env);
  const egressFetch = createEgressFetch(buildEgressPolicy(env), logger);
  const appConfig = buildAppConfig(env);
  return { env, logger, egressFetch, appConfig };
}
