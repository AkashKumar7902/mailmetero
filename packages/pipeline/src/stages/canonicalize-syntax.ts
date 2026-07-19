// Stage 0 — canonicalize + syntax (+ typo-domain correction happens upstream in api/core).
//
// Finder inputs (NameInput/DomainInput) are already canonicalized by api before pipeline.find,
// so this is a guard/no-op there. For the verifier it re-validates the address syntax as a
// defensive terminal (invalid/invalid_syntax is FREE, unbilled). PRD §6 stage 0.

import { validateEmailSyntax } from '@mailmetero/core';
import { type Stage, type StageContext, type StageDecision, BOTH_MODES, CONTINUE, verifierOk, verifierTerminal } from '../stage.ts';

export function makeCanonicalizeSyntaxStage(): Stage {
  return {
    id: 'canonicalize_syntax',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      if (ctx.mode === 'verifier' && ctx.email !== undefined) {
        const verdict = validateEmailSyntax(ctx.email);
        if (!verdict.ok) {
          return verifierOk(
            verifierTerminal(ctx, 'canonicalize_syntax', {
              status: 'invalid',
              subStatus: 'invalid_syntax',
              score: 0,
              reasonCodes: ['invalid_syntax'],
              evidence: 'syntax',
              backend: 'none',
            }),
          );
        }
      }
      return CONTINUE;
    },
  };
}
