// @mailmetero/pipeline — the cheapest-first orchestrator.
//
// buildStages() returns the 9 stages in order 0..8 with buildStages()[1] === the suppression stage
// (CI-checked). createPipeline wires them into { find, verify }. Finder candidate generation is
// injected by the orchestrator AFTER stage 3 (tenant cache) and BEFORE stage 4 (kb facts), per the
// reconciled placement (ARCHITECTURE §3.1). MODULE_CONTRACTS §7.3.

import type {
  TenantId,
  RequestId,
  EmailAddress,
  LocalPart,
  NameInput,
  DomainInput,
} from '@mailmetero/contracts';
import { createBudget, type Budget } from './budget.ts';
import {
  type Stage,
  type StageContext,
  type PipelineDeps,
  initialStageState,
  finderOutput,
  notFoundFinderResult,
} from './stage.ts';
import type {
  PipelineMode,
  PipelineFinderOutput,
  PipelineVerifierOutput,
} from './types.ts';
import type { ResultCacheKey } from './ports.ts';
import { makeCanonicalizeSyntaxStage } from './stages/canonicalize-syntax.ts';
import { makeSuppressionStage } from './stages/suppression.ts';
import { makeClassificationStage } from './stages/classification.ts';
import { makeTenantCacheStage } from './stages/tenant-cache.ts';
import { makeKbFactsStage } from './stages/kb-facts.ts';
import { makeDnsEnumStage } from './stages/dns-enum.ts';
import { makeProviderFingerprintStage } from './stages/provider-fingerprint.ts';
import { makeVerifierBackendStage } from './stages/verifier-backend.ts';
import { makeScoreWritebackStage } from './stages/score-writeback.ts';

export interface FinderRequest {
  tenantId: TenantId;
  requestId: RequestId;
  name: NameInput;
  domain: DomainInput;
  cacheKey: ResultCacheKey;
  maxDurationMs?: number;
}

export interface VerifierRequest {
  tenantId: TenantId;
  requestId: RequestId;
  email: EmailAddress;
  domain: DomainInput;
  cacheKey: ResultCacheKey;
  budgetMs?: number;
}

export interface Pipeline {
  find(req: FinderRequest): Promise<PipelineFinderOutput>;
  verify(req: VerifierRequest): Promise<PipelineVerifierOutput>;
}

/** Ordered stages 0..8. buildStages()[1] is ALWAYS the suppression stage (appliesTo both modes). */
export function buildStages(): Stage[] {
  return [
    makeCanonicalizeSyntaxStage(), // 0
    makeSuppressionStage(), // 1
    makeClassificationStage(), // 2
    makeTenantCacheStage(), // 3
    makeKbFactsStage(), // 4
    makeDnsEnumStage(), // 5
    makeProviderFingerprintStage(), // 6
    makeVerifierBackendStage(), // 7
    makeScoreWritebackStage(), // 8
  ];
}

function localPartOf(email: EmailAddress): LocalPart {
  const at = email.lastIndexOf('@');
  return (at > 0 ? email.slice(0, at) : email) as LocalPart;
}

async function runStages(stages: Stage[], ctx: StageContext, mode: PipelineMode): Promise<PipelineFinderOutput | PipelineVerifierOutput | null> {
  for (const stage of stages) {
    if (!stage.appliesTo.includes(mode)) continue;

    // Finder candidate generation: after stage 3 (tenant cache), before stage 4 (kb facts).
    if (mode === 'finder' && stage.id === 'kb_domain_facts' && ctx.state.candidates.length === 0 && ctx.name !== undefined) {
      ctx.state.patternSupport = await ctx.deps.kbFacts.getDomainPatterns(ctx.domainInput.domain);
      ctx.state.candidates = ctx.deps.candidates.generate(
        ctx.name,
        ctx.domainInput,
        ctx.state.patternSupport.length > 0 ? ctx.state.patternSupport : null,
      );

      // B2 (PRD §7.1 P0): address-scope suppression MUST be honored BEFORE stage 7 (the paid
      // third-party verify). Finder stage-1 checks DOMAIN scope only; without this, an
      // address-suppressed candidate would be SMTP-probed by the subprocessor before the stage-8
      // address filter runs. Batch every generated candidate's ADDRESS hash through a single
      // isSuppressed call. The port is non-revealing (boolean OR over the batch, D5), so a positive
      // means at least one candidate is suppressed but not which — we conservatively return the
      // canonical not-found shape rather than risk probing a suppressed address. No candidate ever
      // reaches ctx.deps.backend.verify once any of them is suppressed.
      if (ctx.state.candidates.length > 0) {
        const addressValues: string[] = ctx.state.candidates.map((c) => c.email);
        const suppressed = await ctx.deps.suppression.isSuppressed(addressValues);
        if (suppressed) {
          return finderOutput(notFoundFinderResult(ctx));
        }
      }
    }

    const decision = await stage.run(ctx);
    if (decision.kind === 'terminal') return decision.output;
  }
  return null;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const stages = buildStages();
  const caps = deps.scoringConfig.caps;

  return {
    async find(req: FinderRequest): Promise<PipelineFinderOutput> {
      const budget: Budget = createBudget(deps.clock, caps.FINDER_BUDGET_MS, req.maxDurationMs);
      const ctx: StageContext = {
        mode: 'finder',
        tenantId: req.tenantId,
        requestId: req.requestId,
        deps,
        budget,
        cacheKey: req.cacheKey,
        name: req.name,
        domainInput: req.domain,
        state: initialStageState(),
      };
      try {
        const out = (await runStages(stages, ctx, 'finder')) as PipelineFinderOutput | null;
        return out ?? { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async verify(req: VerifierRequest): Promise<PipelineVerifierOutput> {
      const budget: Budget = createBudget(deps.clock, caps.SYNC_VERIFY_BUDGET_MS, req.budgetMs);
      const ctx: StageContext = {
        mode: 'verifier',
        tenantId: req.tenantId,
        requestId: req.requestId,
        deps,
        budget,
        cacheKey: req.cacheKey,
        domainInput: req.domain,
        email: req.email,
        localPart: localPartOf(req.email),
        state: initialStageState(),
      };
      try {
        const out = (await runStages(stages, ctx, 'verifier')) as PipelineVerifierOutput | null;
        return out ?? { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
