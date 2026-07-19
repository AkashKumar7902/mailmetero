// @mailmetero/api — outcome-conditional billing settlement (handler-side).
//
// The billable predicate lives ONCE, in db's `decideBilling` — there is NO local billing logic
// here (D8/D11). settleBilling: compute the pure decision from the caps (DB-tunable), then hand
// the result + BillingInput to the atomic LedgerApiPort.settle (records the attempt always, debits
// a credit only when billable). The X-Billed / X-Credits-Remaining values are stashed on the
// context before the reply is sent; `ctx.billedApplied` makes it exactly-once per request.

import { decideBilling } from '@mailmetero/db';
import type { BillingInput } from '@mailmetero/contracts';
import type { InternalFinderResult, InternalVerifierResult } from '@mailmetero/pipeline';
import type { ApiDeps } from '../deps.ts';
import type { EndpointId, RequestContext } from '../types.ts';

export async function settleBilling(
  deps: ApiDeps,
  ctx: RequestContext,
  endpoint: EndpointId,
  result: InternalFinderResult | InternalVerifierResult,
  billingInput: BillingInput,
): Promise<void> {
  // Exactly-once, and never on unauthenticated/sandbox paths (sandbox is always 0 credits).
  if (ctx.billedApplied || ctx.principal === null || ctx.isSandbox) return;
  ctx.billedApplied = true;

  const caps = (await deps.scoring.current()).caps;
  // The ONLY billing predicate. Persistence is idempotent on (tenant, request_id).
  const decision = decideBilling(billingInput, caps);

  const outcome = await deps.ledger.settle({
    principal: ctx.principal,
    requestId: ctx.requestId,
    endpoint,
    result,
    billingInput,
  });

  ctx.billing = { billed: decision.billable };
  ctx.creditsRemaining = outcome.creditsRemaining;
}
