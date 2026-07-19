// @mailmetero/pipeline — the per-request time budget.
//
// A monotonic deadline computed from an injected clock. Stage 7 checks `expired()` before any
// paid verify: finder degrades to backend=none, verifier defers to 202 (MODULE_CONTRACTS §7.3).

export interface Budget {
  readonly deadline: number;
  remaining(clock: () => number): number;
  expired(clock: () => number): boolean;
}

/**
 * Build a budget. `budgetMs` is the endpoint default (finder ~8s, sync verify ~2s from
 * ScoringConfig.caps); `callerMaxMs`, when supplied, tightens it (never loosens).
 */
export function createBudget(clock: () => number, budgetMs: number, callerMaxMs?: number): Budget {
  const span = callerMaxMs != null ? Math.min(budgetMs, callerMaxMs) : budgetMs;
  const deadline = clock() + Math.max(0, span);
  return {
    deadline,
    remaining(c: () => number): number {
      return Math.max(0, deadline - c());
    },
    expired(c: () => number): boolean {
      return c() >= deadline;
    },
  };
}
