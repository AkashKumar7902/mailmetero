// Shared test harness — builds fully-faked PipelineDeps (zero live network) and request fixtures.
// NOT a *.test.ts file, so node:test does not execute it directly.

import { DEFAULT_SCORING_CONFIG } from '@mailmetero/contracts';
import type {
  Domain,
  EmailAddress,
  IsoTimestamp,
  LocalPart,
  NameInput,
  DomainInput,
  PatternToken,
  ScoringConfig,
  SizeBracket,
  TenantId,
  RequestId,
  VerifyOutcome,
  MxEnum,
} from '@mailmetero/contracts';
import type { MxResolution, MxHost } from '@mailmetero/dns';
import { SEED_FINGERPRINT_RULES } from '@mailmetero/dns';
import { createCoreAdapter } from '../src/adapter.ts';
import type { PipelineDeps } from '../src/stage.ts';
import type { KbDomainFacts } from '../src/ports.ts';
import type { FinderRequest, VerifierRequest } from '../src/orchestrator.ts';

export const T0 = 1_700_000_000_000;

const priorList = [
  { token: '{first}.{last}' as PatternToken, weight: 0.5 },
  { token: '{f}{last}' as PatternToken, weight: 0.3 },
  { token: '{first}{last}' as PatternToken, weight: 0.15 },
  { token: '{last}' as PatternToken, weight: 0.05 },
];

export const PRIORS = {
  micro: priorList,
  small: priorList,
  medium: priorList,
  large: priorList,
  enterprise: priorList,
} as const;

export function makeName(first: string, last: string): NameInput {
  return {
    raw: { firstName: first, lastName: last },
    firstName: first,
    middleName: null,
    lastName: last,
    normalized: { firstName: first.toLowerCase(), middleName: null, lastName: last.toLowerCase() },
    script: 'latin',
    isCjk: false,
    nicknameExpansions: [],
    surnameVariants: [],
  };
}

export function makeDomain(
  raw: string,
  opts: { sizeBracket?: SizeBracket; isFreemail?: boolean; isDisposable?: boolean } = {},
): DomainInput {
  return {
    raw,
    domain: raw as Domain,
    isFreemail: opts.isFreemail ?? false,
    isDisposable: opts.isDisposable ?? false,
    sizeBracket: opts.sizeBracket ?? 'small',
  };
}

export function makeMx(
  domain: string,
  mx: MxEnum,
  hosts: MxHost[],
  extra: { spfPresent?: boolean; dmarcPresent?: boolean } = {},
): MxResolution {
  return {
    domain: domain as Domain,
    mx,
    hosts,
    hasAddress: hosts.length > 0,
    spfPresent: extra.spfPresent ?? true,
    dmarcPresent: extra.dmarcPresent ?? true,
    resolvedVia: 'google',
    resolvedAt: new Date(T0).toISOString() as IsoTimestamp,
  };
}

export const OUTLOOK_HOSTS: MxHost[] = [
  { exchange: 'acme-com.mail.protection.outlook.com', preference: 10 },
];
export const GOOGLE_HOSTS: MxHost[] = [{ exchange: 'aspmx.l.google.com', preference: 1 }];

export interface HarnessCalls {
  verify: EmailAddress[];
  probe: number;
  upsert: number;
  record: number;
  suppressionQueries: string[][];
}

export interface HarnessOptions {
  mx?: MxResolution;
  facts?: KbDomainFacts | null;
  verifyOutcome?: VerifyOutcome;
  backendKind?: 'api' | 'none';
  probeCatchAll?: boolean;
  suppress?: (values: readonly string[]) => boolean;
  isFreemail?: boolean;
  isDisposable?: boolean;
  isRoleLocal?: boolean;
  config?: ScoringConfig;
  clock?: () => number;
}

export function makeDeps(opts: HarnessOptions = {}): { deps: PipelineDeps; calls: HarnessCalls } {
  const config = opts.config ?? DEFAULT_SCORING_CONFIG;
  const calls: HarnessCalls = { verify: [], probe: 0, upsert: 0, record: 0, suppressionQueries: [] };
  const adapter = createCoreAdapter({ priors: PRIORS, config });
  const mx = opts.mx ?? makeMx('acme.com', 'EXPLICIT_MX', GOOGLE_HOSTS);
  const verifyOutcome: VerifyOutcome = opts.verifyOutcome ?? {
    verdict: 'valid',
    subStatus: 'ok',
    rawSmtpCode: '250',
  };

  const deps: PipelineDeps = {
    resolver: { async resolve() { return mx; } },
    backend: {
      kind: opts.backendKind ?? 'api',
      async verify(email) {
        calls.verify.push(email);
        return verifyOutcome;
      },
    },
    catchAllProbe: {
      async probe() {
        calls.probe += 1;
        return { isCatchAll: opts.probeCatchAll ?? false, rawSmtpCode: null, probedLocalPart: 'zzqx' as LocalPart };
      },
    },
    fingerprintRules: SEED_FINGERPRINT_RULES,
    scoringConfig: config,
    clock: opts.clock ?? (() => T0),
    suppression: {
      async isSuppressed(values) {
        calls.suppressionQueries.push([...values]);
        return opts.suppress ? opts.suppress(values) : false;
      },
    },
    classification: {
      async isFreemail() { return opts.isFreemail ?? false; },
      async isDisposable() { return opts.isDisposable ?? false; },
      async isRoleLocal() { return opts.isRoleLocal ?? false; },
      async correctTypoDomain() { return null; },
    },
    tenantCache: { async lookup() { return null; } },
    kbFacts: {
      async getDomainFacts() { return opts.facts ?? null; },
      async getDomainPatterns() { return []; },
    },
    kbWriteback: {
      async upsertDomainFacts() { calls.upsert += 1; },
      async recordPatternObservation() { calls.record += 1; },
    },
    candidates: adapter.candidates,
    scorer: adapter.scorer,
  };

  return { deps, calls };
}

export function finderReq(overrides: Partial<FinderRequest> = {}): FinderRequest {
  return {
    tenantId: 't_1' as TenantId,
    requestId: 'req_1' as RequestId,
    name: makeName('John', 'Doe'),
    domain: makeDomain('acme.com'),
    cacheKey: { kind: 'find', hash: 'h1' },
    ...overrides,
  };
}

export function verifierReq(overrides: Partial<VerifierRequest> = {}): VerifierRequest {
  return {
    tenantId: 't_1' as TenantId,
    requestId: 'req_1' as RequestId,
    email: 'john.doe@acme.com' as EmailAddress,
    domain: makeDomain('acme.com'),
    cacheKey: { kind: 'verify', hash: 'h1' },
    ...overrides,
  };
}
