// @mailmetero/dns — DoH resolver with Google→Cloudflare fallback (MODULE_CONTRACTS §3).
//
// Orchestrates the transport into a single `MxResolution`. Contract guarantees:
//   • NXDOMAIN ⇒ NO_MAIL_HOST (not an error — the domain simply cannot receive mail).
//   • NEVER throws. Transport/timeout errors on one endpoint fall through to the next;
//     if EVERY endpoint fails the resolver returns a NO_MAIL_HOST resolution rather than
//     propagating — the pipeline's dns-enum stage owns budget/degradation, not this layer.
// Per endpoint it issues: MX (posture), A then AAAA (address for implicit-MX), TXT on the
// domain (SPF) and TXT on `_dmarc.<domain>` (DMARC). A per-endpoint AbortController
// enforces `perEndpointTimeoutMs` and is linked to any caller-supplied signal.

import type { Domain, IsoTimestamp } from '@mailmetero/contracts';
import type { DohTransport } from './doh-transport.ts';
import { classifyMx } from './mx-classify.ts';
import { DNS_RR_TYPE, RCODE_NOERROR, RCODE_NXDOMAIN } from './types.ts';
import type { DohAnswer, DohEndpointId, DohResponse, MxHost, MxResolution } from './types.ts';

export interface DnsResolverOptions {
  readonly perEndpointTimeoutMs: number;
  readonly endpointOrder: readonly DohEndpointId[];
}

export interface DnsResolver {
  resolve(domain: Domain, signal?: AbortSignal): Promise<MxResolution>;
}

const DEFAULT_OPTIONS: DnsResolverOptions = {
  perEndpointTimeoutMs: 2500,
  endpointOrder: ['google', 'cloudflare'],
};

/** Strip the surrounding quotes JSON-DoH puts around TXT rdata and join split segments. */
function txtValue(data: string): string {
  return data
    .split(/"\s+"/)
    .map((seg) => seg.replace(/^"/, '').replace(/"$/, ''))
    .join('');
}

function hasAddressAnswer(resp: DohResponse): boolean {
  return (resp.Answer ?? []).some((a) => a.type === DNS_RR_TYPE.A || a.type === DNS_RR_TYPE.AAAA);
}

function anyTxtMatches(resp: DohResponse, predicate: (v: string) => boolean): boolean {
  return (resp.Answer ?? [])
    .filter((a) => a.type === DNS_RR_TYPE.TXT)
    .some((a) => predicate(txtValue(a.data).trim().toLowerCase()));
}

function mxAnswersOf(resp: DohResponse): readonly DohAnswer[] {
  return resp.Answer ?? [];
}

/**
 * Build a DnsResolver. `clock` supplies the resolvedAt wall-clock (ms since epoch) so tests
 * are deterministic. `opts` overrides timeout / endpoint order partially.
 */
export function createDnsResolver(
  transport: DohTransport,
  clock: () => number,
  opts?: Partial<DnsResolverOptions>,
): DnsResolver {
  const perEndpointTimeoutMs = opts?.perEndpointTimeoutMs ?? DEFAULT_OPTIONS.perEndpointTimeoutMs;
  const endpointOrder =
    opts?.endpointOrder && opts.endpointOrder.length > 0 ? opts.endpointOrder : DEFAULT_OPTIONS.endpointOrder;

  function nowIso(): IsoTimestamp {
    return new Date(clock()).toISOString() as IsoTimestamp;
  }

  function resolution(
    domain: Domain,
    via: DohEndpointId,
    fields: {
      mx: MxResolution['mx'];
      hosts: readonly MxHost[];
      hasAddress: boolean;
      spfPresent: boolean;
      dmarcPresent: boolean;
    },
  ): MxResolution {
    return {
      domain,
      mx: fields.mx,
      hosts: fields.hosts,
      hasAddress: fields.hasAddress,
      spfPresent: fields.spfPresent,
      dmarcPresent: fields.dmarcPresent,
      resolvedVia: via,
      resolvedAt: nowIso(),
    };
  }

  async function resolveVia(
    endpoint: DohEndpointId,
    domain: Domain,
    signal?: AbortSignal,
  ): Promise<MxResolution> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perEndpointTimeoutMs);
    const onParentAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const sig = controller.signal;

    try {
      const mxResp = await transport.query(endpoint, domain, 'MX', sig);

      // NXDOMAIN: the name does not exist → definitively no mail host. Not an error.
      if (mxResp.Status === RCODE_NXDOMAIN) {
        return resolution(domain, endpoint, {
          mx: 'NO_MAIL_HOST',
          hosts: [],
          hasAddress: false,
          spfPresent: false,
          dmarcPresent: false,
        });
      }
      // Any other non-success RCODE (SERVFAIL/REFUSED/…): treat as endpoint failure → fall back.
      if (mxResp.Status !== RCODE_NOERROR) {
        throw new Error(`doh ${endpoint} rcode ${mxResp.Status}`);
      }

      const aResp = await transport.query(endpoint, domain, 'A', sig);
      let hasAddress = hasAddressAnswer(aResp);
      if (!hasAddress) {
        const aaaaResp = await transport.query(endpoint, domain, 'AAAA', sig);
        hasAddress = hasAddressAnswer(aaaaResp);
      }

      const { mx, hosts } = classifyMx({ mxAnswers: mxAnswersOf(mxResp), hasAddress });

      const spfResp = await transport.query(endpoint, domain, 'TXT', sig);
      const spfPresent = anyTxtMatches(spfResp, (v) => v.startsWith('v=spf1'));

      const dmarcResp = await transport.query(endpoint, `_dmarc.${domain}`, 'TXT', sig);
      const dmarcPresent = anyTxtMatches(dmarcResp, (v) => v.startsWith('v=dmarc1'));

      return resolution(domain, endpoint, { mx, hosts, hasAddress, spfPresent, dmarcPresent });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }
  }

  return {
    async resolve(domain, signal): Promise<MxResolution> {
      let lastEndpoint: DohEndpointId = endpointOrder[0] ?? 'google';
      for (const endpoint of endpointOrder) {
        lastEndpoint = endpoint;
        try {
          return await resolveVia(endpoint, domain, signal);
        } catch {
          // Fall through to the next endpoint (Google → Cloudflare).
        }
      }
      // Every endpoint failed. Honor the never-throws guarantee with the safe terminal.
      return resolution(domain, lastEndpoint, {
        mx: 'NO_MAIL_HOST',
        hosts: [],
        hasAddress: false,
        spfPresent: false,
        dmarcPresent: false,
      });
    },
  };
}
