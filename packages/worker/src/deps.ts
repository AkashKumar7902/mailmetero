// @mailmetero/worker — configuration + dependency wiring (MODULE_CONTRACTS §9).
//
// `WorkerConfig` is the static tuning read from Env; `WorkerDeps` is the resolved bundle of
// pools, repositories, the assembled Pipeline and the live billing caps the processors need.
// `buildWorkerDeps` is the composition root: it opens the UNPOOLED direct pool (D20), loads the
// live ScoringConfig / priors / fingerprints from the KB, wires the DNS + verifier backends and
// the db-backed pipeline ports, and hands back a ready-to-run dependency set.

import type { BootContext, Env, Logger } from '@mailmetero/config';
import { verifierEnabled } from '@mailmetero/config';
import type {
  HardCaps,
  Domain,
  LocalPart,
  SizeBracket,
  Provider,
  IsoTimestamp,
  SuppressionHash,
} from '@mailmetero/contracts';
import { SIZE_BRACKETS } from '@mailmetero/contracts';
import {
  createPools,
  createJobsRepo,
  createLedgerRepo,
  createResultsRepo,
  createTenantsRepo,
  createSuppressionRepo,
  createKbClassificationRepo,
  createKbDomainsRepo,
  createKbDomainPatternsRepo,
  createPatternPriorsRepo,
  createKbProviderFingerprintsRepo,
  createScoringConfigRepo,
  type DbPools,
  type JobsRepo,
  type LedgerRepo,
  type ResultsRepo,
  type TenantsRepo,
} from '@mailmetero/db';
import { createFetchDohTransport, createDnsResolver, SEED_FINGERPRINT_RULES, type FingerprintRule } from '@mailmetero/dns';
import {
  createFetchVendorClient,
  createHttpsApiBackend,
  createNullBackend,
  createCatchAllProbe,
  DEFAULT_MILLIONVERIFIER_RESULT_MAP,
} from '@mailmetero/verifier';
import {
  createPipeline,
  createCoreAdapter,
  type Pipeline,
  type PipelineDeps,
  type SuppressionPort,
  type ClassificationPort,
  type KbFactsPort,
  type KbWritebackPort,
  type TenantCachePort,
} from '@mailmetero/pipeline';
import type { VerifierBackend } from '@mailmetero/contracts';
import type { PatternPrior, PatternPriorTable } from '@mailmetero/core';

/** Static worker tuning, derived once from Env. */
export interface WorkerConfig {
  /** Stable-ish identity written to jobs.locked_by; used for heartbeat ownership. */
  workerId: string;
  /** Jobs claimed per SKIP LOCKED batch. */
  batchSize: number;
  /** Idle backoff window when a claim returns zero jobs (random ms in [min,max]). */
  idleBackoffMinMs: number;
  idleBackoffMaxMs: number;
  /** Visibility window granted on claim/heartbeat before a job is considered stuck. */
  visibilityMs: number;
  /** Heartbeat cadence while a job is processing (< visibilityMs). */
  heartbeatMs: number;
  /** Job attempt ceiling before a stuck job is failed. */
  maxAttempts: number;
  /** Max item settlements in flight within a single job. */
  itemConcurrency: number;
  /** Grace period on SIGTERM/SIGINT for the in-flight job to drain. */
  shutdownGraceMs: number;
}

/**
 * Resolved runtime dependencies. `pools` exposes the UNPOOLED direct pool the processors use
 * for claims, long transactions and session state (D20). `billingCaps` is the LIVE
 * `ScoringConfig.caps` (D8) — never a literal — so `decideBilling` stays DB-tunable.
 *
 * NOTE: `itemConcurrency` is carried here (alongside `billingCaps`) because `JobProcessor.process`
 * receives only `(job, deps, signal)` — it is the sole channel by which a per-job processor can
 * bound its in-flight item work. It is copied verbatim from `WorkerConfig.itemConcurrency`.
 */
export interface WorkerDeps {
  pools: DbPools;
  jobs: JobsRepo;
  ledger: LedgerRepo;
  results: ResultsRepo;
  tenants: TenantsRepo;
  pipeline: Pipeline;
  billingCaps: HardCaps;
  logger: Logger;
  itemConcurrency: number;
}

const DEFAULT_KB_FACTS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d KB-fact freshness window

function envInt(source: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Derive the static WorkerConfig from validated Env (+ optional WORKER_* overrides). */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const source = process.env as Record<string, string | undefined>;
  const host = source['RENDER_INSTANCE_ID'] ?? source['HOSTNAME'] ?? 'local';
  return {
    workerId: `${env.serviceRole}-${host}-${process.pid}`,
    batchSize: envInt(source, 'WORKER_BATCH_SIZE', 5),
    idleBackoffMinMs: envInt(source, 'WORKER_IDLE_MIN_MS', 30_000),
    idleBackoffMaxMs: envInt(source, 'WORKER_IDLE_MAX_MS', 60_000),
    visibilityMs: envInt(source, 'WORKER_VISIBILITY_MS', 60_000),
    heartbeatMs: envInt(source, 'WORKER_HEARTBEAT_MS', 15_000),
    maxAttempts: envInt(source, 'WORKER_MAX_ATTEMPTS', 5),
    itemConcurrency: envInt(source, 'WORKER_ITEM_CONCURRENCY', 8),
    shutdownGraceMs: envInt(source, 'WORKER_SHUTDOWN_GRACE_MS', 25_000),
  };
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function emptyPriorTable(): Record<SizeBracket, PatternPrior[]> {
  const table = {} as Record<SizeBracket, PatternPrior[]>;
  for (const bracket of SIZE_BRACKETS) table[bracket] = [];
  return table;
}

/**
 * Composition root. Opens pools, loads the live scoring/prior/fingerprint tables from the KB,
 * wires DNS + verifier + the db-backed pipeline ports, and assembles the Pipeline. Runs on the
 * unpooled direct pool for every operation.
 */
export async function buildWorkerDeps(boot: BootContext): Promise<WorkerDeps> {
  const { env, logger, egressFetch, appConfig } = boot;
  const cfg = loadWorkerConfig(env);
  const clock = (): number => Date.now();

  const pools = createPools(appConfig);
  const direct = pools.direct;

  const jobs = createJobsRepo();
  const ledger = createLedgerRepo();
  const results = createResultsRepo();
  const tenants = createTenantsRepo();
  const suppressionRepo = createSuppressionRepo();
  const classificationRepo = createKbClassificationRepo();
  const kbDomainsRepo = createKbDomainsRepo();
  const kbPatternsRepo = createKbDomainPatternsRepo();
  const priorsRepo = createPatternPriorsRepo();
  const fingerprintsRepo = createKbProviderFingerprintsRepo();
  const scoringRepo = createScoringConfigRepo();

  // ── live scoring config + priors + fingerprints (D8) ────────────────────────
  const scoringConfig = await scoringRepo.loadActive(direct);

  const priorRows = await priorsRepo.loadAll(direct);
  const priorTable = emptyPriorTable();
  for (const row of priorRows) {
    const bucket = priorTable[row.sizeBracket];
    if (bucket) bucket.push({ token: row.patternToken, weight: row.share });
  }
  const priors = priorTable as PatternPriorTable;

  const fingerprintRows = await fingerprintsRepo.loadAll(direct);
  const fingerprintRules: FingerprintRule[] =
    fingerprintRows.length > 0
      ? fingerprintRows.map((r) => ({ suffix: r.mxSuffix, provider: r.provider as Provider }))
      : [...SEED_FINGERPRINT_RULES];

  // ── DNS resolver (DoH over the egress choke point) ──────────────────────────
  const dohAllowlist = Array.from(
    new Set(
      ['dns.google', 'cloudflare-dns.com', hostnameOf(env.dohPrimaryUrl), hostnameOf(env.dohFallbackUrl)].filter(
        (h): h is string => h !== null,
      ),
    ),
  );
  const dohTransport = createFetchDohTransport({ fetch: egressFetch, allowlist: dohAllowlist });
  const resolver = createDnsResolver(dohTransport, clock);

  // ── verifier backend (HTTPS vendor, or NullBackend on kill switch / no key) ──
  let backend: VerifierBackend;
  if (verifierEnabled(env) && env.verifierApiKey !== null) {
    const verifierHost = hostnameOf(env.verifierApiBaseUrl);
    const verifierAllowlist = [...env.egressExtraHosts, ...(verifierHost ? [verifierHost] : [])];
    const client = createFetchVendorClient({
      fetch: egressFetch,
      baseUrl: env.verifierApiBaseUrl,
      apiKey: env.verifierApiKey,
      allowlist: verifierAllowlist,
    });
    backend = createHttpsApiBackend(client, {
      timeoutMs: scoringConfig.caps.SYNC_VERIFY_BUDGET_MS,
      resultMap: DEFAULT_MILLIONVERIFIER_RESULT_MAP,
    });
  } else {
    backend = createNullBackend('backend_unavailable');
  }
  const catchAllProbe = createCatchAllProbe(backend);

  // ── db-backed pipeline ports ────────────────────────────────────────────────
  const suppression: SuppressionPort = {
    isSuppressed: (hashes: SuppressionHash[]) => suppressionRepo.isSuppressed(direct, hashes),
  };
  const classification: ClassificationPort = {
    isFreemail: (domain: Domain) => classificationRepo.isFreemail(direct, domain),
    isDisposable: (domain: Domain) => classificationRepo.isDisposable(direct, domain),
    isRoleLocal: (local: LocalPart) => classificationRepo.isRoleLocal(direct, local),
    correctTypoDomain: (domain: Domain) => classificationRepo.typoCorrection(direct, domain),
  };
  const kbFacts: KbFactsPort = {
    async getDomainFacts(domain: Domain) {
      const row = await kbDomainsRepo.get(direct, domain);
      if (row === null) return null;
      const ttlFresh = row.expiresAt !== null && Date.parse(row.expiresAt) > clock();
      return {
        mx: row.mxEnum,
        provider: row.provider,
        verifiabilityClass: row.verifiabilityClass,
        isCatchAll: row.isCatchAll,
        lastProbedAt: row.lastProbedAt,
        ttlFresh,
      };
    },
    async getDomainPatterns(domain: Domain) {
      const rows = await kbPatternsRepo.listForDomain(direct, domain);
      return rows.map((r) => ({
        patternToken: r.patternToken,
        observedCount: r.observedCount,
        verifiedCount: r.verifiedCount,
        lastSeenAt: r.lastSeenAt,
        winningFold: r.winningFold,
      }));
    },
  };
  const kbWriteback: KbWritebackPort = {
    async upsertDomainFacts(facts) {
      const expiresAt = new Date(clock() + DEFAULT_KB_FACTS_TTL_MS).toISOString() as IsoTimestamp;
      await kbDomainsRepo.upsertFacts(direct, {
        domain: facts.domain,
        mxEnum: facts.mx,
        provider: facts.provider,
        verifiabilityClass: facts.verifiabilityClass,
        isCatchAll: facts.isCatchAll,
        hasSpf: facts.spfPresent,
        hasDmarc: facts.dmarcPresent,
        lastProbedAt: facts.probedAt,
        expiresAt,
      });
    },
    async recordPatternObservation(obs) {
      if (obs.verified) {
        await kbPatternsRepo.bumpVerified(direct, obs.domain, obs.pattern, obs.acceptAllDomain);
      } else {
        await kbPatternsRepo.bumpObserved(direct, obs.domain, obs.pattern);
      }
    },
  };
  // Worker does NOT reuse the per-tenant verdict cache: it recomputes each item deterministically
  // (safe — never serves a stale wrong verdict; the write side is ResultsRepo.insert).
  const tenantCache: TenantCachePort = {
    async lookup() {
      return null;
    },
  };

  const coreAdapter = createCoreAdapter({ priors, config: scoringConfig });

  const pipelineDeps: PipelineDeps = {
    resolver,
    backend,
    catchAllProbe,
    fingerprintRules,
    scoringConfig,
    clock,
    suppression,
    classification,
    tenantCache,
    kbFacts,
    kbWriteback,
    candidates: coreAdapter.candidates,
    scorer: coreAdapter.scorer,
  };
  const pipeline = createPipeline(pipelineDeps);

  return {
    pools,
    jobs,
    ledger,
    results,
    tenants,
    pipeline,
    billingCaps: scoringConfig.caps,
    logger,
    itemConcurrency: cfg.itemConcurrency,
  };
}
