// CI invariant (D5, §7 privacy, §9.3): no Status/SubStatus/ReasonCode/ErrorCode member
// may reveal suppression. A suppressed subject must be observationally identical to
// not-found. Greps the contracts registries for any suppression-revealing token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CONTRACTS_SRC = join(process.cwd(), 'packages/contracts/src');
const LEAK = /\b(suppress|suppressed|objection|objected|blocked_contact|opt_?out|erasure|do_not_contact)\b/i;

test('contracts enums/registries contain no suppression-revealing member', async () => {
  const files = (await readdir(CONTRACTS_SRC)).filter((f) => f.endsWith('.ts'));
  const offenders: string[] = [];
  for (const f of files) {
    const lines = (await readFile(join(CONTRACTS_SRC, f), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      // only inspect string-literal members (the wire/enum values), not comments
      const stripped = line.replace(/\/\/.*$/, '');
      for (const lit of stripped.match(/'[^']*'/g) ?? []) {
        if (LEAK.test(lit)) offenders.push(`${f}:${i + 1}  ${lit}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `suppression leak in contracts:\n${offenders.join('\n')}`);
});
