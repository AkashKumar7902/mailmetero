// @mailmetero/core — public barrel.
//
// The pure BounceZero derivation engine: canonicalizers, the name pipeline, pattern grammar,
// candidate generation (dual collision candidates, D9), classifiers over injected sets, and
// the blend/caps/scoreDerivation scorer. No network, no DB — every effectful input is injected.

export * from './canonicalize.ts';
export * from './name/normalize.ts';
export * from './name/german.ts';
export * from './name/surname.ts';
export * from './name/nicknames.ts';
export * from './name/parse.ts';
export * from './patterns.ts';
export * from './candidates.ts';
export * from './classify.ts';
export * from './scoring/blend.ts';
export * from './scoring/caps.ts';
export * from './scoring/score.ts';
