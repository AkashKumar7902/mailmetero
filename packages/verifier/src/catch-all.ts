// @mailmetero/verifier — catch-all probe (VERIFIABLE_WITH_CATCHALL_GUARD, PRD §6 / CONTRACTS_CORE).
//
// Before trusting a 550 5.1.1 "invalid" from an honest provider (e.g. Google Workspace), we first
// probe a RANDOM, almost-certainly-nonexistent local part at the domain. If the server accepts that
// address (verdict valid/accept_all), the domain accepts everything → catch-all, and per-address
// verification is meaningless. The rng is injectable so tests are deterministic.

import type {
  Domain,
  EmailAddress,
  LocalPart,
  VerifierBackend,
  VerifyContext,
} from '@mailmetero/contracts';

export interface CatchAllVerdict {
  readonly isCatchAll: boolean;
  readonly rawSmtpCode: string | null;
  readonly probedLocalPart: LocalPart;
}

export interface CatchAllProbe {
  probe(domain: Domain, ctx: VerifyContext): Promise<CatchAllVerdict>;
}

// Lowercase alnum only; the leading letter keeps it a syntactically valid local part.
const PROBE_HEAD = 'abcdefghijklmnopqrstuvwxyz';
const PROBE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const PROBE_MIN_LEN = 18;
const PROBE_MAX_LEN = 26;

function pick(alphabet: string, r: number): string {
  const i = Math.min(alphabet.length - 1, Math.max(0, Math.floor(r * alphabet.length)));
  return alphabet[i] ?? alphabet[0]!;
}

/**
 * A random local part that is extremely unlikely to be a real mailbox. Deterministic under an
 * injected rng. Minting the LocalPart brand here (rather than via core.canonicalize) is intentional:
 * the verifier package may not import core per the §6 DAG, and the generated value is alnum-only.
 */
export function randomProbeLocalPart(rng: () => number = Math.random): LocalPart {
  const span = PROBE_MAX_LEN - PROBE_MIN_LEN;
  const len = PROBE_MIN_LEN + Math.floor(rng() * (span + 1));
  let s = pick(PROBE_HEAD, rng());
  for (let i = 1; i < len; i++) {
    s += pick(PROBE_ALPHABET, rng());
  }
  return s as LocalPart;
}

export function createCatchAllProbe(
  backend: VerifierBackend,
  rng: () => number = Math.random,
): CatchAllProbe {
  return {
    async probe(domain: Domain, ctx: VerifyContext): Promise<CatchAllVerdict> {
      const local = randomProbeLocalPart(rng);
      const probeEmail = `${local}@${domain}` as EmailAddress;
      const outcome = await backend.verify(probeEmail, ctx);

      // A random, non-existent local part that the server nonetheless "accepts" (valid) or that
      // resolves to accept_all means the domain accepts any address → catch-all. An honest reject
      // (invalid) or an inconclusive answer (unknown) is NOT catch-all.
      const isCatchAll = outcome.verdict === 'valid' || outcome.verdict === 'accept_all';

      return {
        isCatchAll,
        rawSmtpCode: outcome.rawSmtpCode ?? null,
        probedLocalPart: local,
      };
    },
  };
}
