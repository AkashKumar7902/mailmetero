// Stage 7 — the paid VerifierBackend call (the only stage that can cost money).
//
// Short-circuit (NO spend): microsoft365 (UNVERIFIABLE), gmail/yahoo consumer (UNKNOWN), and known
// catch-all domains are decided by scoring caps, never a paid check (D10). Google Workspace
// (VERIFIABLE_WITH_CATCHALL_GUARD) runs the catch-all probe first. Finder verifies only the top
// caps.VERIFY_TOP_N candidates. Budget-exceeded ⇒ finder degrades to backend=none; verifier defers
// to a 202 async job. An injected NullBackend (kill switch / spend cap) ⇒ degrade. PRD §6 stage 7.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
} from '../stage.ts';
import type {
  VerifyContext,
  VerifiabilityClass,
  MxEnum,
  IsoTimestamp,
} from '@mailmetero/contracts';

const VERIFIABLE: ReadonlySet<VerifiabilityClass> = new Set<VerifiabilityClass>([
  'VERIFIABLE_WITH_CATCHALL_GUARD',
  'VERIFIABLE_GREYLIST_RETRY',
  'GATEWAY_CONFIG_DEPENDENT',
]);

function markDegraded(ctx: StageContext): void {
  ctx.state.evidence.tier = 'degraded';
  ctx.state.evidence.backend = 'none';
}

function nowIso(ctx: StageContext): IsoTimestamp {
  return new Date(ctx.deps.clock()).toISOString() as IsoTimestamp;
}

export function makeVerifierBackendStage(): Stage {
  return {
    id: 'verifier_backend',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const provider = ctx.state.evidence.provider ?? null;
      const vClass = ctx.state.evidence.verifiabilityClass ?? null;
      const isM365 = provider === 'microsoft365';
      const isCatchAll = ctx.state.isCatchAll === true;

      // D10 short-circuit: no paid verify. Scoring caps produce a capped accept_all / unknown.
      const skipPaidVerify =
        isM365 || isCatchAll || vClass === null || !VERIFIABLE.has(vClass);
      if (skipPaidVerify) {
        return CONTINUE;
      }

      // Budget gate.
      if (ctx.budget.expired(ctx.deps.clock)) {
        if (ctx.mode === 'verifier') {
          return { kind: 'terminal', output: { kind: 'deferred' } };
        }
        markDegraded(ctx);
        return CONTINUE;
      }

      // Injected NullBackend (kill switch / spend cap) ⇒ degrade, don't pretend to verify.
      if (ctx.deps.backend.kind === 'none') {
        markDegraded(ctx);
        return CONTINUE;
      }

      // skipPaidVerify already returned when vClass is null; narrow for the type-checker.
      if (vClass === null) {
        markDegraded(ctx);
        return CONTINUE;
      }

      const vctx: VerifyContext = {
        domain: ctx.domainInput.domain,
        mx: (ctx.state.mx?.mx ?? 'EXPLICIT_MX') as MxEnum,
        provider,
        verifiabilityClass: vClass,
        isCatchAll: ctx.state.isCatchAll,
      };

      // Catch-all guard for Google Workspace: probe a random local first.
      if (vClass === 'VERIFIABLE_WITH_CATCHALL_GUARD') {
        const verdict = await ctx.deps.catchAllProbe.probe(ctx.domainInput.domain, vctx);
        if (verdict.isCatchAll) {
          ctx.state.isCatchAll = true;
          ctx.state.evidence.isCatchAll = true;
          ctx.state.evidence.rawSmtpCode = verdict.rawSmtpCode;
          return CONTINUE; // accept_all capped by scoring; no per-address verify
        }
      }

      const targets =
        ctx.mode === 'finder'
          ? ctx.state.candidates.slice(0, Math.max(1, ctx.deps.scoringConfig.caps.VERIFY_TOP_N))
          : ctx.email !== undefined
            ? [{ email: ctx.email }]
            : [];

      let verifiedAny = false;
      for (const target of targets) {
        if (ctx.budget.expired(ctx.deps.clock)) break;
        const outcome = await ctx.deps.backend.verify(target.email, vctx);
        ctx.state.verifyOutcomes.set(target.email, outcome);
        verifiedAny = true;
        ctx.state.evidence.rawSmtpCode = outcome.rawSmtpCode ?? null;
        ctx.state.evidence.enhancedCode = outcome.enhancedCode ?? null;
      }

      if (verifiedAny) {
        ctx.state.evidence.backend = ctx.deps.backend.kind;
        ctx.state.evidence.verifiedAt = nowIso(ctx);
      } else if (ctx.mode === 'verifier' && ctx.budget.expired(ctx.deps.clock)) {
        return { kind: 'terminal', output: { kind: 'deferred' } };
      } else {
        markDegraded(ctx);
      }

      return CONTINUE;
    },
  };
}
