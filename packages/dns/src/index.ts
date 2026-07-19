// @mailmetero/dns — public surface (MODULE_CONTRACTS §3).
// DoH resolver (Google primary + Cloudflare fallback), typed MxEnum classification, and
// the MX-suffix provider fingerprint. Imports only contracts + config (§6 DAG).

export type {
  DohEndpointId,
  DnsRecordType,
  MxHost,
  MxResolution,
  DohAnswer,
  DohResponse,
} from './types.ts';

export { createFetchDohTransport, DohEndpointNotAllowedError } from './doh-transport.ts';
export type { DohTransport } from './doh-transport.ts';

export { classifyMx } from './mx-classify.ts';

export { createDnsResolver } from './resolver.ts';
export type { DnsResolver, DnsResolverOptions } from './resolver.ts';

export { fingerprintProvider, SEED_FINGERPRINT_RULES } from './fingerprint.ts';
export type { FingerprintRule, ProviderFingerprint } from './fingerprint.ts';
