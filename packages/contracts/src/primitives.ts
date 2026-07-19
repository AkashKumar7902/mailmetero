// @mailmetero/contracts — §4 Branded primitives.
//
// Branded primitives exist so a raw `string` can never be passed where a canonicalized
// `Domain`/`EmailAddress` is required. Construct them ONLY through the canonicalizers in
// `@mailmetero/core` (the sole place brands are minted).

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type EmailAddress    = Brand<string, 'EmailAddress'>;   // canonicalized: lowercased, +tag stripped
export type Domain          = Brand<string, 'Domain'>;         // registrable eTLD+1, PSL-normalized (tldts), punycode, lowercased
export type LocalPart       = Brand<string, 'LocalPart'>;      // canonicalized local part
export type PatternToken    = Brand<string, 'PatternToken'>;   // e.g. '{f}{last}', '{first}.{last}'
export type SuppressionHash = Brand<string, 'SuppressionHash'>;// salted SHA-256 hex (no plaintext, ever)
export type TenantId        = Brand<string, 'TenantId'>;
export type RequestId       = Brand<string, 'RequestId'>;      // echoed as X-Request-Id
export type JobId           = Brand<string, 'JobId'>;
export type IsoTimestamp    = Brand<string, 'IsoTimestamp'>;   // RFC 3339 UTC
