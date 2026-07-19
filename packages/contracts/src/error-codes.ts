// @mailmetero/contracts — §3 ErrorCode registry (FROZEN; PRD §3, D18).
//
// Error envelope is Hunter-style `{errors:[{id, code, details}]}` — NOT RFC 9457 (D18).
// The registry is closed and documented in the migration table. Codes marked [§3] are
// named verbatim in the PRD; the rest are the labeled completion. `verification_unavailable`
// covers the verifier kill switch (D12) and a hard verifier outage; the per-tenant daily
// spend cap normally DEGRADES to backend=none (unbilled) rather than erroring.

export const ERROR_CODES = [
  'invalid_api_key',          // [§3] 401
  'insufficient_credits',     // [§3] 402
  'rate_limited',             // [§3] 429 (attempt-level; D12)
  'invalid_domain',           // [§3] 400
  'domain_required',          // [§3] 400 — company-only find in v1 (D3)
  'verification_unavailable', // [§3] 503 — verifier down / kill switch on
  'job_pending',              // [§3] 202/consumers poll; carries Retry-After
  'idempotency_conflict',     // [§3] 409 (D13)
  'payload_too_large',        // [§3] 413 — bulk >1,000 rows

  // ── labeled completion (still frozen) ──
  'invalid_email',            // 400 — malformed email on verifier
  'validation_error',         // 400 — generic bad/missing param
  'not_found',                // 404 — unknown job id / route
  'signup_disposable_blocked',// 400 — disposable-domain signup blocked (D12)
  'service_unavailable',      // 503 — dependency/DB outage
  'internal_error',           // 500
] as const;
export type ErrorCode = typeof ERROR_CODES[number];
// NOTE: there is intentionally NO suppression/objection error code (D5). Suppressed
// inputs return the ordinary not-found/`unknown` result shape, never an error.
