// @mailmetero/db — DsarRepo (data-subject export/delete; tenant scope only, D6).
//
// DSAR operations touch ONLY the requesting tenant's `results` rows. They NEVER write global
// suppression (that path is objection-confirmation only) and never read another tenant's data.

import type {
  TenantId, EmailAddress, Status, SubStatus, Backend, EvidenceTier,
} from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { rows, rowCount } from '../client.ts';

export interface DsarExportRow {
  email: string;
  domain: string;
  status: Status;
  subStatus: SubStatus | null;
  score: number;
  backend: Backend;
  evidence: EvidenceTier;
  source: 'derivation';
  requestId: string;
  verifiedAt: string | null;
  createdAt: string;
}

export interface DsarRepo {
  exportForSubject(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<DsarExportRow[]>;
  deleteForSubject(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<{ removed: number }>;
}

export function createDsarRepo(): DsarRepo {
  return {
    async exportForSubject(q, tenantId, email) {
      const rs = await rows<{
        email: string | null;
        input_email: string | null;
        input_domain: string | null;
        status: string;
        sub_status: string | null;
        score: number;
        backend: string;
        evidence: string;
        request_id: string;
        verified_at: string | null;
        created_at: string;
      }>(
        q,
        `SELECT email, input_email, input_domain, status, sub_status, score, backend, evidence,
                request_id, verified_at, created_at
           FROM results
          WHERE tenant_id = $1 AND (email = $2 OR input_email = $2)
          ORDER BY created_at DESC`,
        [tenantId, email],
      );
      return rs.map((r) => {
        const addr = r.email ?? r.input_email ?? String(email);
        const domain = r.input_domain ?? (addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1) : '');
        return {
          email: addr,
          domain,
          status: r.status as Status,
          subStatus: r.sub_status as SubStatus | null,
          score: r.score,
          backend: r.backend as Backend,
          evidence: r.evidence as EvidenceTier,
          source: 'derivation' as const,
          requestId: r.request_id,
          verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
          createdAt: new Date(r.created_at).toISOString(),
        };
      });
    },

    async deleteForSubject(q, tenantId, email) {
      const removed = await rowCount(
        q,
        `DELETE FROM results WHERE tenant_id = $1 AND (email = $2 OR input_email = $2)`,
        [tenantId, email],
      );
      return { removed };
    },
  };
}
