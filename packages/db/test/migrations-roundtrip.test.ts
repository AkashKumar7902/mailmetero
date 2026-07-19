// Migration structure test (no live DB).
//
// Asserts the single migration history is complete and contiguous (0000–0009), that every
// DDL migration's down drops what its up creates (up→down symmetry), and that the two data
// migrations delegate to the seed loaders and expose async up/down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { up as up0, down as down0 } from '../migrations/0000_extensions_schemas.ts';
import { up as up1, down as down1 } from '../migrations/0001_tenant_core.ts';
import { up as up2, down as down2 } from '../migrations/0002_kb_schema.ts';
import { up as up3, down as down3 } from '../migrations/0003_jobs_queue.ts';
import { up as up4, down as down4 } from '../migrations/0004_billing.ts';
import { up as up5, down as down5 } from '../migrations/0005_ops_spend_policy.ts';
import { up as up6, down as down6 } from '../migrations/0006_compliance.ts';
import { up as up9, down as down9 } from '../migrations/0009_session_timeouts.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

type Fn = (pgm: { sql: (s: string) => void }) => void;

function sqlOf(fn: Fn): string {
  const parts: string[] = [];
  fn({ sql: (s) => parts.push(s) });
  return parts.join('\n');
}

function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+(?:\.[a-z_]+)?)/gi)].map((m) => m[1] as string);
}

test('migration files are contiguous 0000..0009 and each exports up/down', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.ts$/.test(f)).sort();
  assert.equal(files.length, 10, `expected 10 migrations, got ${files.length}`);
  files.forEach((f, i) => {
    assert.ok(f.startsWith(String(i).padStart(4, '0')), `file ${f} out of order at index ${i}`);
    const src = readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8');
    assert.match(src, /export (const|async function) up\b/, `${f} exports up`);
    assert.match(src, /export (const|async function) down\b/, `${f} exports down`);
  });
});

test('each DDL migration down drops every table its up creates', () => {
  const pairs: Array<{ name: string; up: Fn; down: Fn }> = [
    { name: '0000', up: up0 as Fn, down: down0 as Fn },
    { name: '0001', up: up1 as Fn, down: down1 as Fn },
    { name: '0002', up: up2 as Fn, down: down2 as Fn },
    { name: '0003', up: up3 as Fn, down: down3 as Fn },
    { name: '0004', up: up4 as Fn, down: down4 as Fn },
    { name: '0005', up: up5 as Fn, down: down5 as Fn },
    { name: '0006', up: up6 as Fn, down: down6 as Fn },
    { name: '0009', up: up9 as Fn, down: down9 as Fn },
  ];
  for (const { name, up, down } of pairs) {
    const downSql = sqlOf(down);
    for (const t of createdTables(sqlOf(up))) {
      assert.match(downSql, new RegExp(`DROP TABLE IF EXISTS ${t.replace('.', '\\.')}`), `${name}: down must drop ${t}`);
    }
  }
});

test('0002 creates exactly the nine kb.* tables', () => {
  const tables = new Set(createdTables(sqlOf(up2 as Fn)).filter((t) => t.startsWith('kb.')));
  assert.deepEqual(
    [...tables].sort(),
    [
      'kb.blend_weights', 'kb.disposable_domains', 'kb.domain_patterns', 'kb.domains',
      'kb.freemail_domains', 'kb.pattern_priors', 'kb.provider_fingerprints', 'kb.role_locals',
      'kb.typo_domains',
    ],
  );
});

test('0000 creates both app schemas', () => {
  const sql = sqlOf(up0 as Fn);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS kb/);
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS ops/);
});

test('data migrations delegate to the seed loaders and expose async up', () => {
  const seed7 = readFileSync(`${MIGRATIONS_DIR}/0007_seed_scoring_fingerprints.ts`, 'utf8');
  assert.match(seed7, /seedScoringAndFingerprints/);
  assert.match(seed7, /export const up = async/);

  const seed8 = readFileSync(`${MIGRATIONS_DIR}/0008_seed_classification.ts`, 'utf8');
  assert.match(seed8, /seedClassificationTables/);
  assert.match(seed8, /export const up = async/);
  // VENDOR_DIR must come from an absolute module-URL anchor, never a cwd-relative literal.
  assert.match(seed8, /new URL\('\.\.\/\.\.\/\.\.\/data\/vendor', import\.meta\.url\)/);
});
