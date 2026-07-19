// Stage 8 — score, address-suppression filter, KB write-back, respond.
//
// Runs core.scoreDerivation (via the ScorerPort) over every finder candidate (or the single
// verifier address), picks the winner, then applies the finder ADDRESS-scope suppression filter on
// the CHOSEN candidate (a suppressed winner ⇒ canonical not-found, observationally identical to a
// genuine miss — D5/§7). Writes shared kb.* facts + pattern observations (D7 write-guard:
// accept-all domains never bump verified_count). Emits the result + its BillingInput. PRD §6 stage 8.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  finalizeEvidence,
  finderOk,
  verifierOk,
  notFoundFinderResult,
  notFoundVerifierResult,
} from '../stage.ts';
import type {
  Candidate,
  PatternToken,
  ReasonCode,
  Status,
  SubStatus,
  EvidenceTier,
  Backend,
  VerificationEvidence,
} from '@mailmetero/contracts';
import type { InternalFinderResult, InternalVerifierResult, ResolvedCandidate } from '../types.ts';
import type { ScoreOutput } from '../ports.ts';

function dedupe(codes: ReadonlyArray<ReasonCode>): ReasonCode[] {
  const out: ReasonCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}

function isStale(verifiedAt: string | null, staleAfterDays: number, clock: () => number): boolean {
  if (verifiedAt === null) return false;
  const parsed = Date.parse(verifiedAt);
  if (Number.isNaN(parsed)) return false;
  const ageDays = (clock() - parsed) / 86_400_000;
  return ageDays > staleAfterDays;
}

async function writeBack(ctx: StageContext, patternToken: PatternToken, verified: boolean): Promise<void> {
  const mx = ctx.state.mx;
  const fp = ctx.state.fingerprint;
  const acceptAllDomain = ctx.state.isCatchAll === true;
  try {
    if (mx !== null && fp !== null && mx.mx !== 'NULL_MX' && mx.mx !== 'NO_MAIL_HOST') {
      await ctx.deps.kbWriteback.upsertDomainFacts({
        domain: ctx.domainInput.domain,
        mx: mx.mx,
        provider: fp.provider,
        verifiabilityClass: fp.verifiabilityClass,
        isCatchAll: ctx.state.isCatchAll,
        spfPresent: mx.spfPresent,
        dmarcPresent: mx.dmarcPresent,
        probedAt: mx.resolvedAt,
      });
    }
    await ctx.deps.kbWriteback.recordPatternObservation({
      domain: ctx.domainInput.domain,
      pattern: patternToken,
      verified,
      acceptAllDomain,
    });
  } catch {
    // Write-back is best-effort provenance; never fail the request on a KB write error.
  }
}

export function makeScoreWritebackStage(): Stage {
  return {
    id: 'score_and_writeback',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      return ctx.mode === 'finder' ? runFinder(ctx) : runVerifier(ctx);
    },
  };
}

async function runFinder(ctx: StageContext): Promise<StageDecision> {
  const cands = ctx.state.candidates;
  if (cands.length === 0) {
    return finderOk(notFoundFinderResult(ctx));
  }

  const evidence: VerificationEvidence = finalizeEvidence('score_and_writeback', ctx.state);
  const degraded = ctx.state.evidence.tier === 'degraded';

  const scored = cands.map((c) => {
    const support = ctx.state.patternSupport.find((o) => o.patternToken === c.patternToken) ?? null;
    const verify = ctx.state.verifyOutcomes.get(c.email) ?? null;
    const out: ScoreOutput = ctx.deps.scorer.score({
      candidate: c,
      evidence,
      domainSupport: support,
      sizeBracket: ctx.domainInput.sizeBracket,
      verify,
      config: ctx.deps.scoringConfig,
    });
    const candidate: Candidate = {
      ...c,
      score: out.score,
      reasonCodes: dedupe([...c.reasonCodes, ...out.reasonCodes]),
    };
    return { candidate, out };
  });
  scored.sort((a, b) => b.out.score - a.out.score);

  const best = scored[0]!;

  // Finder ADDRESS-scope suppression filter on the chosen candidate.
  const suppressed = await ctx.deps.suppression.isSuppressed([best.candidate.email]);
  if (suppressed) {
    return finderOk(notFoundFinderResult(ctx));
  }

  const status: Status = best.out.status;
  const evidenceTier: EvidenceTier = degraded ? 'degraded' : best.out.evidenceTier;
  const backend: Backend = degraded ? 'none' : evidence.backend;
  let subStatus: SubStatus | null = best.out.subStatus;
  let reasonCodes = best.candidate.reasonCodes;
  if (degraded) {
    subStatus = 'backend_unavailable';
    reasonCodes = dedupe([...reasonCodes, 'backend_degraded']);
  }

  await writeBack(ctx, best.candidate.patternToken, status === 'valid');

  const chosen: ResolvedCandidate = {
    email: best.candidate.email,
    score: best.out.score,
    status,
    reasonCodes,
    collisionRisk: best.candidate.collisionRisk,
  };

  const result: InternalFinderResult = {
    email: best.candidate.email,
    score: best.out.score,
    status,
    subStatus,
    domain: ctx.domainInput.domain,
    firstName: ctx.name?.firstName ?? null,
    lastName: ctx.name?.lastName ?? null,
    reasonCodes,
    provider: evidence.provider,
    backend,
    evidence: evidenceTier,
    collisionRisk: best.candidate.collisionRisk,
    chosen,
    candidates: scored.map((s) => s.candidate),
    verification: {
      ...evidence,
      tier: evidenceTier,
      backend,
      capsApplied: best.out.capsApplied,
      stale: isStale(evidence.verifiedAt, ctx.deps.scoringConfig.caps.STALE_AFTER_DAYS, ctx.deps.clock),
    },
  };

  return finderOk(result);
}

async function runVerifier(ctx: StageContext): Promise<StageDecision> {
  const email = ctx.email;
  const localPart = ctx.localPart;
  if (email === undefined || localPart === undefined) {
    return verifierOk(notFoundVerifierResult(ctx));
  }

  const evidence: VerificationEvidence = finalizeEvidence('score_and_writeback', ctx.state);
  const degraded = ctx.state.evidence.tier === 'degraded';

  const candidate: Candidate = {
    email,
    localPart,
    patternToken: '{local}' as PatternToken,
    score: 0,
    reasonCodes: [],
    collisionRisk: false,
  };
  const verify = ctx.state.verifyOutcomes.get(email) ?? null;
  const out: ScoreOutput = ctx.deps.scorer.score({
    candidate,
    evidence,
    domainSupport: null,
    sizeBracket: ctx.domainInput.sizeBracket,
    verify,
    config: ctx.deps.scoringConfig,
  });

  const status: Status = out.status;
  const evidenceTier: EvidenceTier = degraded ? 'degraded' : out.evidenceTier;
  const backend: Backend = degraded ? 'none' : evidence.backend;
  let subStatus: SubStatus | null = out.subStatus;
  let reasonCodes = dedupe(out.reasonCodes);
  if (degraded) {
    subStatus = 'backend_unavailable';
    reasonCodes = dedupe([...reasonCodes, 'backend_degraded']);
  }

  await writeBack(ctx, candidate.patternToken, status === 'valid');

  const hasMailHost =
    ctx.state.mx !== null && (ctx.state.mx.mx === 'EXPLICIT_MX' || ctx.state.mx.mx === 'IMPLICIT_MX_FALLBACK');

  const result: InternalVerifierResult = {
    email,
    status,
    score: out.score,
    subStatus,
    acceptAll: status === 'accept_all' || ctx.state.isCatchAll === true,
    disposable: false,
    webmail: false,
    mxRecords: hasMailHost,
    smtpCheck: verify !== null && backend === 'api',
    reasonCodes,
    provider: evidence.provider,
    backend,
    evidence: evidenceTier,
    rawSmtpCode: evidence.rawSmtpCode,
    verification: {
      ...evidence,
      tier: evidenceTier,
      backend,
      capsApplied: out.capsApplied,
      stale: isStale(evidence.verifiedAt, ctx.deps.scoringConfig.caps.STALE_AFTER_DAYS, ctx.deps.clock),
    },
  };

  return verifierOk(result);
}
