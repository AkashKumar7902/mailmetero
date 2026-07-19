// @mailmetero/worker — the processor registry (MODULE_CONTRACTS §9).
//
// One JobProcessor per JobKind. The loop dispatches a claimed job to PROCESSORS[job.kind].

import type { JobKind } from '@mailmetero/contracts';
import type { JobRow } from '@mailmetero/db';
import type { WorkerDeps } from '../deps.ts';
import { bulkFindProcessor } from './bulk-find.processor.ts';
import { bulkVerifyProcessor } from './bulk-verify.processor.ts';
import { asyncVerifyProcessor } from './async-verify.processor.ts';

/** A handler for one JobKind. `process` owns the whole job (all its pending items). */
export interface JobProcessor {
  readonly kind: JobKind;
  process(job: JobRow, deps: WorkerDeps, signal: AbortSignal): Promise<void>;
}

/** Total map JobKind → processor (every kind has exactly one handler). */
export const PROCESSORS: Readonly<Record<JobKind, JobProcessor>> = {
  bulk_find: bulkFindProcessor,
  bulk_verify: bulkVerifyProcessor,
  async_verify: asyncVerifyProcessor,
};
