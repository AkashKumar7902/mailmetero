// Stage 2 — freemail / disposable / role classification (FREE terminal statuses).
//
// Uses the injected ClassificationPort (live KB tables) but honours the flags api already computed
// on DomainInput. Finder: freemail ⇒ 'webmail', disposable ⇒ 'disposable' (never a derivation
// target). Verifier: same, plus role-account detection on the local part. PRD §6 stage 2.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
  finderOk,
  verifierOk,
  finderTerminal,
  verifierTerminal,
} from '../stage.ts';

export function makeClassificationStage(): Stage {
  return {
    id: 'classification_tables',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const domain = ctx.domainInput.domain;
      const isFreemail = ctx.domainInput.isFreemail || (await ctx.deps.classification.isFreemail(domain));
      const isDisposable =
        ctx.domainInput.isDisposable || (await ctx.deps.classification.isDisposable(domain));

      if (ctx.mode === 'finder') {
        if (isDisposable) {
          return finderOk(
            finderTerminal(ctx, 'classification_tables', {
              email: null,
              status: 'disposable',
              subStatus: null,
              score: 0,
              reasonCodes: ['disposable_domain'],
              evidence: 'classifier',
            }),
          );
        }
        if (isFreemail) {
          return finderOk(
            finderTerminal(ctx, 'classification_tables', {
              email: null,
              status: 'webmail',
              subStatus: null,
              score: 0,
              reasonCodes: ['freemail_domain'],
              evidence: 'classifier',
            }),
          );
        }
        return CONTINUE;
      }

      // verifier
      if (isDisposable) {
        return verifierOk(
          verifierTerminal(ctx, 'classification_tables', {
            status: 'disposable',
            subStatus: null,
            score: 0,
            reasonCodes: ['disposable_domain'],
            evidence: 'classifier',
            disposable: true,
          }),
        );
      }
      if (isFreemail) {
        return verifierOk(
          verifierTerminal(ctx, 'classification_tables', {
            status: 'webmail',
            subStatus: null,
            score: 0,
            reasonCodes: ['freemail_domain'],
            evidence: 'classifier',
            webmail: true,
          }),
        );
      }
      if (ctx.localPart !== undefined && (await ctx.deps.classification.isRoleLocal(ctx.localPart))) {
        return verifierOk(
          verifierTerminal(ctx, 'classification_tables', {
            status: 'role',
            subStatus: null,
            score: 0,
            reasonCodes: ['role_account'],
            evidence: 'classifier',
          }),
        );
      }
      return CONTINUE;
    },
  };
}
