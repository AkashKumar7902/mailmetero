import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  Backend,
  Domain,
  EmailAddress,
  VerifierBackend,
  VerifyContext,
  VerifyOutcome,
  VerifyVerdict,
} from '@mailmetero/contracts';
import { createCatchAllProbe, randomProbeLocalPart } from '../src/catch-all.ts';

const CTX: VerifyContext = {
  domain: 'acme.com' as Domain,
  mx: 'EXPLICIT_MX',
  provider: 'google_workspace',
  verifiabilityClass: 'VERIFIABLE_WITH_CATCHALL_GUARD',
  isCatchAll: null,
};

/** Records the probed email and returns a fixed outcome. */
function recordingBackend(outcome: VerifyOutcome): {
  backend: VerifierBackend;
  seen: { email: EmailAddress | null };
} {
  const seen: { email: EmailAddress | null } = { email: null };
  const kind: Backend = 'api';
  const backend: VerifierBackend = {
    kind,
    async verify(email) {
      seen.email = email;
      return outcome;
    },
  };
  return { backend, seen };
}

// Deterministic rng: cycles through a fixed sequence.
function seededRng(seq: number[]): () => number {
  let i = 0;
  return () => {
    const v = seq[i % seq.length] ?? 0;
    i += 1;
    return v;
  };
}

test('randomProbeLocalPart is deterministic under an injected rng', () => {
  const a = randomProbeLocalPart(seededRng([0.1, 0.2, 0.3, 0.4]));
  const b = randomProbeLocalPart(seededRng([0.1, 0.2, 0.3, 0.4]));
  assert.equal(a, b);
});

test('randomProbeLocalPart yields an alnum local part starting with a letter', () => {
  const local = randomProbeLocalPart(seededRng([0.5, 0.9, 0.0, 0.3, 0.7]));
  assert.match(local, /^[a-z][a-z0-9]+$/);
  assert.ok(local.length >= 18 && local.length <= 26);
});

test('two rng streams produce different local parts', () => {
  const a = randomProbeLocalPart(seededRng([0.11]));
  const b = randomProbeLocalPart(seededRng([0.87]));
  assert.notEqual(a, b);
});

for (const verdict of ['valid', 'accept_all'] as VerifyVerdict[]) {
  test(`probe: random local accepted (${verdict}) → isCatchAll true`, async () => {
    const { backend, seen } = recordingBackend({ verdict, subStatus: verdict === 'valid' ? 'ok' : 'catch_all_confirmed', rawSmtpCode: '250' });
    const probe = createCatchAllProbe(backend, seededRng([0.2, 0.4, 0.6, 0.8]));
    const result = await probe.probe(CTX.domain, CTX);
    assert.equal(result.isCatchAll, true);
    assert.equal(result.rawSmtpCode, '250');
    assert.ok(seen.email?.endsWith('@acme.com'));
    assert.ok(seen.email?.startsWith(result.probedLocalPart));
  });
}

test('probe: random local rejected (invalid) → isCatchAll false', async () => {
  const { backend } = recordingBackend({ verdict: 'invalid', subStatus: 'invalid_mailbox', rawSmtpCode: '550' });
  const probe = createCatchAllProbe(backend, seededRng([0.3, 0.5, 0.7]));
  const result = await probe.probe(CTX.domain, CTX);
  assert.equal(result.isCatchAll, false);
  assert.equal(result.rawSmtpCode, '550');
});

test('probe: inconclusive (unknown) → isCatchAll false, rawSmtpCode null', async () => {
  const { backend } = recordingBackend({ verdict: 'unknown', subStatus: 'timeout' });
  const probe = createCatchAllProbe(backend, seededRng([0.1, 0.9]));
  const result = await probe.probe(CTX.domain, CTX);
  assert.equal(result.isCatchAll, false);
  assert.equal(result.rawSmtpCode, null);
});
