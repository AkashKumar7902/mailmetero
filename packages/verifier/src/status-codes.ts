// @mailmetero/verifier — SMTP enhanced-status-code classifier (PRD §4.1, §6 stage 6, D10).
//
// Translates an SMTP reply (raw 3-digit code + optional RFC 3463 enhanced code) into a
// VerifyVerdict + SubStatus, provider-aware. The three load-bearing rules (task spec / PRD §4.2):
//   • 5.1.1                      → invalid / invalid_mailbox  (bad destination mailbox)
//   • x.7.x (e.g. 5.7.1)         → unknown / gateway_blocked  (policy / administrative prohibition)
//   • lone 550 5.4.1 on an UNVERIFIABLE provider (M365) → accept_all / provider_unverifiable, NEVER
//     invalid. Rationale: M365 anti-enumeration responds 550 5.4.1 to unfamiliar IPs / hybrid relays,
//     so the code carries no per-address signal — treating it as invalid would be a false negative.

import type {
  Provider,
  SubStatus,
  VerifiabilityClass,
  VerifyVerdict,
} from '@mailmetero/contracts';

export interface SmtpCodeClassification {
  readonly verdict: VerifyVerdict;
  readonly subStatus: SubStatus;
  readonly rawSmtpCode: string | null;
  readonly enhancedCode: string | null;
}

/** Extract a bare 3-digit SMTP reply code (2xx–5xx). Returns null when absent/unparseable. */
function normalizeRawCode(raw?: string): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/([2-5]\d\d)/);
  return m ? (m[1] ?? null) : null;
}

/** Extract a canonical RFC 3463 enhanced code `class.subject.detail`. Returns null when absent. */
function normalizeEnhancedCode(code?: string): string | null {
  if (!code) return null;
  const m = code.trim().match(/([2-5])\.(\d{1,3})\.(\d{1,3})/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

/**
 * Provider-aware SMTP → verdict classification. Pure; no I/O. The UNVERIFIABLE handling here is a
 * *semantic* interpretation (what a code means on M365), distinct from — and reinforced by — the
 * defense-in-depth clamp applied in `createHttpsApiBackend`.
 */
export function classifySmtpCode(input: {
  rawCode?: string;
  enhancedCode?: string;
  provider: Provider | null;
  verifiabilityClass: VerifiabilityClass;
}): SmtpCodeClassification {
  const rawSmtpCode = normalizeRawCode(input.rawCode);
  const enhancedCode = normalizeEnhancedCode(input.enhancedCode);
  const vc = input.verifiabilityClass;

  const out = (verdict: VerifyVerdict, subStatus: SubStatus): SmtpCodeClassification => ({
    verdict,
    subStatus,
    rawSmtpCode,
    enhancedCode,
  });

  const parts = enhancedCode ? enhancedCode.split('.') : null;
  const statusClass = parts ? parts[0] : rawSmtpCode ? rawSmtpCode[0] : null;
  const subject = parts ? parts[1] ?? null : null;

  // ── Anti-enumeration: lone 550 5.4.1 on an UNVERIFIABLE provider (M365) ──────────────
  // Never invalid; the address is unknowable behind the provider's enumeration defenses.
  if (enhancedCode === '5.4.1' && vc === 'UNVERIFIABLE') {
    return out('accept_all', 'provider_unverifiable');
  }

  // ── Policy / gateway block: x.7.x (5.7.1 administrative prohibition, DKIM/DMARC refusals) ──
  if (subject === '7') {
    return out('unknown', 'gateway_blocked');
  }

  // ── Permanent failures (5.x.x) ──────────────────────────────────────────────────────
  if (statusClass === '5') {
    // Addressing (subject 1): bad / nonexistent mailbox → invalid.
    if (subject === '1') {
      return out('invalid', 'invalid_mailbox');
    }
    // Mailbox status (subject 2): 5.2.1 disabled/deactivated → invalid; others (e.g. 5.2.2 full,
    // meaning the mailbox EXISTS) are not a negative signal → unknown.
    if (subject === '2') {
      if (enhancedCode === '5.2.1') return out('invalid', 'disabled');
      return out('unknown', 'gateway_blocked');
    }
    // Routing / network (subject 4): cannot determine deliverability → unknown, never invalid.
    if (subject === '4') {
      return out('unknown', 'gateway_blocked');
    }
    // Bare permanent reject (550/551/553) with no enhanced code: on an UNVERIFIABLE provider it is
    // still anti-enumeration noise (accept_all), otherwise a definitive recipient reject (invalid).
    if (!enhancedCode && (rawSmtpCode === '550' || rawSmtpCode === '551' || rawSmtpCode === '553')) {
      if (vc === 'UNVERIFIABLE') return out('accept_all', 'provider_unverifiable');
      return out('invalid', 'invalid_mailbox');
    }
    // Any other permanent 5.x.x: don't assert invalid on ambiguity.
    return out('unknown', 'gateway_blocked');
  }

  // ── Transient (4.x.x): vendor absorbs greylisting; anything still 4xx here is inconclusive. ──
  if (statusClass === '4') {
    return out('unknown', 'timeout');
  }

  // ── Success (2.x.x): a 250 accept. Provider-clamped so UNVERIFIABLE/UNKNOWN never assert valid. ──
  if (statusClass === '2') {
    if (vc === 'UNVERIFIABLE') return out('accept_all', 'provider_unverifiable');
    if (vc === 'UNKNOWN') return out('unknown', 'backend_unavailable');
    return out('valid', 'ok');
  }

  // ── No usable code ──────────────────────────────────────────────────────────────────
  return out('unknown', 'backend_unavailable');
}
