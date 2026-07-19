// @mailmetero/pipeline — public barrel.
//
// The cheapest-first orchestrator (stages 0–8), the canonical INTERNAL result types (api imports
// them), the structural ports, the core adapter, the ONE internal→wire mapper (api + worker import
// it), the Budget, and the Stage protocol. MODULE_CONTRACTS §7.

export * from './types.ts';
export * from './ports.ts';
export * from './budget.ts';
export * from './adapter.ts';
export * from './wire.ts';
export * from './stage.ts';
export * from './orchestrator.ts';

// Stage factories (buildStages composes these; exported for CI + focused tests).
export { makeCanonicalizeSyntaxStage } from './stages/canonicalize-syntax.ts';
export { makeSuppressionStage } from './stages/suppression.ts';
export { makeClassificationStage } from './stages/classification.ts';
export { makeTenantCacheStage } from './stages/tenant-cache.ts';
export { makeKbFactsStage } from './stages/kb-facts.ts';
export { makeDnsEnumStage } from './stages/dns-enum.ts';
export { makeProviderFingerprintStage } from './stages/provider-fingerprint.ts';
export { makeVerifierBackendStage } from './stages/verifier-backend.ts';
export { makeScoreWritebackStage } from './stages/score-writeback.ts';
