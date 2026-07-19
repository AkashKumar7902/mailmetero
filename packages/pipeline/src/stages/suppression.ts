// Stage 1 — GLOBAL suppression check (salted hash), on EVERY find/verify path (D5/§7).
//
// buildStages()[1] MUST be this stage with appliesTo ⊇ {finder, verifier} (CI-checked). Finder
// checks DOMAIN scope here (per-address is filtered again in stage 8 on the chosen candidate);
// verifier checks BOTH address and domain scope. A suppressed subject returns the canonical
// not-found shape — observationally identical to a genuine no-result. No status/reason reveals it.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
  finderOk,
  verifierOk,
  notFoundFinderResult,
  notFoundVerifierResult,
} from '../stage.ts';

export function makeSuppressionStage(): Stage {
  return {
    id: 'suppression_check',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const values: string[] = [ctx.domainInput.domain];
      if (ctx.mode === 'verifier' && ctx.email !== undefined) {
        values.push(ctx.email);
      }
      const suppressed = await ctx.deps.suppression.isSuppressed(values);
      if (!suppressed) return CONTINUE;
      return ctx.mode === 'finder'
        ? finderOk(notFoundFinderResult(ctx))
        : verifierOk(notFoundVerifierResult(ctx));
    },
  };
}
