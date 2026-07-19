// CI invariant (D7, §9.6): the shared kb.* schema PHYSICALLY has no person columns.
// This is a SECONDARY source grep over @mailmetero/db's migration tree — the AUTHORITATIVE
// gate is the runtime information_schema introspection in @mailmetero/db
// (assertKbHasNoPersonColumns, packages/db/test/kb-no-person-columns.test.ts). To stay in
// lockstep with that gate, this backstop imports the SAME PERSON_COLUMN_DENYLIST and
// KB_COLUMN_ALLOWLIST it uses, extracts the real column names from every `CREATE TABLE kb.*`
// block, and fails on any column that (a) matches the person-data denylist, or (b) is not in
// the conscious allowlist. role_locals.local_part / domain_patterns.pattern_token are
// intentionally allowlisted (domain-level facts, not person data). Owned by config-deploy-ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PERSON_COLUMN_DENYLIST, KB_COLUMN_ALLOWLIST } from '@mailmetero/db';

const MIGRATIONS_DIR = join(process.cwd(), 'packages/db/migrations');

// Reserved words that begin a table constraint (not a column) inside CREATE TABLE (...).
const CONSTRAINT_KEYWORDS = new Set([
  'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT', 'KEY', 'EXCLUDE', 'LIKE', 'INDEX',
]);

/** Return the balanced-paren body of the first `(...)` starting at/after `openIdx`. */
function balancedParens(sql: string, openIdx: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { body: sql.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

/** Split a CREATE TABLE body on top-level commas (ignoring commas inside nested parens). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts;
}

/** Extract every column name declared in the `CREATE TABLE kb.<t> (...)` blocks of a migration. */
function kbColumns(sql: string): { table: string; column: string }[] {
  const cols: { table: string; column: string }[] = [];
  const CREATE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?kb\.(\w+)\s*\(/gi;
  for (let m = CREATE_RE.exec(sql); m !== null; m = CREATE_RE.exec(sql)) {
    const table = m[1]!;
    const open = m.index + m[0].length - 1; // index of the '('
    const block = balancedParens(sql, open);
    if (!block) continue;
    for (const rawPart of splitTopLevel(block.body)) {
      const part = rawPart.trim();
      if (part.length === 0) continue;
      const idM = /^([a-z_][a-z0-9_]*)/i.exec(part);
      if (!idM) continue;
      const first = idM[1]!;
      if (CONSTRAINT_KEYWORDS.has(first.toUpperCase())) continue; // table constraint, not a column
      cols.push({ table, column: first.toLowerCase() });
    }
    CREATE_RE.lastIndex = block.end;
  }
  return cols;
}

test('kb.* migrations declare no person columns', async () => {
  let files: string[] = [];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.ts') || f.endsWith('.sql'));
  } catch {
    // no migrations yet — vacuously green (db domain adds them)
    return;
  }

  let sawKbColumn = false;
  const offenders: string[] = [];
  for (const f of files) {
    const body = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    for (const { table, column } of kbColumns(body)) {
      sawKbColumn = true;
      if (PERSON_COLUMN_DENYLIST.test(column)) {
        offenders.push(`${f}: kb.${table}.${column} (matches person-data denylist)`);
      } else if (!KB_COLUMN_ALLOWLIST.has(column)) {
        offenders.push(`${f}: kb.${table}.${column} (not in KB_COLUMN_ALLOWLIST)`);
      }
    }
  }

  assert.deepEqual(offenders, [], `kb.* must stay person-data-free:\n${offenders.join('\n')}`);
  // Guard against the parser silently finding nothing once migrations exist.
  if (files.some((f) => /kb/i.test(f))) {
    assert.ok(sawKbColumn, 'expected to extract at least one kb.* column from the migrations');
  }
});
