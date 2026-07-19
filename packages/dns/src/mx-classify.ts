// @mailmetero/dns — pure MX classification (MODULE_CONTRACTS §3; PRD §5 / §6 stage 5).
//
// Turns raw DoH MX answers (+ whether the domain has any A/AAAA address) into the typed
// `MxEnum` and a preference-sorted host list. Pure and network-free so it is exhaustively
// unit-testable. The four outcomes (CONTRACTS_CORE §1):
//   • NULL_MX               — RFC 7505 "0 ." single null exchange → definitive reject.
//   • EXPLICIT_MX           — one or more real MX records → sorted by preference asc.
//   • IMPLICIT_MX_FALLBACK  — no MX but an A/AAAA address (RFC 5321) → confidence cap 60.
//   • NO_MAIL_HOST          — no MX and no address → cannot receive mail.

import type { MxEnum } from '@mailmetero/contracts';
import { DNS_RR_TYPE } from './types.ts';
import type { DohAnswer, MxHost } from './types.ts';

interface ParsedMx {
  readonly exchange: string;
  readonly preference: number;
}

/** Parse `"10 aspmx.l.google.com."` → { preference: 10, exchange: "aspmx.l.google.com" }. */
function parseMxData(data: string): ParsedMx | null {
  const trimmed = data.trim();
  if (trimmed === '') return null;
  const sep = trimmed.search(/\s/);
  if (sep < 0) return null;
  const preference = Number(trimmed.slice(0, sep).trim());
  if (!Number.isFinite(preference)) return null;
  // Canonicalize the exchange: strip trailing dot(s) (root marker), lowercase.
  const exchange = trimmed.slice(sep + 1).trim().replace(/\.+$/, '').toLowerCase();
  return { exchange, preference };
}

/**
 * Classify a domain's mail-exchange posture from its MX answers.
 *
 * Null-MX detection follows RFC 7505: a single MX RR whose exchange is the root (".",
 * i.e. an empty exchange after canonicalization). If a null exchange co-exists with real
 * MX hosts (malformed), the real hosts win and the record is treated as EXPLICIT_MX.
 */
export function classifyMx(input: { mxAnswers: readonly DohAnswer[]; hasAddress: boolean }): {
  mx: MxEnum;
  hosts: MxHost[];
} {
  const hosts: MxHost[] = [];
  let sawNullExchange = false;

  for (const ans of input.mxAnswers) {
    if (ans.type !== DNS_RR_TYPE.MX) continue; // ignore RRSIG/CNAME/etc. mixed into Answer
    const parsed = parseMxData(ans.data);
    if (parsed === null) continue;
    if (parsed.exchange === '') {
      sawNullExchange = true;
      continue;
    }
    hosts.push({ exchange: parsed.exchange, preference: parsed.preference });
  }

  if (hosts.length > 0) {
    // Stable sort ascending by preference (lower preference = more preferred, RFC 5321 §5.1).
    hosts.sort((a, b) => a.preference - b.preference);
    return { mx: 'EXPLICIT_MX', hosts };
  }

  if (sawNullExchange) {
    return { mx: 'NULL_MX', hosts: [] };
  }

  if (input.hasAddress) {
    return { mx: 'IMPLICIT_MX_FALLBACK', hosts: [] };
  }

  return { mx: 'NO_MAIL_HOST', hosts: [] };
}
