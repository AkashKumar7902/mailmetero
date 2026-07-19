// @mailmetero/verifier — HttpsApiBackend: the v1 default VerifierBackend (Backend='api').
//
// Wraps an injected HttpsVerifierVendorClient behind a timeout and translates the vendor result into
// a VerifyOutcome via a tunable VendorResultMap, falling back to the SMTP classifier when the vendor
// returns an unmapped code but carried an SMTP reply. Two safety properties:
//   • timeout / abort            → unknown / timeout   (never blocks the request budget)
//   • D10 defense-in-depth CLAMP → UNVERIFIABLE / UNKNOWN provider classes can NEVER emit 'valid'.
//     UNVERIFIABLE 'valid' → accept_all / provider_unverifiable; UNKNOWN 'valid' → unknown. This is a
//     second wall behind the fingerprint short-circuit and the SMTP classifier so no single bug can
//     let an M365 / consumer-webmail address escape as definitively valid.

import type {
  Backend,
  EmailAddress,
  SubStatus,
  VerifiabilityClass,
  VerifierBackend,
  VerifyContext,
  VerifyOutcome,
  VerifyVerdict,
} from '@mailmetero/contracts';
import { classifySmtpCode } from './status-codes.ts';
import type { HttpsVerifierVendorClient, VendorVerifyResponse } from './vendor-client.ts';

export type VendorResultMap = Readonly<
  Record<string, { verdict: VerifyVerdict; subStatus: SubStatus }>
>;

/**
 * Default MillionVerifier-class result → verdict map. Keyed by the vendor's `result` string and its
 * numeric `resultcode` alias (lowercased at lookup). Every subStatus is legal under its verdict per
 * STATUS_SUBSTATUS. Note: 'disposable' has no VerifyVerdict — the pipeline classifies disposable
 * domains at stage 2, so a vendor 'disposable' here is redundant and mapped to the safe 'unknown'.
 */
export const DEFAULT_MILLIONVERIFIER_RESULT_MAP: VendorResultMap = Object.freeze({
  ok: { verdict: 'valid', subStatus: 'ok' },
  '1': { verdict: 'valid', subStatus: 'ok' },
  catch_all: { verdict: 'accept_all', subStatus: 'catch_all_confirmed' },
  '2': { verdict: 'accept_all', subStatus: 'catch_all_confirmed' },
  unknown: { verdict: 'unknown', subStatus: 'backend_unavailable' },
  '3': { verdict: 'unknown', subStatus: 'backend_unavailable' },
  error: { verdict: 'unknown', subStatus: 'backend_unavailable' },
  '4': { verdict: 'unknown', subStatus: 'backend_unavailable' },
  disposable: { verdict: 'unknown', subStatus: 'backend_unavailable' },
  '5': { verdict: 'unknown', subStatus: 'backend_unavailable' },
  invalid: { verdict: 'invalid', subStatus: 'invalid_mailbox' },
  '6': { verdict: 'invalid', subStatus: 'invalid_mailbox' },
} as const);

export interface HttpsApiBackendOptions {
  readonly timeoutMs: number;
  readonly resultMap: VendorResultMap;
}

/** Attach the SMTP codes the vendor reported to the outcome, omitting absent optionals. */
function toOutcome(
  verdict: VerifyVerdict,
  subStatus: SubStatus,
  resp: VendorVerifyResponse,
): VerifyOutcome {
  return {
    verdict,
    subStatus,
    ...(resp.rawSmtpCode !== undefined ? { rawSmtpCode: resp.rawSmtpCode } : {}),
    ...(resp.enhancedCode !== undefined ? { enhancedCode: resp.enhancedCode } : {}),
  };
}

/**
 * D10 defense-in-depth: providers that cannot be trusted per-address may never emit 'valid'.
 *   UNVERIFIABLE (M365) valid → accept_all / provider_unverifiable
 *   UNKNOWN (gmail/yahoo consumer) valid → unknown (verification not assertable for this provider)
 * All non-'valid' verdicts pass through untouched.
 */
function clampForVerifiability(o: VerifyOutcome, vc: VerifiabilityClass): VerifyOutcome {
  if (o.verdict !== 'valid') return o;
  if (vc === 'UNVERIFIABLE') return { ...o, verdict: 'accept_all', subStatus: 'provider_unverifiable' };
  if (vc === 'UNKNOWN') return { ...o, verdict: 'unknown', subStatus: 'backend_unavailable' };
  return o;
}

export function createHttpsApiBackend(
  client: HttpsVerifierVendorClient,
  opts: HttpsApiBackendOptions,
): VerifierBackend {
  const kind: Backend = 'api';

  return {
    kind,
    async verify(email: EmailAddress, ctx: VerifyContext): Promise<VerifyOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

      let response: VendorVerifyResponse;
      try {
        response = await client.verify(email, controller.signal);
      } catch {
        // A deadline abort is a timeout; any other failure is an unavailable backend. Either way the
        // pipeline degrades gracefully — the backend never throws.
        return controller.signal.aborted
          ? { verdict: 'unknown', subStatus: 'timeout' }
          : { verdict: 'unknown', subStatus: 'backend_unavailable' };
      } finally {
        clearTimeout(timer);
      }

      const key = response.resultCode.toLowerCase();
      const mapped = opts.resultMap[key] ?? opts.resultMap[response.resultCode];

      let outcome: VerifyOutcome;
      if (mapped) {
        outcome = toOutcome(mapped.verdict, mapped.subStatus, response);
      } else if (response.rawSmtpCode !== undefined || response.enhancedCode !== undefined) {
        // Unmapped vendor code but an SMTP reply is present — classify from the wire code.
        const classification = classifySmtpCode({
          provider: ctx.provider,
          verifiabilityClass: ctx.verifiabilityClass,
          ...(response.rawSmtpCode !== undefined ? { rawCode: response.rawSmtpCode } : {}),
          ...(response.enhancedCode !== undefined ? { enhancedCode: response.enhancedCode } : {}),
        });
        outcome = toOutcome(classification.verdict, classification.subStatus, response);
      } else {
        outcome = { verdict: 'unknown', subStatus: 'backend_unavailable' };
      }

      return clampForVerifiability(outcome, ctx.verifiabilityClass);
    },
  };
}
