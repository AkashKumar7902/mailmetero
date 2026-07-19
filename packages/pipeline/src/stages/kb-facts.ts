// Stage 4 — shared KB domain facts (FREE).
//
// Loads domain-level facts + learned pattern support from the shared KB (NO person data — D7).
// A cached NULL_MX / NO_MAIL_HOST short-circuits to a definitive `invalid` (still billable — it is
// a DNS-grade verdict). A known catch-all / M365 domain seeds state so stage 7 skips the paid
// verify entirely (D10). Candidate generation for the finder already ran (orchestrator, before this
// stage). PRD §6 stage 4.

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

export function makeKbFactsStage(): Stage {
  return {
    id: 'kb_domain_facts',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const domain = ctx.domainInput.domain;
      const facts = await ctx.deps.kbFacts.getDomainFacts(domain);
      ctx.state.domainFacts = facts;
      // Finder pre-loads pattern support for candidate generation (orchestrator); avoid re-fetching.
      if (ctx.state.patternSupport.length === 0) {
        ctx.state.patternSupport = await ctx.deps.kbFacts.getDomainPatterns(domain);
      }

      if (facts !== null) {
        ctx.state.isCatchAll = facts.isCatchAll;
        ctx.state.evidence.provider = facts.provider;
        ctx.state.evidence.verifiabilityClass = facts.verifiabilityClass;
        ctx.state.evidence.isCatchAll = facts.isCatchAll;
        if (facts.mx !== null) ctx.state.evidence.mx = facts.mx;

        if (facts.ttlFresh && facts.mx === 'NULL_MX') {
          return terminalNullMx(ctx);
        }
        if (facts.ttlFresh && facts.mx === 'NO_MAIL_HOST') {
          return terminalNoMailHost(ctx);
        }
      }
      return CONTINUE;
    },
  };
}

function terminalNullMx(ctx: StageContext): StageDecision {
  if (ctx.mode === 'finder') {
    const top = ctx.state.candidates[0]?.email ?? null;
    return finderOk(
      finderTerminal(ctx, 'kb_domain_facts', {
        email: top,
        status: 'invalid',
        subStatus: 'null_mx',
        score: 0,
        reasonCodes: ['dns_null_mx'],
        evidence: 'dns',
      }),
    );
  }
  return verifierOk(
    verifierTerminal(ctx, 'kb_domain_facts', {
      status: 'invalid',
      subStatus: 'null_mx',
      score: 0,
      reasonCodes: ['dns_null_mx'],
      evidence: 'dns',
      mxRecords: false,
    }),
  );
}

function terminalNoMailHost(ctx: StageContext): StageDecision {
  if (ctx.mode === 'finder') {
    const top = ctx.state.candidates[0]?.email ?? null;
    return finderOk(
      finderTerminal(ctx, 'kb_domain_facts', {
        email: top,
        status: 'invalid',
        subStatus: 'no_mail_host',
        score: 0,
        reasonCodes: ['dns_no_mail_host'],
        evidence: 'dns',
      }),
    );
  }
  return verifierOk(
    verifierTerminal(ctx, 'kb_domain_facts', {
      status: 'invalid',
      subStatus: 'no_mail_host',
      score: 0,
      reasonCodes: ['dns_no_mail_host'],
      evidence: 'dns',
      mxRecords: false,
    }),
  );
}
