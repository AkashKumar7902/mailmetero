// @mailmetero/api — buildApiDeps: wire the real db repos, dns/verifier backends, pipeline, and email
// backend into the ApiDeps ports the Fastify service consumes.
//
// Every db repo method takes a `Queryable`; these adapters bind the pooled web pool (D20). The
// pipeline is assembled once at boot from the live ScoringConfig + priors (D8). The route/plugin
// layer only ever sees the port interfaces, so the same server is exercised in tests with fakes.

import { randomUUID } from 'node:crypto';
import type { BootContext } from '@mailmetero/config';
import type {
  IsoTimestamp,
  TenantId,
  RequestId,
  SizeBracket,
  Domain,
  EmailAddress,
  AccountInfo,
} from '@mailmetero/contracts';
import { SIZE_BRACKETS } from '@mailmetero/contracts';
import {
  createKeyAuthenticator,
  createTenantsRepo,
  createResultsRepo,
  createLedgerRepo,
  createRateCountersRepo,
  createIdempotencyRepo,
  createJobsRepo,
  createKbDomainsRepo,
  createKbDomainPatternsRepo,
  createKbClassificationRepo,
  createSuppressionRepo,
  createObjectionsRepo,
  createDsarRepo,
  createPatternPriorsRepo,
  createScoringConfigRepo,
  decideBilling,
  withTransaction,
  maybeOne,
  sha256Hex,
  computeSuppressionHash,
  type DbPools,
  type ResultRow,
} from '@mailmetero/db';
import { createDnsResolver, createFetchDohTransport, SEED_FINGERPRINT_RULES } from '@mailmetero/dns';
import {
  createHttpsApiBackend,
  createNullBackend,
  createFetchVendorClient,
  createCatchAllProbe,
  DEFAULT_MILLIONVERIFIER_RESULT_MAP,
} from '@mailmetero/verifier';
import { makeNoopBackend, makePostmarkBackend, buildSignupKeyEmail, buildObjectionConfirmationEmail } from '@mailmetero/email';
import { createPipeline, createCoreAdapter } from '@mailmetero/pipeline';
import type { InternalFinderResult, InternalVerifierResult } from '@mailmetero/pipeline';
import type { PatternPriorTable } from '@mailmetero/core';
import { normalizeName, classifyDomainInput, ROLE_LOCALS_BUILTIN, canonicalizeDomain, canonicalizeEmail } from '@mailmetero/core';
import type { ApiDeps, StoredResponse } from './deps.ts';
import type { EndpointId } from './types.ts';
import { createSandboxRouter } from './sandbox/router.ts';

const DOH_HOSTS = ['dns.google', 'cloudflare-dns.com'] as const;
const RATE_LIMIT_PER_MINUTE = 120;
const GET_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const DOCS_URL = 'https://mailmetero.com/docs';
const RESULT_TTL_FALLBACK_DAYS = 90;

// ── Public-intake abuse throttle (M3/M5). The objection IP dimension is DB-backed + persistent
// (objections.recentByIp); the per-target-email dimension (and both signup dimensions) are a
// best-effort in-memory sliding window — defense-in-depth so an attacker cannot email-bomb an
// address or farm free-tier keys. All throttled requests collapse into the SAME constant 202 ack.
const INTAKE_WINDOW_MS = 60 * 60 * 1000;
const INTAKE_WINDOW_SECONDS = 60 * 60;
const SIGNUP_IP_MAX = 10;
const SIGNUP_EMAIL_MAX = 3;
const OBJECTION_IP_MAX = 5;
const OBJECTION_EMAIL_MAX = 3;
const OBJECTION_TTL_SECONDS = 24 * 60 * 60;

function toLedgerEndpoint(endpoint: EndpointId): 'finder' | 'verifier' {
  return endpoint === 'email_finder' ? 'finder' : 'verifier';
}

/** Best-effort in-memory sliding-window counter. `exceeded(key)` records a hit and reports whether
 *  the key is over `maxHits` in the last `windowMs`. Coarsely bounded so it can never leak memory. */
function makeIntakeThrottle(maxHits: number, windowMs: number): { exceeded(key: string): boolean } {
  const hits = new Map<string, number[]>();
  const MAX_KEYS = 50_000;
  return {
    exceeded(key: string): boolean {
      const now = Date.now();
      if (hits.size > MAX_KEYS) hits.clear();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= maxHits) {
        hits.set(key, recent);
        return true;
      }
      recent.push(now);
      hits.set(key, recent);
      return false;
    },
  };
}

/**
 * Project an internal sync result into a persistable `results` row (m3). Persisting sync
 * finder/verifier results (not just async-job results) makes DSAR export/delete and the 90-day TTL
 * purge cover the PRIMARY request path. Mirrors the worker's row construction (worker/src/item.ts).
 */
function buildSyncResultRow(input: {
  tenantId: TenantId;
  requestId: RequestId;
  endpoint: 'finder' | 'verifier';
  result: InternalFinderResult | InternalVerifierResult;
  billed: boolean;
  expiresAt: IsoTimestamp;
}): Omit<ResultRow, 'id' | 'createdAt'> {
  const { tenantId, requestId, endpoint, result, billed, expiresAt } = input;
  const v = result.verification;
  if (endpoint === 'finder') {
    const r = result as InternalFinderResult;
    return {
      tenantId,
      requestId,
      endpoint: 'finder',
      requestHash: sha256Hex(`find:${r.domain}:${r.firstName ?? ''}:${r.lastName ?? ''}:`),
      inputFirstName: r.firstName,
      inputLastName: r.lastName,
      inputMiddleName: null,
      inputFullName: null,
      inputDomain: r.domain,
      inputEmail: null,
      email: r.email,
      status: r.status,
      subStatus: r.subStatus,
      score: r.score,
      reasonCodes: r.reasonCodes,
      provider: r.provider,
      backend: r.backend,
      evidence: r.evidence,
      collisionRisk: r.collisionRisk,
      acceptAll: null,
      disposable: null,
      webmail: null,
      mxRecords: v.mx !== null ? v.mx !== 'NO_MAIL_HOST' && v.mx !== 'NULL_MX' : null,
      smtpCheck: null,
      rawSmtpCode: v.rawSmtpCode,
      enhancedCode: v.enhancedCode,
      candidates: r.candidates.map((c) => ({ email: c.email, score: c.score, reason_codes: c.reasonCodes })),
      source: 'derivation',
      billed,
      verifiedAt: v.verifiedAt,
      expiresAt,
    };
  }
  const r = result as InternalVerifierResult;
  const at = r.email.lastIndexOf('@');
  const dom = at >= 0 ? canonicalizeDomain(r.email.slice(at + 1)) : null;
  return {
    tenantId,
    requestId,
    endpoint: 'verifier',
    requestHash: sha256Hex(`verify:${r.email}`),
    inputFirstName: null,
    inputLastName: null,
    inputMiddleName: null,
    inputFullName: null,
    inputDomain: dom,
    inputEmail: r.email,
    email: r.email,
    status: r.status,
    subStatus: r.subStatus,
    score: r.score,
    reasonCodes: r.reasonCodes,
    provider: r.provider,
    backend: r.backend,
    evidence: r.evidence,
    collisionRisk: false,
    acceptAll: r.acceptAll,
    disposable: r.disposable,
    webmail: r.webmail,
    mxRecords: r.mxRecords,
    smtpCheck: r.smtpCheck,
    rawSmtpCode: r.rawSmtpCode,
    enhancedCode: v.enhancedCode,
    candidates: [],
    source: 'derivation',
    billed,
    verifiedAt: v.verifiedAt,
    expiresAt,
  };
}

/** Group the flat pattern-prior rows into the SizeBracket-keyed table the core adapter expects. */
function buildPriorTable(rows: Array<{ sizeBracket: SizeBracket; patternToken: string; share: number }>): PatternPriorTable {
  const table = {} as Record<SizeBracket, Array<{ token: string; weight: number }>>;
  for (const b of SIZE_BRACKETS) table[b] = [];
  for (const r of rows) {
    const bucket = table[r.sizeBracket];
    if (bucket) bucket.push({ token: r.patternToken, weight: r.share });
  }
  return table as unknown as PatternPriorTable;
}

export async function buildApiDeps(input: { boot: BootContext; pools: DbPools }): Promise<ApiDeps> {
  const { boot, pools } = input;
  const { env, appConfig, egressFetch, logger } = boot;
  const web = pools.web;

  // ── repos ──────────────────────────────────────────────────────────────────
  const tenants = createTenantsRepo();
  const results = createResultsRepo();
  const ledger = createLedgerRepo();
  const rateCounters = createRateCountersRepo();
  const idempotencyRepo = createIdempotencyRepo();
  const jobsRepo = createJobsRepo();
  const kbDomains = createKbDomainsRepo();
  const kbPatterns = createKbDomainPatternsRepo();
  const kbClassification = createKbClassificationRepo();
  const suppression = createSuppressionRepo();
  const objections = createObjectionsRepo({ salt: env.suppressionSalt, suppression });
  const dsar = createDsarRepo();
  const priorsRepo = createPatternPriorsRepo();
  const scoringRepo = createScoringConfigRepo();

  // Best-effort in-memory intake throttles (M3/M5); see makeIntakeThrottle.
  const signupIpThrottle = makeIntakeThrottle(SIGNUP_IP_MAX, INTAKE_WINDOW_MS);
  const signupEmailThrottle = makeIntakeThrottle(SIGNUP_EMAIL_MAX, INTAKE_WINDOW_MS);
  const objectionEmailThrottle = makeIntakeThrottle(OBJECTION_EMAIL_MAX, INTAKE_WINDOW_MS);

  const auth = createKeyAuthenticator(pools, appConfig);
  const scoringConfig = await scoringRepo.loadActive(web);
  const priorRows = await priorsRepo.loadAll(web);
  const priors = buildPriorTable(priorRows);

  // ── verifier backend + dns resolver + core adapter ───────────────────────────
  const backend =
    env.verifierApiKey !== null
      ? createHttpsApiBackend(
          createFetchVendorClient({
            fetch: egressFetch,
            baseUrl: env.verifierApiBaseUrl,
            apiKey: env.verifierApiKey,
            allowlist: [new URL(env.verifierApiBaseUrl).host],
          }),
          { timeoutMs: 8000, resultMap: DEFAULT_MILLIONVERIFIER_RESULT_MAP },
        )
      : createNullBackend();
  const catchAllProbe = createCatchAllProbe(backend);
  const resolver = createDnsResolver(
    createFetchDohTransport({ fetch: egressFetch, allowlist: [...DOH_HOSTS] }),
    () => Date.now(),
  );
  const coreAdapter = createCoreAdapter({ priors, config: scoringConfig });

  const pipeline = createPipeline({
    resolver,
    backend,
    catchAllProbe,
    fingerprintRules: SEED_FINGERPRINT_RULES,
    scoringConfig,
    clock: () => Date.now(),
    candidates: coreAdapter.candidates,
    scorer: coreAdapter.scorer,
    suppression: {
      // Reconcile the pipeline's raw values with the salted hashes written on objection-confirm:
      // hash each candidate/domain with the SAME computeSuppressionHash(value, salt) used on write.
      isSuppressed: (values) =>
        suppression.isSuppressed(
          web,
          values.map((v) => computeSuppressionHash(v, env.suppressionSalt)),
        ),
    },
    classification: {
      isFreemail: (domain) => kbClassification.isFreemail(web, domain),
      isDisposable: (domain) => kbClassification.isDisposable(web, domain),
      isRoleLocal: (local) => kbClassification.isRoleLocal(web, local),
      correctTypoDomain: (domain) => kbClassification.typoCorrection(web, domain),
    },
    tenantCache: {
      // Read-only verdict cache; a miss simply re-runs the pipeline (api persists via ResultsRepo).
      lookup: async () => null,
    },
    kbFacts: {
      getDomainFacts: async (domain) => {
        const row = await kbDomains.get(web, domain);
        if (row === null) return null;
        return {
          mx: row.mxEnum,
          provider: row.provider,
          verifiabilityClass: row.verifiabilityClass,
          isCatchAll: row.isCatchAll,
          lastProbedAt: row.lastProbedAt,
          ttlFresh: Date.parse(row.expiresAt) > Date.now(),
        };
      },
      getDomainPatterns: async (domain) => {
        const rows = await kbPatterns.listForDomain(web, domain);
        return rows.map((r) => ({
          patternToken: r.patternToken,
          observedCount: r.observedCount,
          verifiedCount: r.verifiedCount,
          lastSeenAt: r.lastSeenAt,
          winningFold: r.winningFold,
        }));
      },
    },
    kbWriteback: {
      upsertDomainFacts: async (facts) => {
        await kbDomains.upsertFacts(web, {
          domain: facts.domain,
          mxEnum: facts.mx,
          provider: facts.provider,
          verifiabilityClass: facts.verifiabilityClass,
          isCatchAll: facts.isCatchAll,
          hasSpf: facts.spfPresent,
          hasDmarc: facts.dmarcPresent,
          lastProbedAt: facts.probedAt,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() as IsoTimestamp,
        });
      },
      recordPatternObservation: async (obs) => {
        if (obs.verified) await kbPatterns.bumpVerified(web, obs.domain, obs.pattern, obs.acceptAllDomain);
        else await kbPatterns.bumpObserved(web, obs.domain, obs.pattern);
      },
    },
  });

  // ── email backend ────────────────────────────────────────────────────────────
  const emailBackend =
    env.espApiKey !== null
      ? makePostmarkBackend({
          fetch: egressFetch,
          baseUrl: env.espApiBaseUrl,
          apiKey: env.espApiKey,
          fromEmail: env.espFromEmail,
          messageStream: env.espMessageStream,
          logger,
        })
      : makeNoopBackend(logger);

  // Reserve-id map so finalizePost can address the row lookupOrReserveHeaderKey created.
  const reserveIds = new Map<string, string>();
  const reserveKey = (tenantId: TenantId, endpoint: EndpointId, key: string) => `${tenantId}:${endpoint}:${key}`;

  const scoring = { current: () => scoringRepo.loadActive(web) };

  // Public web-tool tenant that backs the no-key finder page (`/` + `/app/find`). Idempotent
  // bootstrap so it exists on any deploy; carries 0 credits (the web path never bills).
  let webTenant = await tenants.byOwnerEmail(web, 'web@mailmetero.internal');
  if (webTenant === null) {
    webTenant = await tenants.create(web, { ownerEmail: 'web@mailmetero.internal', planName: 'web-tool', creditsRemaining: 0 });
  }

  const deps: ApiDeps = {
    config: appConfig.api,
    auth,
    scoring,
    pipeline,
    webTenantId: webTenant.id,
    sandbox: createSandboxRouter(),
    core: {
      normalizeName,
      classifyDomainInput,
      nicknameMap: {
        forward: new Map<string, readonly string[]>(),
        reverse: new Map<string, readonly string[]>(),
      },
      classificationTables: {
        freemail: new Set<string>(),
        disposable: new Set<string>(),
        roleLocals: ROLE_LOCALS_BUILTIN,
        typoDomains: new Map<string, Domain>(),
      },
    },

    rateLimiter: {
      async consumeAttempt(principal, now) {
        const windowSeconds = 60;
        const nowMs = Date.parse(now);
        const windowStartMs = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
        const windowStart = new Date(windowStartMs).toISOString() as IsoTimestamp;
        const res = await rateCounters.incrementAndGet(web, {
          apiKeyId: principal.keyId,
          windowStart,
          windowSeconds,
          limitMax: RATE_LIMIT_PER_MINUTE,
        });
        return {
          limit: res.limitMax,
          remaining: Math.max(0, res.limitMax - res.count),
          resetEpochSeconds: Math.floor(Date.parse(res.resetAt) / 1000),
          exceeded: res.count > res.limitMax,
        };
      },
      // Read-only snapshot (never increments) so every response can carry the X-RateLimit-* triple
      // (M6). A null principal returns the unauthenticated bucket used to fill the triple on a 401.
      async peek(principal, now) {
        const windowSeconds = 60;
        const nowMs = Date.parse(now);
        const windowStartMs = Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
        const resetEpochSeconds = Math.floor((windowStartMs + windowSeconds * 1000) / 1000);
        if (principal === null) {
          return { limit: RATE_LIMIT_PER_MINUTE, remaining: RATE_LIMIT_PER_MINUTE, resetEpochSeconds };
        }
        const windowStart = new Date(windowStartMs).toISOString() as IsoTimestamp;
        const row = await maybeOne<{ count: number }>(
          web,
          `SELECT count FROM rate_counters WHERE api_key_id = $1 AND window_start = $2`,
          [principal.keyId, windowStart],
        );
        const count = row?.count ?? 0;
        return { limit: RATE_LIMIT_PER_MINUTE, remaining: Math.max(0, RATE_LIMIT_PER_MINUTE - count), resetEpochSeconds };
      },
    },

    ledger: {
      async settle({ principal, requestId, endpoint, result, billingInput }) {
        const caps = scoringConfig.caps;
        const decision = decideBilling(billingInput, caps);
        const ledgerEndpoint = toLedgerEndpoint(endpoint);

        // ONE transaction (M2, mirroring worker/src/item.ts): persist the sync result (m3), record
        // the idempotent attempt, then debit EXACTLY the delta the ledger applied — never a locally
        // recomputed predicate. On an ON-CONFLICT retry the ledger returns delta 0, so no debit fires
        // even when decision.billable is true (the previous bug divergently over-debited).
        const { creditsRemaining, resultId } = await withTransaction(web, async (tx) => {
          const tenant = await tenants.byId(tx, principal.tenantId);
          const retentionDays =
            tenant !== null && tenant.retentionDays > 0 ? tenant.retentionDays : RESULT_TTL_FALLBACK_DAYS;
          const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString() as IsoTimestamp;

          const inserted = await results.insert(
            tx,
            buildSyncResultRow({
              tenantId: principal.tenantId,
              requestId,
              endpoint: ledgerEndpoint,
              result,
              billed: decision.billable,
              expiresAt,
            }),
          );

          const { creditsDeltaApplied } = await ledger.recordAttempt(tx, {
            tenantId: principal.tenantId,
            requestId,
            endpoint: ledgerEndpoint,
            decision,
            resultStatus: result.status,
            resultSubStatus: result.subStatus,
            resultScore: result.score,
            backend: result.backend,
            evidence: result.evidence,
            resultId: inserted.id,
          });

          if (creditsDeltaApplied < 0) {
            const bal = await tenants.tryDebitCredit(tx, principal.tenantId, -creditsDeltaApplied);
            const balance =
              bal ?? (await tenants.byId(tx, principal.tenantId))?.creditsRemaining ?? tenant?.creditsRemaining ?? 0;
            return { creditsRemaining: balance, resultId: inserted.id };
          }
          return { creditsRemaining: tenant?.creditsRemaining ?? 0, resultId: inserted.id };
        });

        return { billed: decision.billable, creditsRemaining, resultId };
      },
      async creditsRemaining(tenantId) {
        return (await tenants.byId(web, tenantId))?.creditsRemaining ?? 0;
      },
    },

    idempotency: {
      async reservePost({ tenantId, idempotencyKey, endpoint, requestHash }) {
        const res = await idempotencyRepo.lookupOrReserveHeaderKey(web, {
          tenantId,
          endpoint,
          idempotencyKey,
          requestHash,
        });
        if (res.kind === 'fresh') {
          reserveIds.set(reserveKey(tenantId, endpoint, idempotencyKey), res.id);
          return { kind: 'fresh' };
        }
        if (res.kind === 'conflict') return { kind: 'conflict' };
        return { kind: 'replay', stored: res.responseRef as StoredResponse };
      },
      async finalizePost({ tenantId, idempotencyKey, endpoint, stored }) {
        const id = reserveIds.get(reserveKey(tenantId, endpoint, idempotencyKey));
        if (id === undefined) return;
        await idempotencyRepo.finalizeHeaderKey(web, id, stored, stored.httpStatus);
        reserveIds.delete(reserveKey(tenantId, endpoint, idempotencyKey));
      },
      async lookupGet(tenantId, requestHash, endpoint) {
        const row = await idempotencyRepo.lookupRequestHash(web, tenantId, endpoint, requestHash);
        if (row === null) return null;
        return row.responseRef as StoredResponse;
      },
      async recordGet(tenantId, requestHash, endpoint, resp) {
        await idempotencyRepo.storeRequestHash(web, {
          tenantId,
          endpoint,
          requestHash,
          responseRef: resp,
          statusCode: resp.httpStatus,
          ttlSeconds: GET_DEDUPE_TTL_SECONDS,
        });
      },
    },

    account: {
      async getAccount(tenantId): Promise<AccountInfo> {
        const t = await tenants.byId(web, tenantId);
        if (t === null) throw new Error('tenant not found');
        const usage = await ledger.getUsage(web, tenantId, null, null);
        const reset = new Date(Date.parse(t.quotaPeriodStart) + 30 * 24 * 60 * 60 * 1000).toISOString();
        // Per-endpoint used counts are approximated from total attempts pending a split query in db.
        return {
          email: t.ownerEmail,
          plan_name: t.planName,
          requests: {
            searches: { used: usage.attempts, available: t.searchQuota },
            verifications: { used: usage.attempts, available: t.verifyQuota },
          },
          reset_date: reset,
        };
      },
      async getUsage(tenantId, from, to) {
        return ledger.getUsage(web, tenantId, from ?? null, to ?? null);
      },
    },

    jobs: {
      enqueueBulkFinds(tenantId, requestId, idempotencyKey, rows) {
        return jobsRepo.createJob(web, {
          tenantId,
          kind: 'bulk_find',
          requestId,
          idempotencyKey,
          items: rows.map((r, i) => ({ rowIndex: i, input: r })),
        });
      },
      enqueueBulkVerifications(tenantId, requestId, idempotencyKey, emails) {
        return jobsRepo.createJob(web, {
          tenantId,
          kind: 'bulk_verify',
          requestId,
          idempotencyKey,
          items: emails.map((email, i) => ({ rowIndex: i, input: { email } })),
        });
      },
      enqueueVerification(tenantId, email, requestId) {
        return jobsRepo.enqueueVerification(web, tenantId, email, requestId);
      },
      getJob(tenantId, jobId) {
        return jobsRepo.getJobStatus(web, tenantId, jobId);
      },
      async getJobResults(tenantId, jobId, limit, offset) {
        const status = await jobsRepo.getJobStatus(web, tenantId, jobId);
        if (status === null) return null;
        return jobsRepo.getJobResults(web, tenantId, jobId, limit, offset);
      },
      async getVerification(tenantId, jobId) {
        const res = await jobsRepo.getVerificationResult(web, tenantId, jobId);
        if (res.kind === 'not_found') return null;
        return res;
      },
    },

    email: {
      async sendSignupConfirmation(email, token) {
        const msg = buildSignupKeyEmail({ to: email, apiKeyPlaintext: token, docsUrl: DOCS_URL });
        await emailBackend.send(msg);
      },
      async sendObjectionConfirmation(email, token) {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        // The confirm link must point at OUR public API host (M4), not the ESP host — otherwise the
        // click never reaches GET /v2/objections/confirm and the irreversible suppression is never
        // written (a silently-failing GDPR/CAN-SPAM opt-out).
        const msg = buildObjectionConfirmationEmail({
          to: email,
          confirmUrl: `${env.publicBaseUrl.replace(/\/$/, '')}/v2/objections/confirm?token=${encodeURIComponent(token)}`,
          expiresAt,
        });
        await emailBackend.send(msg);
      },
    },

    compliance: {
      async createSignup(email, clientIp) {
        // Disposable-domain signups are blocked (D12). Key issuance completes on email confirmation
        // (out of buildApiDeps scope); we return the confirmation token to be emailed.
        const domain = canonicalizeDomain(email.split('@')[1] ?? '');
        if (domain !== null && (await kbClassification.isDisposable(web, domain))) {
          return { blocked: 'disposable' };
        }
        // Per-IP + per-target-email throttle (M3): an unbounded public endpoint that emails an
        // attacker-supplied address is free-tier farming + email-bombing. Throttled → constant 202.
        if (signupIpThrottle.exceeded(sha256Hex(clientIp)) || signupEmailThrottle.exceeded(email.toLowerCase())) {
          return { rateLimited: true };
        }
        return { token: randomUUID() };
      },
      async createObjection(email, clientIp) {
        // Wire the real hash-only objection intake (B1): persist token_hash + salted subject/domain
        // suppression hashes; the emailed token's confirm step writes the irreversible suppression.
        const rawDomain = email.split('@')[1] ?? '';
        const domain = canonicalizeDomain(rawDomain);
        // Per-IP (DB-backed, persistent) + per-target-email (in-memory) throttle before sending mail
        // (M5) — anti-poisoning: the same constant 202 ack whether accepted or throttled.
        const ipRecent = await objections.recentByIp(web, clientIp, INTAKE_WINDOW_SECONDS);
        if (ipRecent >= OBJECTION_IP_MAX || objectionEmailThrottle.exceeded(email.toLowerCase())) {
          return { rateLimited: true };
        }
        // Canonicalize the subject email the SAME way the pipeline canonicalizes candidates/verify
        // targets (lowercase + trim), so the salted write hash reconciles with the read hash.
        const canonicalEmail = canonicalizeEmail(email) ?? (email.trim().toLowerCase() as EmailAddress);
        const { token } = await objections.createPending(web, {
          email: canonicalEmail,
          domain: domain ?? (rawDomain as Domain),
          scope: 'address',
          requestIp: clientIp,
          ttlSeconds: OBJECTION_TTL_SECONDS,
        });
        return { token };
      },
      async confirmObjection(token) {
        // The status flip + writeSuppression must commit atomically (B1): run confirm() inside one
        // transaction so a suppression row is written only for a verified opt-out.
        return withTransaction(web, (tx) => objections.confirm(tx, token));
      },
      async dsarExport(tenantId, email) {
        return dsar.exportForSubject(web, tenantId, email as EmailAddress);
      },
      async dsarDelete(tenantId, email) {
        await dsar.deleteForSubject(web, tenantId, email as EmailAddress);
      },
      async healthPing() {
        try {
          await tenants.byId(web, randomUUID() as TenantId);
          return true;
        } catch {
          return false;
        }
      },
    },
  };

  return deps;
}
