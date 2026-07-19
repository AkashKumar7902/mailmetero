// @mailmetero/pipeline — the core adapter.
//
// Binds the pure @mailmetero/core engine to the pipeline ports: injects the size-conditioned
// prior table + live ScoringConfig into candidate generation, and decomposes the pipeline's
// VerificationEvidence into core.ScoreDerivationInput for scoring. The scorer NARROWS status to
// VerifyVerdict (the derivation path never returns a classification/DNS terminal — those are set
// by pipeline stages). MODULE_CONTRACTS §7.3 `createCoreAdapter`.

import {
  generateCandidates,
  scoreDerivation,
  type PatternPriorTable,
  type DomainPatternSupport,
} from '@mailmetero/core';
import type {
  ScoringConfig,
  DomainPatternObservation,
  PatternToken,
  MxEnum,
} from '@mailmetero/contracts';
import type {
  CandidateGeneratorPort,
  ScorerPort,
  ScoreInput,
  ScoreOutput,
} from './ports.ts';

function toSupportMap(observations: DomainPatternObservation[] | null): DomainPatternSupport | null {
  if (observations === null || observations.length === 0) return null;
  const map = new Map<PatternToken, DomainPatternObservation>();
  for (const obs of observations) map.set(obs.patternToken, obs);
  return map;
}

function priorWeightOf(candidate: ScoreInput['candidate']): number {
  // core.generateCandidates already baked the size-prior into candidate.score (0–100).
  // scoreDerivation re-blends from a normalized [0,1] prior weight.
  const w = candidate.score / 100;
  if (Number.isNaN(w)) return 0;
  return Math.min(1, Math.max(0, w));
}

/**
 * Build the two core-bound ports. `priors` and `config` are captured once (assembled at boot
 * from the live DB tables, D8) so the stages never thread them through.
 */
export function createCoreAdapter(deps: {
  priors: PatternPriorTable;
  config: ScoringConfig;
}): { candidates: CandidateGeneratorPort; scorer: ScorerPort } {
  const { priors, config } = deps;

  const candidates: CandidateGeneratorPort = {
    generate(name, domain, domainSupport) {
      const support = toSupportMap(domainSupport);
      return generateCandidates({
        name,
        domain,
        priors,
        config,
        ...(support !== null ? { domainSupport: support } : {}),
      });
    },
  };

  const scorer: ScorerPort = {
    score(input: ScoreInput): ScoreOutput {
      const ev = input.evidence;
      const mx: MxEnum = ev.mx ?? 'EXPLICIT_MX';
      const scored = scoreDerivation({
        candidate: input.candidate,
        priorWeight: priorWeightOf(input.candidate),
        verifiedCount: input.domainSupport?.verifiedCount ?? 0,
        observedCount: input.domainSupport?.observedCount ?? 0,
        sizeBracket: input.sizeBracket,
        provider: ev.provider,
        mx,
        verifiabilityClass: ev.verifiabilityClass,
        isCatchAll: ev.isCatchAll,
        verify: input.verify,
        recencyAgeDays: null,
        backend: ev.backend,
        isNicknameVariant: input.candidate.reasonCodes.includes('nickname_variant'),
        isCjk: input.candidate.reasonCodes.includes('cjk_ambiguous_downweight'),
        config: input.config,
      });
      return {
        score: scored.score,
        status: scored.status,
        subStatus: scored.subStatus,
        reasonCodes: scored.reasonCodes,
        evidenceTier: scored.evidence,
        capsApplied: scored.capsApplied,
      };
    },
  };

  return { candidates, scorer };
}
