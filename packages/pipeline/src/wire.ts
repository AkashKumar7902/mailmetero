// @mailmetero/pipeline — the ONE internal→wire boundary.
//
// No package other than this file constructs a wire result type (MODULE_CONTRACTS casing rule).
// api and worker import these mappers; they never hand-build snake_case shapes. Every field is a
// mechanical projection of the camelCase InternalFinderResult / InternalVerifierResult.

import type {
  Candidate,
  Status,
  VerificationEvidence,
  WireCandidate,
  VerificationSummary,
  FinderResult,
  VerifierResult,
  BulkFinderRow,
  BulkVerifierRow,
  ApiError,
  ErrorEnvelope,
} from '@mailmetero/contracts';
import type { InternalFinderResult, InternalVerifierResult } from './types.ts';

/** Project one internal Candidate into the ranked-list wire shape. */
export function toWireCandidate(c: Candidate): WireCandidate {
  return {
    email: c.email,
    score: c.score,
    reason_codes: c.reasonCodes,
  };
}

/** The nested Hunter-parity `verification` object. */
export function toVerificationSummary(status: Status, ev: VerificationEvidence): VerificationSummary {
  return {
    status,
    date: ev.verifiedAt,
  };
}

/** InternalFinderResult → wire FinderResult (GET /v2/email-finder data payload). */
export function toFinderResult(r: InternalFinderResult): FinderResult {
  return {
    email: r.email,
    score: r.score,
    status: r.status,
    domain: r.domain,
    first_name: r.firstName,
    last_name: r.lastName,
    sources: ['derivation'],
    verification: toVerificationSummary(r.status, r.verification),
    sub_status: r.subStatus,
    reason_codes: r.reasonCodes,
    provider: r.provider,
    backend: r.backend,
    evidence: r.evidence,
    collision_risk: r.collisionRisk,
    candidates: r.candidates.map(toWireCandidate),
    verified_at: r.verification.verifiedAt,
    stale: r.verification.stale,
  };
}

/** InternalVerifierResult → wire VerifierResult. */
export function toVerifierResult(r: InternalVerifierResult): VerifierResult {
  return {
    email: r.email,
    status: r.status,
    score: r.score,
    accept_all: r.acceptAll,
    disposable: r.disposable,
    webmail: r.webmail,
    mx_records: r.mxRecords,
    smtp_check: r.smtpCheck,
    sub_status: r.subStatus,
    reason_codes: r.reasonCodes,
    provider: r.provider,
    backend: r.backend,
    evidence: r.evidence,
    raw_smtp_code: r.rawSmtpCode,
    verified_at: r.verification.verifiedAt,
  };
}

function isApiError(r: unknown): r is ApiError {
  return typeof r === 'object' && r !== null && 'code' in r && 'details' in r;
}

function toErrorEnvelope(e: ApiError): ErrorEnvelope {
  return { errors: [e] };
}

/** Bulk finder row (job_items store the wire shape). Errors become an ErrorEnvelope. */
export function toBulkFinderRow(
  input: { first_name: string; last_name: string; domain: string },
  r: InternalFinderResult | ApiError,
): BulkFinderRow {
  return {
    input,
    result: isApiError(r) ? toErrorEnvelope(r) : toFinderResult(r),
  };
}

/** Bulk verifier row. Errors become an ErrorEnvelope. */
export function toBulkVerifierRow(
  input: { email: string },
  r: InternalVerifierResult | ApiError,
): BulkVerifierRow {
  return {
    input,
    result: isApiError(r) ? toErrorEnvelope(r) : toVerifierResult(r),
  };
}
