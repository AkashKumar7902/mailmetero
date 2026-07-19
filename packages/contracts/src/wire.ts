// @mailmetero/contracts — §4.1/§4.2 wire response types (snake_case).
//
// Wire types mirror Hunter exactly (D2). These are the `data` payloads and envelopes
// crossing the HTTP boundary. `@mailmetero/pipeline` (src/wire.ts) is the ONLY place that
// constructs them from internal camelCase results.

import type { Status, SubStatus, Provider, Backend, EvidenceTier, SourceTag } from './enums.js';
import type { ReasonCode } from './reason-codes.js';
import type { ErrorCode } from './error-codes.js';
import type { RequestId, JobId } from './primitives.js';

// nested "verification" object on the finder response (Hunter parity)
export interface VerificationSummary {
  status: Status;
  date: string | null;              // ISO date; null until verified
}

// projection of internal Candidate exposed in the ranked list (~25)
export interface WireCandidate {
  email: string;
  score: number;
  reason_codes: ReasonCode[];
}

// data payload of GET /v2/email-finder
export interface FinderResult {
  // Hunter-parity fields
  email: string | null;
  score: number;                    // 0–100
  status: Status;
  domain: string;
  first_name: string | null;
  last_name: string | null;
  sources: SourceTag[];             // always ["derivation"] in v1
  verification: VerificationSummary;
  // mailmetero-native (additive-only, D2)
  sub_status: SubStatus | null;
  reason_codes: ReasonCode[];       // ≥1
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  collision_risk: boolean;
  candidates: WireCandidate[];      // full ranked list (~25)
  verified_at: string | null;
  stale: boolean;
}

// data payload of GET /v2/email-verifier and GET /v2/verifications/{id}
export interface VerifierResult {
  // Hunter-parity fields
  email: string;
  status: Status;
  score: number;
  accept_all: boolean;
  disposable: boolean;
  webmail: boolean;
  mx_records: boolean;
  smtp_check: boolean;
  // mailmetero-native (additive-only)
  sub_status: SubStatus | null;
  reason_codes: ReasonCode[];
  provider: Provider | null;
  backend: Backend;
  evidence: EvidenceTier;
  raw_smtp_code: string | null;
  verified_at: string | null;
}

// ── §4.2 Envelope, errors, headers, and remaining §3 shapes ─────────────────
export interface Meta {
  request_id: RequestId;
  // bulk-results pagination (GET /v2/bulk/{job_id}/results)
  total?: number;
  next_offset?: number | null;
}
export interface SuccessEnvelope<T> { data: T; meta: Meta; }

export interface ApiError { id: string; code: ErrorCode; details: string; }
export interface ErrorEnvelope { errors: ApiError[]; }

/** Headers on EVERY response (PRD §3). Values are strings on the wire. */
export const RESPONSE_HEADERS = [
  'X-Request-Id',
  'X-Billed',              // '0' | '1'
  'X-Credits-Remaining',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
] as const;
export type ResponseHeader = typeof RESPONSE_HEADERS[number];
// Conditional headers: 'Location' (202 async), 'Retry-After' (job_pending/rate_limited),
// 'Deprecation' (legacy api_key= query param, D17).

// ── async / bulk (PRD §3) ──
export const JOB_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed'] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export interface BulkAccepted   { job_id: JobId; status: JobStatus; count: number; }
export interface BulkJobStatus  {
  status: JobStatus; total: number; done: number; failed: number;
  created_at: string; finished_at: string | null;
}
export type BulkFinderRow   = { input: { first_name: string; last_name: string; domain: string }; result: FinderResult | ErrorEnvelope };
export type BulkVerifierRow = { input: { email: string }; result: VerifierResult | ErrorEnvelope };

// ── account / usage (PRD §3) ──
export interface AccountInfo {
  email: string;
  plan_name: string;
  requests: {
    searches:      { used: number; available: number };
    verifications: { used: number; available: number };
  };
  reset_date: string;
}
export interface UsageInfo {
  credits_used: number;
  credits_remaining: number;
  attempts: number;
  billable: number;
  credit_backs: number;
  by_day: Array<{ date: string; attempts: number; billable: number; credit_backs: number }>;
}
