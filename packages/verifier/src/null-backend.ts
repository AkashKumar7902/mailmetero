// @mailmetero/verifier — NullBackend: graceful degradation (Backend='none').
//
// Emitted when verification is unavailable: kill switch on, per-tenant spend cap hit, hard vendor
// outage, or budget exhausted. It performs no I/O and always returns an 'unknown' verdict. The
// pipeline attaches evidence='degraded' and billing treats degraded results as always free (PRD §4.2).

import type { Backend, EmailAddress, SubStatus, VerifierBackend, VerifyContext, VerifyOutcome } from '@mailmetero/contracts';

export function createNullBackend(
  subStatus: Extract<SubStatus, 'backend_unavailable' | 'timeout' | 'gateway_blocked'> = 'backend_unavailable',
): VerifierBackend {
  const kind: Backend = 'none';
  return {
    kind,
    async verify(_email: EmailAddress, _ctx: VerifyContext): Promise<VerifyOutcome> {
      return { verdict: 'unknown', subStatus };
    },
  };
}
