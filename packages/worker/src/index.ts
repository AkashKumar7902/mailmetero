// @mailmetero/worker — public surface + composition root (MODULE_CONTRACTS §9).
//
// The worker is a long-lived Node process on Render (unpooled DSN, D20). `bootstrapWorker` boots
// config once, wires the deps, installs SIGTERM/SIGINT handlers that abort the loop for a graceful
// drain, runs the loop to completion, then closes the pools.

import { boot } from '@mailmetero/config';
import { closePools } from '@mailmetero/db';
import { loadWorkerConfig, buildWorkerDeps } from './deps.ts';
import { runWorkerLoop, runWorkerDrain } from './loop.ts';

export type { WorkerConfig, WorkerDeps } from './deps.ts';
export { loadWorkerConfig, buildWorkerDeps } from './deps.ts';
export { runWorkerLoop, runWorkerDrain } from './loop.ts';
export type { JobProcessor } from './processors/registry.ts';
export { PROCESSORS } from './processors/registry.ts';
export {
  itemRequestId,
  settleFinderItem,
  settleVerifierItem,
  runWithConcurrency,
  WorkerRetryableError,
  type ItemOutcome,
} from './item.ts';

/**
 * Await the loop, but once a shutdown signal has fired, cap the drain at `graceMs` so a pathological
 * in-flight job cannot block termination indefinitely. Resolves either when the loop drains or when
 * the grace deadline elapses after abort.
 */
function awaitDrain(loop: Promise<void>, signal: AbortSignal, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    void loop.then(done, done);
    signal.addEventListener('abort', () => setTimeout(done, graceMs), { once: true });
  });
}

/**
 * Process entrypoint. Boots, wires deps, runs the loop until a termination signal drains it, then
 * closes pools. Resolves when shutdown is complete.
 */
export async function bootstrapWorker(): Promise<void> {
  const bootCtx = boot();
  const cfg = loadWorkerConfig(bootCtx.env);
  const deps = await buildWorkerDeps(bootCtx);

  const controller = new AbortController();
  const onSignal = (sig: NodeJS.Signals): void => {
    deps.logger.info({ sig }, 'worker: shutdown signal received, draining');
    controller.abort();
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    const loop = runWorkerLoop(cfg, deps, controller.signal);
    await awaitDrain(loop, controller.signal, cfg.shutdownGraceMs);
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    await closePools(deps.pools);
    deps.logger.info('worker: shutdown complete');
  }
}

/**
 * Drain-and-exit entrypoint for the free scheduled-Action model: boot, wire deps, drain the ready
 * queue once, close pools, and return. Invoked as `node packages/worker/dist/index.js drain`.
 */
export async function bootstrapWorkerDrain(): Promise<void> {
  const bootCtx = boot();
  const cfg = loadWorkerConfig(bootCtx.env);
  const deps = await buildWorkerDeps(bootCtx);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  try {
    const processed = await runWorkerDrain(cfg, deps, controller.signal);
    deps.logger.info({ processed }, 'worker: drain run finished');
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    await closePools(deps.pools);
  }
}

// Run when invoked directly (node dist/index.js [drain]), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv[2] === 'drain' ? bootstrapWorkerDrain : bootstrapWorker;
  run().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('worker: fatal', err);
    process.exit(1);
  });
}
