// @mailmetero/cron — public surface + dispatcher entrypoint.
//
// `runCron(name)` boots the shared config context, opens the unpooled pool pair, assembles the
// repos + email backend into `CronDeps`, runs the named job, and always closes the pools. Each of
// the seven jobs has its own render.yaml cron service whose start command is
// `node dist/index.js <name>`. When invoked as the process entrypoint, the CLI validates argv,
// runs the job, prints the report, and exits non-zero on failure.

import { pathToFileURL } from 'node:url';
import { boot } from '@mailmetero/config';
import {
  createPools,
  closePools,
  createResultsRepo,
  createLedgerRepo,
  createJobsRepo,
  createTenantsRepo,
  createObjectionsRepo,
  createSuppressionRepo,
  createIdempotencyRepo,
} from '@mailmetero/db';
import { makePostmarkBackend, makeNoopBackend, type EmailBackend } from '@mailmetero/email';
import {
  CRON_JOB_NAMES,
  type CronJob,
  type CronJobContext,
  type CronJobName,
  type CronJobReport,
  type CronDeps,
} from './job.ts';
import { ttlPurgeJob } from './jobs/ttl-purge.job.ts';
import { stuckJobSweepJob } from './jobs/stuck-job-sweep.job.ts';
import { quotaSpendResetJob } from './jobs/quota-spend-reset.job.ts';
import { creditBackSweepJob } from './jobs/credit-back-sweep.job.ts';
import { quotaAlertJob } from './jobs/quota-alert.job.ts';
import { blocklistSyncJob } from './jobs/blocklist-sync.job.ts';
import { objectionExpiryJob } from './jobs/objection-expiry.job.ts';

export type {
  CronJob,
  CronJobContext,
  CronJobReport,
  CronJobName,
  CronDeps,
  CronJobBody,
} from './job.ts';
export { CRON_JOB_NAMES, defineCronJob, iso } from './job.ts';
export { ttlPurgeJob } from './jobs/ttl-purge.job.ts';
export { stuckJobSweepJob } from './jobs/stuck-job-sweep.job.ts';
export { quotaSpendResetJob } from './jobs/quota-spend-reset.job.ts';
export { creditBackSweepJob } from './jobs/credit-back-sweep.job.ts';
export { quotaAlertJob } from './jobs/quota-alert.job.ts';
export { blocklistSyncJob } from './jobs/blocklist-sync.job.ts';
export { objectionExpiryJob } from './jobs/objection-expiry.job.ts';

/** The registry: every CronJobName resolves to exactly one CronJob. */
export const CRON_JOBS: Readonly<Record<CronJobName, CronJob>> = {
  'ttl-purge': ttlPurgeJob,
  'stuck-job-sweep': stuckJobSweepJob,
  'quota-spend-reset': quotaSpendResetJob,
  'credit-back-sweep': creditBackSweepJob,
  'quota-alert': quotaAlertJob,
  'blocklist-sync': blocklistSyncJob,
  'objection-expiry': objectionExpiryJob,
};

/** Type guard for an untrusted (argv-sourced) job name. */
export function isCronJobName(value: string): value is CronJobName {
  return (CRON_JOB_NAMES as readonly string[]).includes(value);
}

/**
 * Boot config, open pools, build deps, run the named job, and always close pools. Never throws for
 * a job-level failure — the failure is captured in the returned `CronJobReport` (ok:false). A hard
 * boot/pool error still rejects.
 */
export async function runCron(name: CronJobName): Promise<CronJobReport> {
  const job = CRON_JOBS[name];
  const { env, logger, egressFetch, appConfig } = boot();
  const pools = createPools(appConfig);

  const email: EmailBackend =
    env.espApiKey !== null
      ? makePostmarkBackend({
          fetch: egressFetch,
          baseUrl: env.espApiBaseUrl,
          apiKey: env.espApiKey,
          fromEmail: env.espFromEmail,
          messageStream: env.espMessageStream,
          logger,
        })
      : makeNoopBackend(logger);

  const deps: CronDeps = {
    pools,
    results: createResultsRepo(),
    ledger: createLedgerRepo(),
    jobs: createJobsRepo(),
    tenants: createTenantsRepo(),
    objections: createObjectionsRepo({ salt: env.suppressionSalt, suppression: createSuppressionRepo() }),
    idempotency: createIdempotencyRepo(),
    email,
    vendorDir: appConfig.vendorDir,
  };

  const ctx: CronJobContext = { now: new Date(), logger, deps };
  try {
    return await job.run(ctx);
  } finally {
    await closePools(pools);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const name = argv[2];
  if (name === undefined || !isCronJobName(name)) {
    process.stderr.write(
      `usage: mailmetero-cron <${CRON_JOB_NAMES.join('|')}>\n` +
        (name === undefined ? 'error: no job name given\n' : `error: unknown job '${name}'\n`),
    );
    process.exitCode = 2;
    return;
  }

  const report = await runCron(name);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

// Run as CLI only when invoked directly (not on import).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv).catch((err: unknown) => {
    process.stderr.write(`cron: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
