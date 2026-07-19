// @mailmetero/api — composition root + public barrel.
//
// `main()` boots config, opens the DB pools, wires ApiDeps (adapters), builds the Fastify server,
// installs graceful shutdown, and listens on the configured port (Render web service). The barrel
// re-exports the api's public surface for tools/tests.

import { boot } from '@mailmetero/config';
import { createPools, closePools } from '@mailmetero/db';
import { buildApiDeps } from './adapters.ts';
import { buildServer } from './server.ts';

export async function main(): Promise<void> {
  const bootCtx = boot();
  const pools = createPools(bootCtx.appConfig);
  const deps = await buildApiDeps({ boot: bootCtx, pools });
  const app = await buildServer(deps);
  const port = bootCtx.appConfig.api.port;

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    bootCtx.logger.info({ signal }, 'mailmetero api shutting down');
    try {
      await app.close();
      await closePools(pools);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host: '0.0.0.0' });
  bootCtx.logger.info({ port }, 'mailmetero api listening');
}

// ── public barrel ─────────────────────────────────────────────────────────────
export * from './deps.ts';
export * from './types.ts';
export { buildServer } from './server.ts';
export { buildApiDeps } from './adapters.ts';
export { successEnvelope, errorEnvelope, apiError, makeMeta } from './envelope.ts';
export { HEADER, applyStandardHeaders, applyDeprecationHeader } from './headers.ts';
export { ERROR_HTTP_STATUS, ApiException, errors, errorHandler, notFoundHandler } from './errors.ts';
export { settleBilling } from './plugins/billing.ts';
export { OPENAPI_DOCUMENT } from './openapi/spec.ts';
export { validateResponseAgainstSpec } from './openapi/validate.ts';
export { enumSchema } from './schemas/enums.ts';
export { SHARED_SCHEMAS, registerSchemas } from './schemas/index.ts';
export { registerRoutes } from './routes/index.ts';
export { FIXTURES, FIXTURE_STATUS_COVERAGE, type FixtureCase } from './sandbox/fixtures.ts';
export { createSandboxRouter, type SandboxRouter } from './sandbox/router.ts';

// Auto-run when invoked directly (bin / Render start command).
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
