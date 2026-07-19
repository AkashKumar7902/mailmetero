// @mailmetero/dns — §3 shared DNS value types (CONTRACTS_CORE / MODULE_CONTRACTS §3).
//
// Pure type surface: the DoH wire shapes (JSON-DoH per RFC 8484 / Google & Cloudflare
// `application/dns-json`), the typed MX classification result, and the resolved
// domain-facts record the pipeline's dns-enum stage (U8) consumes. `MxEnum`, `Domain`
// and `IsoTimestamp` are imported verbatim from contracts — never re-declared here.

import type { Domain, IsoTimestamp, MxEnum } from '@mailmetero/contracts';

/** The two DoH resolvers wired for v1: Google primary, Cloudflare fallback (PRD §6 stage 5). */
export type DohEndpointId = 'google' | 'cloudflare';

/** DNS record types this package queries over DoH. */
export type DnsRecordType = 'A' | 'AAAA' | 'MX' | 'TXT';

/** One MX exchanger: canonicalized (lowercased, trailing dot stripped) host + RFC 974 preference. */
export interface MxHost {
  readonly exchange: string;
  readonly preference: number;
}

/**
 * The domain-level DNS facts produced by `DnsResolver.resolve`. Cached in `kb.domains`
 * with a TTL and read by the fingerprint + score stages. `hosts` is preference-sorted
 * ascending (most-preferred first) and empty for NULL_MX / NO_MAIL_HOST / implicit-MX.
 */
export interface MxResolution {
  readonly domain: Domain;
  readonly mx: MxEnum;
  readonly hosts: readonly MxHost[];
  readonly hasAddress: boolean;
  readonly spfPresent: boolean;
  readonly dmarcPresent: boolean;
  readonly resolvedVia: DohEndpointId;
  readonly resolvedAt: IsoTimestamp;
}

/** One JSON-DoH answer record. `type` is the numeric DNS RR type (A=1, AAAA=28, MX=15, TXT=16). */
export interface DohAnswer {
  readonly name: string;
  readonly type: number;
  readonly TTL: number;
  readonly data: string;
}

/** A JSON-DoH response. `Status` is the DNS RCODE (0=NOERROR, 3=NXDOMAIN, …). */
export interface DohResponse {
  readonly Status: number;
  readonly Answer?: readonly DohAnswer[];
}

/** Numeric DNS RR type codes we care about, keyed by our string record type. */
export const DNS_RR_TYPE: Readonly<Record<DnsRecordType, number>> = {
  A: 1,
  AAAA: 28,
  MX: 15,
  TXT: 16,
} as const;

/** DNS RCODEs referenced by the resolver. */
export const RCODE_NOERROR = 0;
export const RCODE_NXDOMAIN = 3;
