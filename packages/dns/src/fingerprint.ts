// @mailmetero/dns — provider fingerprint router (MODULE_CONTRACTS §3; PRD §6 stage 6, D10).
//
// Maps a domain + its MX hosts to a `Provider` and the per-provider `VerifiabilityClass`
// that gates verify strategy downstream. Two-phase:
//   1. Consumer-domain override: gmail.com/googlemail.com → gmail_consumer, the big
//      freemail domains → yahoo_consumer/proton. These share MX suffixes with the
//      corresponding *business* provider (gmail.com uses aspmx.l.google.com just like a
//      Google Workspace custom domain), so the DOMAIN — not the MX suffix — decides.
//   2. Longest-suffix MX match against the rule table: a custom domain on
//      aspmx.l.google.com → google_workspace, *.mail.protection.outlook.com → microsoft365,
//      etc. Longest matching suffix wins; unmatched-but-resolved → 'other'.
// Verifiability defaults to PROVIDER_VERIFIABILITY and may be overridden per provider from
// live `kb.provider_fingerprints` data via `verifiabilityOverrides`.

import { PROVIDER_VERIFIABILITY } from '@mailmetero/contracts';
import type { Domain, Provider, VerifiabilityClass } from '@mailmetero/contracts';
import type { MxHost } from './types.ts';

export interface FingerprintRule {
  readonly suffix: string;
  readonly provider: Provider;
}

export interface ProviderFingerprint {
  readonly provider: Provider;
  readonly verifiabilityClass: VerifiabilityClass;
  readonly matchedSuffix: string | null;
}

/**
 * Seed MX-host-suffix → provider table (config-as-data; live values may be extended by
 * `kb.provider_fingerprints`). Ordered longest-first for readability only — matching is
 * length-based, not order-based.
 */
export const SEED_FINGERPRINT_RULES: readonly FingerprintRule[] = [
  { suffix: 'mail.protection.outlook.com', provider: 'microsoft365' },
  { suffix: 'aspmx.l.google.com', provider: 'google_workspace' },
  { suffix: 'googlemail.com', provider: 'google_workspace' },
  { suffix: 'pphosted.com', provider: 'proofpoint' },
  { suffix: 'ppe-hosted.com', provider: 'proofpoint' },
  { suffix: 'mimecast.com', provider: 'mimecast' },
  { suffix: 'mimecast.co.za', provider: 'mimecast' },
  { suffix: 'iphmx.com', provider: 'ironport' },
  { suffix: 'barracudanetworks.com', provider: 'barracuda' },
  { suffix: 'barracuda.com', provider: 'barracuda' },
  { suffix: 'zoho.com', provider: 'zoho' },
  { suffix: 'zoho.eu', provider: 'zoho' },
  { suffix: 'zohomail.com', provider: 'zoho' },
  { suffix: 'protonmail.ch', provider: 'proton' },
  { suffix: 'protonmail.com', provider: 'proton' },
] as const;

/** Consumer freemail domains where the registrable domain itself is the provider identity. */
const CONSUMER_DOMAINS: Readonly<Record<string, Provider>> = {
  'gmail.com': 'gmail_consumer',
  'googlemail.com': 'gmail_consumer',
  'yahoo.com': 'yahoo_consumer',
  'yahoo.co.uk': 'yahoo_consumer',
  'yahoo.co.in': 'yahoo_consumer',
  'yahoo.fr': 'yahoo_consumer',
  'yahoo.de': 'yahoo_consumer',
  'ymail.com': 'yahoo_consumer',
  'rocketmail.com': 'yahoo_consumer',
  'proton.me': 'proton',
  'protonmail.com': 'proton',
  'pm.me': 'proton',
} as const;

/** A rule matches a host when the host equals the suffix or ends with `.<suffix>`. */
function ruleMatchesHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Fingerprint a domain. Returns provider `'other'` (with matchedSuffix null) when the domain
 * resolves but matches no known suffix, or when there are no MX hosts to inspect.
 */
export function fingerprintProvider(
  domain: Domain,
  hosts: readonly MxHost[],
  rules: readonly FingerprintRule[],
  verifiabilityOverrides?: Readonly<Partial<Record<Provider, VerifiabilityClass>>>,
): ProviderFingerprint {
  const verifiabilityOf = (provider: Provider): VerifiabilityClass =>
    verifiabilityOverrides?.[provider] ?? PROVIDER_VERIFIABILITY[provider];

  // Phase 1 — consumer-domain override (domain identity beats MX suffix).
  const consumer = CONSUMER_DOMAINS[(domain as string).toLowerCase()];
  if (consumer !== undefined) {
    return { provider: consumer, verifiabilityClass: verifiabilityOf(consumer), matchedSuffix: null };
  }

  // Phase 2 — longest-suffix MX match across every host × rule.
  let bestProvider: Provider | null = null;
  let bestSuffix: string | null = null;
  for (const host of hosts) {
    const h = host.exchange.toLowerCase();
    for (const rule of rules) {
      if (!ruleMatchesHost(h, rule.suffix)) continue;
      if (bestSuffix === null || rule.suffix.length > bestSuffix.length) {
        bestSuffix = rule.suffix;
        bestProvider = rule.provider;
      }
    }
  }

  if (bestProvider !== null && bestSuffix !== null) {
    return { provider: bestProvider, verifiabilityClass: verifiabilityOf(bestProvider), matchedSuffix: bestSuffix };
  }

  return { provider: 'other', verifiabilityClass: verifiabilityOf('other'), matchedSuffix: null };
}
