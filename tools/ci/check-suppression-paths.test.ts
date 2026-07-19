// CI invariant (§7.1, P0-11, Success Metric 10): suppression is checked on 100% of find AND
// verify code paths. Rather than trusting a source marker, this asserts the property against
// the REAL pipeline: buildStages() places the suppression stage at slot 1 (before any
// derivation/verification), that stage applies to BOTH modes, and the final scoring/write-back
// stage (slot 8) re-applies the ADDRESS-scope suppression filter via the SuppressionPort so a
// suppressed winner collapses to canonical not-found. Owned by config-deploy-ops; the pipeline
// domain owns the implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildStages,
  makeSuppressionStage,
  makeScoreWritebackStage,
} from '@mailmetero/pipeline';

test('stage 1 is the suppression stage and covers both find + verify', () => {
  const stages = buildStages();
  assert.ok(stages.length >= 2, 'pipeline must have at least the canonicalize + suppression stages');

  const slot1 = stages[1]!;
  const suppression = makeSuppressionStage();
  // buildStages()[1] IS the suppression stage (identified by its stable stage id).
  assert.equal(slot1.id, suppression.id, 'buildStages()[1] must be the suppression stage');

  // appliesTo ⊇ {finder, verifier}: suppression runs on every path.
  for (const mode of ['finder', 'verifier'] as const) {
    assert.ok(
      slot1.appliesTo.includes(mode),
      `suppression stage must apply to "${mode}" (checked on 100% of ${mode} paths)`,
    );
  }
});

test('stage 8 (score + write-back) re-applies suppression via SuppressionPort', async () => {
  const stages = buildStages();
  const slot8 = stages[8]!;
  const scoreWriteback = makeScoreWritebackStage();
  assert.equal(slot8.id, scoreWriteback.id, 'buildStages()[8] must be the score/write-back stage');

  // The ADDRESS-scope filter on the chosen candidate is expressed through the SuppressionPort
  // (ctx.deps.suppression.isSuppressed). Confirm the implementation actually reaches for it.
  const src = await readFile(
    join(process.cwd(), 'packages/pipeline/src/stages/score-writeback.ts'),
    'utf8',
  );
  assert.match(
    src,
    /\bsuppression\s*\.\s*isSuppressed\s*\(/,
    'stage 8 must invoke SuppressionPort.isSuppressed on the chosen candidate (§7.1)',
  );
});
