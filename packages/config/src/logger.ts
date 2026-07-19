// @mailmetero/config — structured JSON logging with secret redaction.
// One logger factory shared by api (Fastify reuses it), worker and cron so log shape
// is uniform. Redaction is defense-in-depth for the D17 accepted-but-deprecated
// `api_key=` query param, Bearer tokens, sk_live_/sk_test_ key bodies, DSN passwords,
// and every configured secret. pino is already in the tree (Fastify's default logger).

import { pino, type Logger } from 'pino';
import type { Env } from './env.ts';

export type { Logger };

/** Object-key paths pino nulls out. Covers Authorization/api-key headers + known secret fields. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers.cookie',
  'headers.authorization',
  '*.appPepper',
  '*.appPepperPrevious',
  '*.suppressionSalt',
  '*.verifierApiKey',
  '*.espApiKey',
  '*.key_hash',
  '*.keyHash',
  '*.api_key',
  '*.apiKey',
  '*.password',
];

// sk_* secret bodies (incl. sk_live_/sk_test_), Bearer tokens, api_key= query values, DSN userinfo.
// The optional (live_|test_) group is preserved so a scrubbed line stays correlatable by env.
const SK_RE = /\bsk_(live_|test_)?[A-Za-z0-9]{6,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const APIKEY_QUERY_RE = /([?&]api_key=)[^&\s"']+/gi;
const DSN_USERINFO_RE = /(postgres(?:ql)?:\/\/[^:@/\s]+:)[^@/\s]+@/gi;

/**
 * Scrub secrets from an arbitrary string (URLs, free-text log messages, error strings).
 * Keeps a short prefix of key material so a log is still correlatable without leaking it.
 */
export function redactString(s: string): string {
  return s
    .replace(SK_RE, (_m, prefix: string | undefined) => `sk_${prefix ?? ''}***`)
    .replace(BEARER_RE, 'Bearer ***')
    .replace(APIKEY_QUERY_RE, '$1***')
    .replace(DSN_USERINFO_RE, '$1***@');
}

/**
 * Build the process logger. `serviceRole` + a fixed `service` tag are bound so every
 * line is attributable to web/worker/cron. Uses pino's `redact` for structured fields
 * and a message hook running `redactString` for anything that slipped into free text.
 */
export function createLogger(env: Env): Logger {
  return pino({
    level: env.logLevel,
    base: { service: 'mailmetero', role: env.serviceRole },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    formatters: {
      // scrub the human message too (defense in depth against interpolated secrets)
      log: (obj) => obj,
    },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
        return method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
  });
}
