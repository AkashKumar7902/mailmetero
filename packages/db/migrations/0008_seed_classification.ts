// 0008 — data seed: freemail + disposable classification tables from the VENDORED dir
// (junk-filtered, punycode; idempotent). VENDOR_DIR is resolved from an ABSOLUTE anchor
// (module URL), never a cwd-relative literal. The blocklist-sync cron calls the SAME loader
// (refreshClassificationTables) weekly — no network egress.

import { fileURLToPath } from 'node:url';
import type { MigrationBuilder } from 'node-pg-migrate';
import type { Queryable } from '../src/client.ts';
import { seedClassificationTables } from '../src/seed/seed-classification.ts';

// packages/db/migrations/ → repo root is three levels up; vendored data lives at data/vendor.
const VENDOR_DIR = fileURLToPath(new URL('../../../data/vendor', import.meta.url));

function asQueryable(pgm: MigrationBuilder): Queryable {
  return { query: (text: unknown, params?: unknown) => pgm.db.query(text as string, params as unknown[]) } as Queryable;
}

export const up = async (pgm: MigrationBuilder): Promise<void> => {
  await seedClassificationTables(asQueryable(pgm), VENDOR_DIR);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DELETE FROM kb.disposable_domains;
    DELETE FROM kb.freemail_domains;
  `);
};
