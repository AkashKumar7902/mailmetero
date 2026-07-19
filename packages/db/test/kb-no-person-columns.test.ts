// D7 invariant test — source-level (no live DB required).
//
// Extracts the kb.* columns declared by the 0002 migration and drives the AUTHORITATIVE
// assertKbHasNoPersonColumns() with a fake Queryable that mimics information_schema. Also
// pins the denylist/allowlist behavior directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KB_COLUMN_ALLOWLIST, PERSON_COLUMN_DENYLIST, assertKbHasNoPersonColumns, KbInvariantError,
} from '../src/ci/kb-invariant.ts';
import type { Queryable } from '../src/client.ts';
import { up as kbUp } from '../migrations/0002_kb_schema.ts';

// ── capture the DDL emitted by the migration ────────────────────────────────
function captureSql(up: (pgm: { sql: (s: string) => void }) => void): string {
  const parts: string[] = [];
  up({ sql: (s: string) => parts.push(s) });
  return parts.join('\n');
}

// Paren-aware extraction of `CREATE TABLE kb.<name> ( ... )` column names.
function extractKbColumns(sql: string): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const re = /CREATE TABLE kb\.(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1] as string;
    // Walk from the opening paren, tracking depth, to the matching close.
    let depth = 1;
    let i = re.lastIndex;
    let body = '';
    while (i < sql.length && depth > 0) {
      const ch = sql[i] as string;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth > 0) body += ch;
      i++;
    }
    // Split the body on top-level commas.
    let d = 0;
    let cur = '';
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === '(') d++;
      else if (ch === ')') d--;
      if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim() !== '') parts.push(cur);
    for (const raw of parts) {
      const def = raw.trim();
      if (def === '') continue;
      if (/^(UNIQUE|CHECK|PRIMARY|FOREIGN|CONSTRAINT)\b/i.test(def)) continue;
      const col = def.split(/\s+/)[0]?.replace(/"/g, '');
      if (col) out.push({ table, column: col });
    }
  }
  return out;
}

const KB_COLUMNS = extractKbColumns(captureSql(kbUp as never));

test('the migration actually declares kb columns', () => {
  assert.ok(KB_COLUMNS.length > 20, `expected many kb columns, got ${KB_COLUMNS.length}`);
});

test('every declared kb column is allowlisted and denylist-clean (authoritative fn passes)', async () => {
  const fakeQ: Queryable = {
    query: async () => ({
      rows: KB_COLUMNS.map((c) => ({ table_name: c.table, column_name: c.column })),
      rowCount: KB_COLUMNS.length,
    }),
  } as unknown as Queryable;
  await assert.doesNotReject(() => assertKbHasNoPersonColumns(fakeQ));
});

test('assertKbHasNoPersonColumns throws on an injected person column', async () => {
  const fakeQ: Queryable = {
    query: async () => ({
      rows: [
        { table_name: 'domains', column_name: 'domain' },
        { table_name: 'domains', column_name: 'contact_email' }, // offender
      ],
      rowCount: 2,
    }),
  } as unknown as Queryable;
  await assert.rejects(() => assertKbHasNoPersonColumns(fakeQ), KbInvariantError);
});

test('assertKbHasNoPersonColumns throws on a non-allowlisted (but non-person) column', async () => {
  const fakeQ: Queryable = {
    query: async () => ({
      rows: [{ table_name: 'domains', column_name: 'some_new_unlisted_col' }],
      rowCount: 1,
    }),
  } as unknown as Queryable;
  await assert.rejects(() => assertKbHasNoPersonColumns(fakeQ), KbInvariantError);
});

test('denylist matches person columns', () => {
  for (const c of ['first_name', 'last_name', 'full_name', 'given_name', 'display_name',
                   'email', 'user_email', 'contact_email', 'mailbox', 'recipient', 'phone']) {
    assert.ok(PERSON_COLUMN_DENYLIST.test(c), `should match: ${c}`);
  }
});

test('denylist does NOT match the intentionally-allowlisted kb tokens', () => {
  for (const c of ['local_part', 'pattern_token', 'domain', 'mx_suffix', 'winning_fold',
                   'size_bracket', 'verified_count', 'domain_verified_support']) {
    assert.ok(!PERSON_COLUMN_DENYLIST.test(c), `should NOT match: ${c}`);
    assert.ok(KB_COLUMN_ALLOWLIST.has(c), `should be allowlisted: ${c}`);
  }
});
