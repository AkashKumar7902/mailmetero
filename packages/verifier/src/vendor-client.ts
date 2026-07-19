// @mailmetero/verifier — MillionVerifier-class HTTPS vendor client over the injected EgressFetch.
//
// The client is the ONLY thing in this package that touches the network, and it does so exclusively
// through `config`'s egress choke point (which re-validates every redirect hop against the allowlist).
// It is deliberately thin: issue the request, parse the vendor JSON into the neutral
// `VendorVerifyResponse`, and let `createHttpsApiBackend` own verdict mapping + clamping. Tests stub
// this interface entirely — no live vendor calls ever run in the suite.

import type { EgressFetch } from '@mailmetero/config';
import type { EmailAddress } from '@mailmetero/contracts';

export interface VendorVerifyResponse {
  readonly resultCode: string;
  readonly rawSmtpCode?: string;
  readonly enhancedCode?: string;
  readonly subResult?: string;
}

export interface HttpsVerifierVendorClient {
  verify(email: EmailAddress, signal?: AbortSignal): Promise<VendorVerifyResponse>;
}

/** Shape of the vendor JSON body we tolerate (MillionVerifier v3-class). All fields optional. */
interface VendorRawBody {
  result?: unknown;
  resultcode?: unknown;
  quality?: unknown;
  subresult?: unknown;
  sub_result?: unknown;
  smtp_code?: unknown;
  smtpCode?: unknown;
  enhanced_code?: unknown;
  enhancedCode?: unknown;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function createFetchVendorClient(deps: {
  fetch: EgressFetch;
  baseUrl: string;
  apiKey: string;
  allowlist: readonly string[];
}): HttpsVerifierVendorClient {
  const { fetch, baseUrl, apiKey, allowlist } = deps;

  // Fail fast at construction: the vendor host must be on the egress allowlist. This is a second
  // guard in front of the EgressFetch policy (belt-and-suspenders), and turns a misconfiguration
  // into a boot error rather than a per-request egress rejection.
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`createFetchVendorClient: invalid baseUrl ${JSON.stringify(baseUrl)}`);
  }
  if (!allowlist.includes(base.hostname)) {
    throw new Error(
      `createFetchVendorClient: vendor host ${base.hostname} is not on the egress allowlist`,
    );
  }

  return {
    async verify(email: EmailAddress, signal?: AbortSignal): Promise<VendorVerifyResponse> {
      const url = new URL(base.toString());
      url.searchParams.set('api', apiKey);
      url.searchParams.set('email', email);

      const init: RequestInit = signal
        ? { method: 'GET', signal, headers: { accept: 'application/json' } }
        : { method: 'GET', headers: { accept: 'application/json' } };

      const res = await fetch(url, init);
      if (!res.ok) {
        throw new Error(`vendor verify failed: HTTP ${res.status}`);
      }

      const body = (await res.json()) as VendorRawBody;

      const resultCode = asString(body.result) ?? asString(body.resultcode) ?? 'unknown';
      const rawSmtpCode = asString(body.smtp_code) ?? asString(body.smtpCode);
      const enhancedCode = asString(body.enhanced_code) ?? asString(body.enhancedCode);
      const subResult = asString(body.subresult) ?? asString(body.sub_result) ?? asString(body.quality);

      // exactOptionalPropertyTypes: build the object omitting absent optionals rather than
      // assigning `undefined`.
      return {
        resultCode,
        ...(rawSmtpCode !== undefined ? { rawSmtpCode } : {}),
        ...(enhancedCode !== undefined ? { enhancedCode } : {}),
        ...(subResult !== undefined ? { subResult } : {}),
      };
    },
  };
}
