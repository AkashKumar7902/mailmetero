// @mailmetero/db — scoring + fingerprint + role/typo seeding (0007 data migration).
//
// Seeds, all idempotent:
//   • kb.blend_weights ← DEFAULT_SCORING_CONFIG (validated), activated.
//   • kb.pattern_priors ← size-conditioned format-share priors. PLACEHOLDER shares
//     (research-brief-derived, {first}.{last} dominant) until the real BounceZero audit
//     export lands (PRD OQ#2). The SCHEMA is final; only these VALUES are provisional.
//   • kb.provider_fingerprints ← MX-suffix → PROVIDER_VERIFIABILITY seed (longest-suffix wins).
//   • kb.role_locals ← SEED_ROLE_LOCALS (RFC 2142 + info/sales/hr/careers/hello/contact/noreply…).
//   • kb.typo_domains ← SEED_TYPO_DOMAINS (gnail.com→gmail.com …).
//
// NOTE: fingerprint suffixes are declared HERE (db owns the seed) — db does NOT depend on
// @mailmetero/dns (§6 DAG), so the dns SEED_FINGERPRINT_RULES are never imported.

import { SIZE_BRACKETS, PROVIDER_VERIFIABILITY } from '@mailmetero/contracts';
import type { Domain, LocalPart, PatternToken, Provider, SizeBracket } from '@mailmetero/contracts';
import { DEFAULT_SCORING_CONFIG } from '@mailmetero/config';
import type { Queryable } from '../client.ts';
import type { KbRoleLocalRow, KbTypoDomainRow, KbPatternPriorRow, KbProviderFingerprintRow } from '../types.ts';
import { createScoringConfigRepo } from '../scoring-config.ts';
import { createPatternPriorsRepo } from '../repositories/kb-priors.ts';
import { createKbProviderFingerprintsRepo } from '../repositories/kb-provider-fingerprints.ts';
import { createKbClassificationRepo } from '../repositories/kb-classification.ts';

// ── role locals (RFC 2142 marked true; common extensions false) ─────────────
const RFC2142 = [
  'postmaster', 'abuse', 'hostmaster', 'webmaster', 'admin', 'administrator', 'noc', 'security',
  'info', 'sales', 'support', 'marketing', 'www', 'ftp', 'usenet', 'news', 'uucp',
];
const ROLE_EXTENSIONS = [
  'hr', 'careers', 'jobs', 'hello', 'contact', 'noreply', 'no-reply', 'help', 'billing', 'office',
  'team', 'mail', 'enquiries', 'feedback', 'accounts', 'legal', 'press', 'privacy',
];

export const SEED_ROLE_LOCALS: ReadonlyArray<KbRoleLocalRow> = [
  ...RFC2142.map((l): KbRoleLocalRow => ({ localPart: l as LocalPart, rfc2142: true })),
  ...ROLE_EXTENSIONS.map((l): KbRoleLocalRow => ({ localPart: l as LocalPart, rfc2142: false })),
];

export const SEED_TYPO_DOMAINS: ReadonlyArray<KbTypoDomainRow> = [
  { typo: 'gnail.com', correction: 'gmail.com' as Domain },
  { typo: 'gmial.com', correction: 'gmail.com' as Domain },
  { typo: 'gmai.com', correction: 'gmail.com' as Domain },
  { typo: 'gmail.co', correction: 'gmail.com' as Domain },
  { typo: 'gmail.con', correction: 'gmail.com' as Domain },
  { typo: 'hotmial.com', correction: 'hotmail.com' as Domain },
  { typo: 'hotmai.com', correction: 'hotmail.com' as Domain },
  { typo: 'hotmil.com', correction: 'hotmail.com' as Domain },
  { typo: 'yahooo.com', correction: 'yahoo.com' as Domain },
  { typo: 'yaho.com', correction: 'yahoo.com' as Domain },
  { typo: 'outlok.com', correction: 'outlook.com' as Domain },
  { typo: 'outloo.com', correction: 'outlook.com' as Domain },
  { typo: 'iclould.com', correction: 'icloud.com' as Domain },
  { typo: 'icloud.co', correction: 'icloud.com' as Domain },
];

// ── provider fingerprint seed (MX suffix → provider; verifiability from contracts) ──
interface SuffixSeed {
  suffix: string;
  provider: Provider;
  notes?: string;
}
const FINGERPRINT_SUFFIXES: readonly SuffixSeed[] = [
  { suffix: '.mail.protection.outlook.com', provider: 'microsoft365', notes: 'Exchange Online' },
  { suffix: 'aspmx.l.google.com', provider: 'google_workspace', notes: 'Google Workspace custom domain' },
  { suffix: '.googlemail.com', provider: 'google_workspace' },
  { suffix: '.pphosted.com', provider: 'proofpoint' },
  { suffix: '.ppe-hosted.com', provider: 'proofpoint' },
  { suffix: '.mimecast.com', provider: 'mimecast' },
  { suffix: '.iphmx.com', provider: 'ironport', notes: 'Cisco IronPort' },
  { suffix: '.barracudanetworks.com', provider: 'barracuda' },
  { suffix: '.ess.barracuda.com', provider: 'barracuda' },
  { suffix: 'mx.zoho.com', provider: 'zoho' },
  { suffix: '.zoho.com', provider: 'zoho' },
  { suffix: '.protonmail.ch', provider: 'proton' },
  { suffix: '.yahoodns.net', provider: 'yahoo_consumer' },
];

/** The provider-fingerprint rows to seed (priority = suffix length ⇒ longest-suffix wins). */
export const SEED_PROVIDER_FINGERPRINTS: ReadonlyArray<Omit<KbProviderFingerprintRow, 'id'>> =
  FINGERPRINT_SUFFIXES.map((s) => ({
    mxSuffix: s.suffix,
    provider: s.provider,
    verifiabilityClass: PROVIDER_VERIFIABILITY[s.provider],
    priority: s.suffix.length,
    notes: s.notes ?? null,
  }));

// ── placeholder size-conditioned format-share priors ────────────────────────
const PLACEHOLDER_SHAPE: ReadonlyArray<{ token: string; share: number }> = [
  { token: '{first}.{last}', share: 0.42 },
  { token: '{f}{last}', share: 0.20 },
  { token: '{first}', share: 0.12 },
  { token: '{first}{last}', share: 0.10 },
  { token: '{f}.{last}', share: 0.08 },
  { token: '{last}', share: 0.05 },
  { token: '{first}_{last}', share: 0.03 },
];

export const SEED_PATTERN_PRIORS: ReadonlyArray<KbPatternPriorRow> = SIZE_BRACKETS.flatMap(
  (bracket: SizeBracket) =>
    PLACEHOLDER_SHAPE.map((row, idx): KbPatternPriorRow => ({
      sizeBracket: bracket,
      patternToken: row.token as PatternToken,
      share: row.share,
      rank: idx + 1,
    })),
);

/** Run the full 0007 seed (all idempotent). */
export async function seedScoringAndFingerprints(q: Queryable): Promise<void> {
  const scoring = createScoringConfigRepo();
  await scoring.insertVersion(q, DEFAULT_SCORING_CONFIG, true);

  const priors = createPatternPriorsRepo();
  await priors.upsert(q, [...SEED_PATTERN_PRIORS]);

  const fingerprints = createKbProviderFingerprintsRepo();
  await fingerprints.upsert(q, [...SEED_PROVIDER_FINGERPRINTS]);

  const classification = createKbClassificationRepo();
  await classification.upsertRoleLocals(q, [...SEED_ROLE_LOCALS]);
  await classification.upsertTypos(q, [...SEED_TYPO_DOMAINS]);
}
