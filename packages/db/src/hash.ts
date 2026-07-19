// @mailmetero/db — hashing helpers.
//
// TWO distinct one-way transforms with DIFFERENT secrets, deliberately kept apart:
//   • computeSuppressionHash — salted SHA-256 keyed by SUPPRESSION_SALT. Produces the
//     ONLY representation of a suppressed subject/domain that ever touches storage.
//     The salt is NOT the API-key HMAC pepper (compromise isolation).
//   • sha256Hex — plain SHA-256 for opaque, non-secret fingerprints (objection tokens,
//     request-IP fingerprints) where no per-tenant secret is required.

import { createHash } from 'node:crypto';
import type { SuppressionHash } from '@mailmetero/contracts';

/**
 * Salted SHA-256 of a canonical value (a canonicalized email or domain). The salt is
 * mixed with a domain-separating delimiter so an address hash can never collide with a
 * domain hash of the same bytes. Returns lowercase hex, branded `SuppressionHash`.
 */
export function computeSuppressionHash(canonicalValue: string, salt: string): SuppressionHash {
  const digest = createHash('sha256')
    .update(salt, 'utf8')
    .update('\x1f', 'utf8') // unit-separator: salt/value domain separation
    .update(canonicalValue, 'utf8')
    .digest('hex');
  return digest as SuppressionHash;
}

/** Plain SHA-256 hex of an opaque token or fingerprint (no secret salt). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
