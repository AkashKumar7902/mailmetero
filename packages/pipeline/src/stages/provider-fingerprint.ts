// Stage 6 — provider fingerprint (MX suffix) + verifiability matrix.
//
// Longest-suffix-wins fingerprint of the MX hosts → Provider + VerifiabilityClass. This is where
// the M365 / catch-all short-circuit is DECIDED: UNVERIFIABLE (microsoft365) and UNKNOWN
// (gmail/yahoo consumer) classes, plus a known catch-all domain, mean stage 7 must NOT spend a
// paid verify (D10). The skip itself is applied in stage 7 by reading the class we set here.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
} from '../stage.ts';
import { fingerprintProvider } from '@mailmetero/dns';

export function makeProviderFingerprintStage(): Stage {
  return {
    id: 'provider_fingerprint',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const hosts = ctx.state.mx?.hosts ?? [];
      const fingerprint = fingerprintProvider(
        ctx.domainInput.domain,
        hosts,
        ctx.deps.fingerprintRules,
        ctx.deps.verifiabilityOverrides,
      );
      ctx.state.fingerprint = fingerprint;
      // DNS-derived fingerprint is authoritative over any stale KB provider guess.
      ctx.state.evidence.provider = fingerprint.provider;
      ctx.state.evidence.verifiabilityClass = fingerprint.verifiabilityClass;
      return CONTINUE;
    },
  };
}
