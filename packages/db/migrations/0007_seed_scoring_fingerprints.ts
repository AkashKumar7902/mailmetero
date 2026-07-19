// 0007 — data seed: scoring config (active), pattern priors, provider fingerprints, role
// locals, typo domains. Idempotent (all upserts). Delegates to seedScoringAndFingerprints so
// the seed logic has ONE home reused by tests.

import type { MigrationBuilder } from 'node-pg-migrate';
import type { Queryable } from '../src/client.ts';
import { seedScoringAndFingerprints } from '../src/seed/seed-scoring.ts';

/** Adapt the node-pg-migrate DB handle to the repo `Queryable` surface. */
function asQueryable(pgm: MigrationBuilder): Queryable {
  return { query: (text: unknown, params?: unknown) => pgm.db.query(text as string, params as unknown[]) } as Queryable;
}

export const up = async (pgm: MigrationBuilder): Promise<void> => {
  await seedScoringAndFingerprints(asQueryable(pgm));
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DELETE FROM kb.typo_domains;
    DELETE FROM kb.role_locals;
    DELETE FROM kb.provider_fingerprints;
    DELETE FROM kb.pattern_priors;
    DELETE FROM kb.blend_weights;
  `);
};
