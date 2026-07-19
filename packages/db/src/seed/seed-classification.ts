// @mailmetero/db — classification-table seeding (idempotent; NO network egress).
//
// Reads the VENDORED blocklist files (resolved from an absolute vendorDir anchor), normalizes
// each line, dedupes, and inserts with ON CONFLICT DO NOTHING. The SAME loader powers both the
// 0008 seed migration and the weekly blocklist-sync cron (refreshClassificationTables) — the
// cron never fetches anything, it just re-applies the vendored files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../client.ts';
import { normalizeDomainForSeed } from './normalize.ts';
import { createKbClassificationRepo } from '../repositories/kb-classification.ts';
import { SEED_ROLE_LOCALS, SEED_TYPO_DOMAINS } from './seed-scoring.ts';

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function normalizeUnique(lines: string[]): string[] {
  const out = new Set<string>();
  for (const line of lines) {
    const d = normalizeDomainForSeed(line);
    if (d !== null) out.add(d);
  }
  return [...out];
}

/** Load + normalize the freemail domain list from a single file path. */
export function loadFreemailFromFile(path: string): string[] {
  return normalizeUnique(readLines(path));
}

/** Load the UNION of the disposable list and the freemail∩disposable list, normalized+deduped. */
export function loadDisposableUnionFromFiles(paths: { primary: string; freemailDisposable: string }): string[] {
  return normalizeUnique([...readLines(paths.primary), ...readLines(paths.freemailDisposable)]);
}

export interface ClassificationSeedCounts {
  freemail: number;
  disposable: number;
  roles: number;
  typos: number;
}

/**
 * Seed all four classification tables from the vendored dir. Idempotent: re-running inserts
 * only new rows. Returns the number of rows inserted/affected per table this run.
 */
export async function seedClassificationTables(q: Queryable, vendorDir: string): Promise<ClassificationSeedCounts> {
  const repo = createKbClassificationRepo();

  const freemail = loadFreemailFromFile(join(vendorDir, 'freemail_domains.txt'));
  const disposable = loadDisposableUnionFromFiles({
    primary: join(vendorDir, 'disposable_domains.txt'),
    freemailDisposable: join(vendorDir, 'freemail_disposable.txt'),
  });

  const freemailN = await repo.replaceFreemail(q, freemail);
  const disposableN = await repo.replaceDisposable(q, disposable);
  const rolesN = await repo.upsertRoleLocals(q, [...SEED_ROLE_LOCALS]);
  const typosN = await repo.upsertTypos(q, [...SEED_TYPO_DOMAINS]);

  return { freemail: freemailN, disposable: disposableN, roles: rolesN, typos: typosN };
}

/**
 * Thin wrapper for the blocklist-sync cron: re-seed from the vendored files (NO egress).
 * Identical semantics to seedClassificationTables — kept as a distinct named export so the
 * cron's intent (refresh, not first-seed) is explicit at the call site.
 */
export async function refreshClassificationTables(q: Queryable, vendorDir: string): Promise<ClassificationSeedCounts> {
  return seedClassificationTables(q, vendorDir);
}
