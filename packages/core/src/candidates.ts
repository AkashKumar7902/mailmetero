// @mailmetero/core — candidates.ts
//
// Candidate address generation: renders pattern tokens over the normalized name (plus its
// nickname / surname / German variants) at a domain, scores each with a preliminary blend,
// and — for collision-prone (name, domain) pairs — emits BOTH a middle-initial and a
// numeric-suffix candidate at EQUAL weight with `collision_risk` set (D9). The list is
// deduplicated, ranked, and clamped to caps.MAX_CANDIDATES.

import type {
  Candidate,
  DomainInput,
  DomainPatternObservation,
  EmailAddress,
  LocalPart,
  NameInput,
  PatternToken,
  ReasonCode,
  ScoringConfig,
  SizeBracket,
} from '@mailmetero/contracts';
import { canonicalizeEmail, canonicalizeLocalPart } from './canonicalize.ts';
import { renderPattern } from './patterns.ts';
import type { PatternVars } from './patterns.ts';
import { germanFoldVariants } from './name/german.ts';
import { blendScore } from './scoring/blend.ts';

export interface PatternPrior {
  token: PatternToken;
  weight: number;
}
export type PatternPriorTable = Readonly<Record<SizeBracket, readonly PatternPrior[]>>;
export type DomainPatternSupport = ReadonlyMap<PatternToken, DomainPatternObservation>;

export interface CollisionPolicy {
  emitOnMiddleName: boolean;
  emitOnLargeCompany: boolean;
  numericSuffixes: readonly number[];
  middleInitialTokens: readonly PatternToken[];
}

export const DEFAULT_COLLISION_POLICY: Readonly<CollisionPolicy> = Object.freeze({
  emitOnMiddleName: true,
  emitOnLargeCompany: true,
  numericSuffixes: [1, 2] as readonly number[],
  middleInitialTokens: ['{first}.{m}.{last}' as PatternToken, '{f}{m}{last}' as PatternToken],
});

export interface GenerateCandidatesInput {
  name: NameInput;
  domain: DomainInput;
  priors: PatternPriorTable;
  config: ScoringConfig;
  domainSupport?: DomainPatternSupport | null;
  fallbackBracket?: SizeBracket;
  collisionPolicy?: CollisionPolicy;
}

const LARGE_BRACKETS: ReadonlySet<SizeBracket> = new Set<SizeBracket>(['large', 'enterprise']);

function priorReason(bracket: SizeBracket | null, bracketKnown: boolean): ReasonCode {
  if (!bracketKnown) return 'pattern_prior_unknown_size';
  switch (bracket) {
    case 'micro':
      return 'pattern_prior_micro_company';
    case 'small':
      return 'pattern_prior_small_company';
    case 'medium':
      return 'pattern_prior_midsize_company';
    case 'large':
    case 'enterprise':
      return 'pattern_prior_enterprise';
    default:
      return 'pattern_prior_unknown_size';
  }
}

/** Decide whether a (name, domain) pair warrants the dual collision candidates (D9). */
export function shouldEmitCollisionCandidates(
  name: NameInput,
  domain: DomainInput,
  policy: CollisionPolicy = DEFAULT_COLLISION_POLICY,
): boolean {
  if (policy.emitOnMiddleName && name.normalized.middleName !== null) return true;
  if (policy.emitOnLargeCompany && domain.sizeBracket !== null && LARGE_BRACKETS.has(domain.sizeBracket)) {
    return true;
  }
  return false;
}

interface FirstToken {
  value: string;
  isNickname: boolean;
}
interface LastToken {
  value: string;
  isSurnameVariant: boolean;
  isGermanVariant: boolean;
}

function buildVars(first: string | null, last: string | null, middle: string | null): PatternVars {
  return {
    first,
    last,
    middle,
    f: first !== null && first.length > 0 ? first.charAt(0) : null,
    l: last !== null && last.length > 0 ? last.charAt(0) : null,
    m: middle !== null && middle.length > 0 ? middle.charAt(0) : null,
  };
}

interface Draft {
  email: EmailAddress;
  localPart: LocalPart;
  patternToken: PatternToken;
  score: number;
  reasonCodes: ReasonCode[];
  collisionRisk: boolean;
}

/**
 * Generate ranked candidate addresses. Returns at most `config.caps.MAX_CANDIDATES`
 * deduplicated candidates, each with ≥1 reason code, most-confident first.
 */
export function generateCandidates(input: GenerateCandidatesInput): Candidate[] {
  const { name, domain, priors, config } = input;
  const caps = config.caps;
  const support = input.domainSupport ?? null;

  const baseFirst = name.normalized.firstName;
  const baseLast = name.normalized.lastName;
  const middle = name.normalized.middleName;

  // Nothing to build a local part from.
  if (baseFirst === null && baseLast === null) return [];

  // Resolve the effective size bracket + whether it was actually known.
  const bracketKnown = domain.sizeBracket !== null || input.fallbackBracket !== undefined;
  const effectiveBracket: SizeBracket = domain.sizeBracket ?? input.fallbackBracket ?? 'medium';
  const priorList = priors[effectiveBracket] ?? [];

  // First-name candidates: base + nickname expansions.
  const firsts: FirstToken[] = [];
  if (baseFirst !== null) firsts.push({ value: baseFirst, isNickname: false });
  for (const nick of name.nicknameExpansions) firsts.push({ value: nick, isNickname: true });

  // Last-name candidates: base + surname/German variants (tagged for reason codes).
  const germanSet = new Set(germanFoldVariants(name.lastName ?? ''));
  const lasts: LastToken[] = [];
  if (baseLast !== null) {
    lasts.push({ value: baseLast, isSurnameVariant: false, isGermanVariant: false });
  }
  for (const v of name.surnameVariants) {
    lasts.push({ value: v, isSurnameVariant: true, isGermanVariant: germanSet.has(v) });
  }
  if (lasts.length === 0) lasts.push({ value: '', isSurnameVariant: false, isGermanVariant: false });

  const drafts: Draft[] = [];
  const seen = new Set<string>();

  const emit = (
    token: PatternToken,
    localRaw: string,
    weight: number,
    reasonCodes: ReasonCode[],
    collisionRisk: boolean,
  ): void => {
    const email = canonicalizeEmail(`${localRaw}@${domain.domain}`);
    if (email === null) return;
    if (seen.has(email)) return;
    seen.add(email);

    const obs = support?.get(token) ?? null;
    const blend = blendScore({
      patternPriorWeight: weight,
      verifiedCount: obs?.verifiedCount ?? 0,
      observedCount: obs?.observedCount ?? 0,
      verifyVerdict: null,
      recencyAgeDays: null,
      isNicknameVariant: reasonCodes.includes('nickname_variant'),
      isCjk: name.isCjk,
      collisionRisk,
      weights: config.blendWeights,
      caps,
    });

    const localPart = canonicalizeLocalPart(localRaw);
    drafts.push({
      email,
      localPart,
      patternToken: token,
      score: Math.round(blend.rawScore),
      reasonCodes,
      collisionRisk,
    });
  };

  // Merge seed priors with any domain-learned patterns not in the seed list.
  const tokens: PatternPrior[] = [...priorList];
  if (support !== null) {
    for (const [token, obs] of support) {
      if (!tokens.some((p) => p.token === token)) {
        // Learned-but-unseeded pattern: weight it by observed share proxy.
        tokens.push({ token, weight: obs.verifiedCount > 0 ? 1 : 0.5 });
      }
    }
  }

  // ── Base candidates: every prior token × every (first, last) combination ──
  for (const prior of tokens) {
    const obs = support?.get(prior.token) ?? null;
    const primaryReason: ReasonCode =
      obs && obs.verifiedCount > 0 ? 'pattern_learned_domain' : priorReason(domain.sizeBracket, bracketKnown);

    for (const first of firsts) {
      for (const last of lasts) {
        const vars = buildVars(first.value, last.value.length > 0 ? last.value : null, middle);
        const local = renderPattern(prior.token, vars);
        if (local === null) continue;

        const reasons: ReasonCode[] = [primaryReason];
        if (first.isNickname) reasons.push('nickname_variant');
        if (last.isGermanVariant) reasons.push('german_fold_variant');
        else if (last.isSurnameVariant) reasons.push('compound_surname_variant');
        if (name.isCjk) reasons.push('cjk_ambiguous_downweight');

        emit(prior.token, local, prior.weight, dedupeReasons(reasons), false);
      }
    }
  }

  // ── Dual collision candidates (D9): middle-initial AND numeric-suffix, equal weight ──
  if (shouldEmitCollisionCandidates(name, domain, input.collisionPolicy)) {
    const policy = input.collisionPolicy ?? DEFAULT_COLLISION_POLICY;
    // Anchor on the highest-weight base pattern that renders with the base name.
    const anchor = pickAnchor(tokens, baseFirst, baseLast, middle);
    if (anchor !== null) {
      const collisionWeight = anchor.weight;
      const baseReason: ReasonCode = priorReason(domain.sizeBracket, bracketKnown);

      // Middle-initial forms (only when a middle initial exists).
      if (middle !== null && middle.length > 0) {
        for (const token of policy.middleInitialTokens) {
          const vars = buildVars(baseFirst, baseLast, middle);
          const local = renderPattern(token, vars);
          if (local === null) continue;
          emit(
            token,
            local,
            collisionWeight,
            dedupeReasons([baseReason, 'collision_middle_initial_candidate', 'collision_risk_high']),
            true,
          );
        }
      }

      // Numeric-suffix forms (append each configured suffix to the anchor local part).
      const anchorLocal = renderPattern(anchor.token, buildVars(baseFirst, baseLast, middle));
      if (anchorLocal !== null) {
        for (const suffix of policy.numericSuffixes) {
          emit(
            anchor.token,
            `${anchorLocal}${suffix}`,
            collisionWeight,
            dedupeReasons([baseReason, 'collision_numeric_suffix_candidate', 'collision_risk_high']),
            true,
          );
        }
      }
    }
  }

  // Rank by score desc (stable) and clamp to the configured maximum.
  drafts.sort((a, b) => b.score - a.score);
  const clamped = drafts.slice(0, Math.max(0, caps.MAX_CANDIDATES));

  return clamped.map((d) => ({
    email: d.email,
    localPart: d.localPart,
    patternToken: d.patternToken,
    score: d.score,
    reasonCodes: d.reasonCodes.length > 0 ? d.reasonCodes : ['pattern_prior_unknown_size'],
    collisionRisk: d.collisionRisk,
  }));
}

function pickAnchor(
  tokens: readonly PatternPrior[],
  first: string | null,
  last: string | null,
  middle: string | null,
): PatternPrior | null {
  let best: PatternPrior | null = null;
  const vars = buildVars(first, last, middle);
  for (const prior of tokens) {
    if (renderPattern(prior.token, vars) === null) continue;
    if (best === null || prior.weight > best.weight) best = prior;
  }
  return best;
}

function dedupeReasons(codes: ReadonlyArray<ReasonCode>): ReasonCode[] {
  const out: ReasonCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
