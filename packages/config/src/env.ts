// @mailmetero/config — the typed environment contract.
// SINGLE authority for every env var. `loadEnv()` validates the whole process
// environment at boot and THROWS an aggregated EnvError on any problem (fail-fast:
// a misconfigured deploy must never accept traffic). No external validation library
// (supply-chain minimalism, P0-11) — a tiny hand-rolled typed parser instead.

import { fileURLToPath } from 'node:url';

export type ServiceRole = 'web' | 'worker' | 'cron';
export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Absolute anchor for the vendored data dir (nicknames, blocklists, priors).
 * Resolved from the module URL so it is correct regardless of process cwd, and
 * identical whether running the TS source (`src/`) or the built output (`dist/`)
 * — both are siblings at the same depth under the package root (ARCHITECTURE §"seed vendor dir").
 */
const DEFAULT_VENDOR_DIR = fileURLToPath(new URL('../../../data/vendor', import.meta.url));

/** Fully-validated, frozen runtime configuration. Everything downstream reads THIS. */
export interface Env {
  readonly nodeEnv: NodeEnv;
  readonly serviceRole: ServiceRole;
  readonly port: number; // web only; 0 for worker/cron
  readonly logLevel: LogLevel;

  // ── database (D20) ──
  /** Pooled (-pooler) DSN. Web request pool binds here. */
  readonly databaseUrl: string;
  /** Direct DSN. Worker, cron and migrations bind here. */
  readonly databaseUrlUnpooled: string;
  /** Chosen for THIS role: web→pooled, worker/cron→unpooled. */
  readonly databaseUrlForRole: string;
  readonly databaseUrlTest: string | null;
  readonly poolMaxWeb: number;                // default 8
  readonly poolMaxWorker: number;             // default 4
  readonly statementTimeoutMs: number;        // default 8000 (set via DSN options, never post-connect SET)
  readonly connTimeoutMs: number;             // default 5000

  // ── secrets ──
  readonly appPepper: string;                // >=32 chars
  readonly appPepperPrevious: string | null; // rotation window (OQ8)
  readonly suppressionSalt: string;          // >=32 chars
  readonly verifierApiKey: string | null;    // required in production
  readonly espApiKey: string | null;         // required in production

  // ── outbound endpoints ──
  readonly verifierApiBaseUrl: string;
  readonly espApiBaseUrl: string;
  readonly espFromEmail: string;
  readonly espMessageStream: string;
  readonly dohPrimaryUrl: string;
  readonly dohFallbackUrl: string;
  readonly publicBaseUrl: string;
  /** Ops-only extra allowlist hosts, parsed from EGRESS_EXTRA_HOSTS. */
  readonly egressExtraHosts: readonly string[];

  // ── vendored data anchor (seed/blocklist-sync) ──
  readonly vendorDir: string;

  // ── static api tunables (feed AppConfig.api) ──
  readonly bodyLimitBytes: number;            // default 1_500_000
  readonly bulkMaxRows: number;               // default 1000
  readonly jobPendingRetryAfterSeconds: number; // default 2
  readonly trustProxy: boolean;               // default true (Render proxy)
  readonly openApiVersion: string;            // default '1.0.0'

  // ── kill switches / spend caps (D12; SINGLE unit = integer cents) ──
  readonly killSwitchVerifier: boolean;
  readonly killSwitchSignup: boolean;
  /** USD env vars are parsed → cents AT LOAD (ARCHITECTURE §6, one spend unit). */
  readonly globalDailyVerifierSpendCapCents: number;
  readonly defaultTenantDailyVerifierSpendCapCents: number;
}

/** Aggregates ALL validation failures so a bad deploy reports every problem at once. */
export class EnvError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid environment (${problems.length} problem(s)):\n  - ${problems.join('\n  - ')}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

export interface LoadEnvOptions {
  /** Defaults to process.env. Injected in tests. */
  readonly source?: Record<string, string | undefined>;
}

// ── tiny typed reader: collects problems instead of throwing per-field ──────────
class Reader {
  readonly problems: string[] = [];
  private readonly src: Record<string, string | undefined>;
  constructor(src: Record<string, string | undefined>) {
    this.src = src;
  }

  private raw(key: string): string | undefined {
    const v = this.src[key];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  }
  str(key: string, def?: string): string {
    const v = this.raw(key) ?? def;
    if (v === undefined) { this.problems.push(`${key} is required`); return ''; }
    return v;
  }
  optStr(key: string): string | null {
    return this.raw(key) ?? null;
  }
  secret(key: string, minLen: number, opts: { required: boolean }): string | null {
    const v = this.raw(key);
    if (v === undefined) {
      if (opts.required) this.problems.push(`${key} is required`);
      return null;
    }
    if (v.length < minLen) this.problems.push(`${key} must be >=${minLen} chars (high-entropy secret)`);
    return v;
  }
  int(key: string, def: number): number {
    const v = this.raw(key);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) { this.problems.push(`${key} must be an integer`); return def; }
    return n;
  }
  intMin(key: string, def: number, min: number): number {
    const n = this.int(key, def);
    if (n < min) { this.problems.push(`${key} must be >=${min}`); return def; }
    return n;
  }
  num(key: string, def: number): number {
    const v = this.raw(key);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { this.problems.push(`${key} must be a non-negative number`); return def; }
    return n;
  }
  /** Read a USD amount and convert to integer cents AT LOAD (single spend unit). */
  usdCents(key: string, defUsd: number): number {
    const usd = this.num(key, defUsd);
    return Math.round(usd * 100);
  }
  bool(key: string, def: boolean): boolean {
    const v = this.raw(key)?.toLowerCase();
    if (v === undefined) return def;
    if (['on', 'true', '1', 'yes'].includes(v)) return true;
    if (['off', 'false', '0', 'no'].includes(v)) return false;
    this.problems.push(`${key} must be on/off (got ${JSON.stringify(v)})`);
    return def;
  }
  enum<T extends string>(key: string, allowed: readonly T[], def: T): T {
    const v = (this.raw(key) ?? def) as T;
    if (!allowed.includes(v)) { this.problems.push(`${key} must be one of ${allowed.join('|')}`); return def; }
    return v;
  }
  httpsUrl(key: string, def?: string): string {
    const v = this.str(key, def);
    if (v && !/^https:\/\//i.test(v)) this.problems.push(`${key} must be an https:// URL`);
    return v;
  }
}

/**
 * Parse + validate the environment. Throws EnvError on any failure.
 * Returns a deep-frozen Env. Never logs secret values.
 */
export function loadEnv(opts: LoadEnvOptions = {}): Env {
  const r = new Reader(opts.source ?? (process.env as Record<string, string | undefined>));

  const nodeEnv = r.enum<NodeEnv>('NODE_ENV', ['development', 'production', 'test'], 'development');
  const serviceRole = r.enum<ServiceRole>('SERVICE_ROLE', ['web', 'worker', 'cron'], 'web');
  const isProd = nodeEnv === 'production';

  const databaseUrl = r.str('DATABASE_URL');
  const databaseUrlUnpooled = r.str('DATABASE_URL_UNPOOLED');

  const env: Env = {
    nodeEnv,
    serviceRole,
    port: serviceRole === 'web' ? r.int('PORT', 8080) : 0,
    logLevel: r.enum<LogLevel>('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace'], 'info'),

    databaseUrl,
    databaseUrlUnpooled,
    databaseUrlForRole: serviceRole === 'web' ? databaseUrl : databaseUrlUnpooled,
    databaseUrlTest: r.optStr('DATABASE_URL_TEST'),
    poolMaxWeb: r.intMin('POOL_MAX_WEB', 8, 1),
    poolMaxWorker: r.intMin('POOL_MAX_WORKER', 4, 1),
    statementTimeoutMs: r.intMin('STATEMENT_TIMEOUT_MS', 8000, 1),
    connTimeoutMs: r.intMin('CONN_TIMEOUT_MS', 5000, 1),

    appPepper: r.secret('APP_PEPPER', 32, { required: true }) ?? '',
    appPepperPrevious: r.secret('APP_PEPPER_PREVIOUS', 32, { required: false }),
    suppressionSalt: r.secret('SUPPRESSION_SALT', 32, { required: true }) ?? '',
    verifierApiKey: r.secret('VERIFIER_API_KEY', 8, { required: isProd }),
    espApiKey: r.secret('ESP_API_KEY', 8, { required: isProd }),

    verifierApiBaseUrl: r.httpsUrl('VERIFIER_API_BASE_URL', 'https://api.millionverifier.com'),
    espApiBaseUrl: r.httpsUrl('ESP_API_BASE_URL', 'https://api.postmarkapp.com'),
    espFromEmail: r.str('ESP_FROM_EMAIL', 'no-reply@mail.mailmetero.com'),
    espMessageStream: r.str('ESP_MESSAGE_STREAM', 'outbound'),
    dohPrimaryUrl: r.httpsUrl('DOH_PRIMARY_URL', 'https://dns.google/resolve'),
    dohFallbackUrl: r.httpsUrl('DOH_FALLBACK_URL', 'https://cloudflare-dns.com/dns-query'),
    publicBaseUrl: r.httpsUrl('PUBLIC_BASE_URL', 'https://api.mailmetero.com'),
    egressExtraHosts: (r.optStr('EGRESS_EXTRA_HOSTS') ?? '')
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),

    vendorDir: r.optStr('VENDOR_DIR') ?? DEFAULT_VENDOR_DIR,

    bodyLimitBytes: r.intMin('BODY_LIMIT_BYTES', 1_500_000, 1),
    bulkMaxRows: r.intMin('BULK_MAX_ROWS', 1000, 1),
    jobPendingRetryAfterSeconds: r.intMin('JOB_PENDING_RETRY_AFTER_SECONDS', 2, 1),
    trustProxy: r.bool('TRUST_PROXY', true),
    openApiVersion: r.str('OPENAPI_VERSION', '1.0.0'),

    killSwitchVerifier: r.bool('KILL_SWITCH_VERIFIER', false),
    killSwitchSignup: r.bool('KILL_SWITCH_SIGNUP', false),
    globalDailyVerifierSpendCapCents: r.usdCents('GLOBAL_DAILY_VERIFIER_SPEND_CAP_USD', 50),
    defaultTenantDailyVerifierSpendCapCents: r.usdCents('DEFAULT_TENANT_DAILY_VERIFIER_SPEND_CAP_USD', 5),
  };

  if (r.problems.length > 0) throw new EnvError(r.problems);
  return Object.freeze(env);
}

/** True when the process should perform paid verification (kill switch off + key present). */
export function verifierEnabled(env: Env): boolean {
  return !env.killSwitchVerifier && env.verifierApiKey !== null;
}
