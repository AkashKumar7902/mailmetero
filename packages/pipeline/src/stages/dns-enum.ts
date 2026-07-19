// Stage 5 — DNS enumeration over DoH (Google + Cloudflare fallback), cached in kb.domains.
//
// Produces the typed MxResolution. NULL_MX (RFC 7505) ⇒ definitive `invalid/null_mx`;
// NO_MAIL_HOST ⇒ `invalid/no_mail_host`; IMPLICIT_MX_FALLBACK flows on (score capped at 60 later).
// The resolver never throws (NXDOMAIN ⇒ NO_MAIL_HOST). PRD §6 stage 5.

import {
  type Stage,
  type StageContext,
  type StageDecision,
  BOTH_MODES,
  CONTINUE,
  finderOk,
  verifierOk,
  finderTerminal,
  verifierTerminal,
} from '../stage.ts';

export function makeDnsEnumStage(): Stage {
  return {
    id: 'dns_enum',
    appliesTo: BOTH_MODES,
    async run(ctx: StageContext): Promise<StageDecision> {
      const resolution = await ctx.deps.resolver.resolve(ctx.domainInput.domain);
      ctx.state.mx = resolution;
      ctx.state.evidence.mx = resolution.mx;

      if (resolution.mx === 'NULL_MX') {
        return ctx.mode === 'finder'
          ? finderOk(
              finderTerminal(ctx, 'dns_enum', {
                email: ctx.state.candidates[0]?.email ?? null,
                status: 'invalid',
                subStatus: 'null_mx',
                score: 0,
                reasonCodes: ['dns_null_mx'],
                evidence: 'dns',
              }),
            )
          : verifierOk(
              verifierTerminal(ctx, 'dns_enum', {
                status: 'invalid',
                subStatus: 'null_mx',
                score: 0,
                reasonCodes: ['dns_null_mx'],
                evidence: 'dns',
                mxRecords: false,
              }),
            );
      }

      if (resolution.mx === 'NO_MAIL_HOST') {
        return ctx.mode === 'finder'
          ? finderOk(
              finderTerminal(ctx, 'dns_enum', {
                email: ctx.state.candidates[0]?.email ?? null,
                status: 'invalid',
                subStatus: 'no_mail_host',
                score: 0,
                reasonCodes: ['dns_no_mail_host'],
                evidence: 'dns',
              }),
            )
          : verifierOk(
              verifierTerminal(ctx, 'dns_enum', {
                status: 'invalid',
                subStatus: 'no_mail_host',
                score: 0,
                reasonCodes: ['dns_no_mail_host'],
                evidence: 'dns',
                mxRecords: false,
              }),
            );
      }

      return CONTINUE;
    },
  };
}
