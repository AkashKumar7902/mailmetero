// CI invariant (§9.1): the §6 dependency DAG is intact. dependency-cruiser blocks
// cycles; this test asserts every observed @mailmetero/* import edge is in the ALLOWED
// allow-list (the §6 depends_on table) — catching an *added but permitted-by-pattern*
// edge that the coarse cruiser rule would miss. Owned by config-deploy-ops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ALLOWED } = require(join(process.cwd(), 'tools/ci/allowed-edges.cjs')) as {
  ALLOWED: Record<string, string[]>;
};

const PKGS = join(process.cwd(), 'packages');
const IMPORT_RE = /from\s+['"]@mailmetero\/([a-z]+)['"]/g;

async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') yield* tsFiles(p); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p;
  }
}

test('every cross-package import is an allowed §6 edge', async () => {
  const violations: string[] = [];
  for await (const file of tsFiles(PKGS)) {
    const pkg = file.slice(PKGS.length + 1).split('/')[0]!;
    const body = await readFile(file, 'utf8');
    for (const m of body.matchAll(IMPORT_RE)) {
      const dep = m[1]!;
      if (dep === pkg) continue;
      if (!(ALLOWED[pkg] ?? []).includes(dep)) {
        violations.push(`${pkg} → ${dep}  (${file})`);
      }
    }
  }
  assert.deepEqual([...new Set(violations)], [], `disallowed §6 edges:\n${violations.join('\n')}`);
});
