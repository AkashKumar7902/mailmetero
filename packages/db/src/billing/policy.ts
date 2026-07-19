// @mailmetero/db — THE single billing definition (pure).
//
// §5 ARCHITECTURE: there is exactly ONE `decideBilling`. api (settleBilling) and worker
// (per-item settlement) both import it; neither re-implements the predicate. It reads
// ONLY caps.FINDER_BILLABLE_MIN — no numeric literals — so the billable threshold stays a
// single DB-tunable value (D8/D11).

import type { BillingInput, HardCaps } from '@mailmetero/contracts';

export type LedgerEndpoint = 'finder' | 'verifier';

export type BilledReason =
  | 'finder_score_ge_min'
  | 'verifier_definitive'
  | 'free_invalid_syntax'
  | 'free_degraded'
  | 'free_non_definitive';

export interface BillingDecision {
  billable: boolean;
  creditsDelta: number; // -1 when billed, 0 when free
  reason: BilledReason;
}

const FREE = (reason: BilledReason): BillingDecision => ({ billable: false, creditsDelta: 0, reason });
const BILLED = (reason: BilledReason): BillingDecision => ({ billable: true, creditsDelta: -1, reason });

/**
 * PURE outcome-conditional billing.
 *
 * Verifier bills iff: status ∈ {valid, invalid} AND sub_status ≠ invalid_syntax AND
 *   evidence ≠ degraded.
 * Finder bills iff: an email was returned AND score ≥ caps.FINDER_BILLABLE_MIN AND
 *   status ≠ accept_all AND evidence ≠ degraded.
 * Everything else is free, with a precise reason for the ledger.
 */
export function decideBilling(input: BillingInput, caps: HardCaps): BillingDecision {
  // Free-outcome short-circuits shared by both endpoints (checked first so the reason is exact).
  if (input.subStatus === 'invalid_syntax') return FREE('free_invalid_syntax');
  if (input.evidence === 'degraded') return FREE('free_degraded');

  if (input.endpoint === 'verifier') {
    const definitive = input.status === 'valid' || input.status === 'invalid';
    return definitive ? BILLED('verifier_definitive') : FREE('free_non_definitive');
  }

  // Finder.
  const billableFinder =
    input.hasEmail && input.score >= caps.FINDER_BILLABLE_MIN && input.status !== 'accept_all';
  return billableFinder ? BILLED('finder_score_ge_min') : FREE('free_non_definitive');
}
