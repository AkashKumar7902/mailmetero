// @mailmetero/db — ResultsRepo.
//
// The per-tenant person-level result store: stage-3 verdict cache, DSAR export/delete
// (tenant scope ONLY — never global suppression, D6), and TTL purge. Insert is idempotent
// per (tenant_id, request_id) via the unique index (retries can't create duplicates).

import type {
  TenantId, RequestId, EmailAddress, Domain, IsoTimestamp,
  Status, SubStatus, ReasonCode, Provider, Backend, EvidenceTier, WireCandidate,
} from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { maybeOne, rows, rowCount } from '../client.ts';
import type { ResultRow, ResultEndpoint } from '../types.ts';

interface ResultRaw {
  id: string;
  tenant_id: string;
  request_id: string;
  endpoint: ResultEndpoint;
  request_hash: string;
  input_first_name: string | null;
  input_last_name: string | null;
  input_middle_name: string | null;
  input_full_name: string | null;
  input_domain: string | null;
  input_email: string | null;
  email: string | null;
  status: string;
  sub_status: string | null;
  score: number;
  reason_codes: string[];
  provider: string | null;
  backend: string;
  evidence: string;
  collision_risk: boolean;
  accept_all: boolean | null;
  disposable: boolean | null;
  webmail: boolean | null;
  mx_records: boolean | null;
  smtp_check: boolean | null;
  raw_smtp_code: string | null;
  enhanced_code: string | null;
  candidates: WireCandidate[];
  source: string;
  billed: boolean;
  verified_at: string | null;
  created_at: string;
  expires_at: string;
}

function mapResult(r: ResultRaw): ResultRow {
  return {
    id: r.id,
    tenantId: r.tenant_id as TenantId,
    requestId: r.request_id as RequestId,
    endpoint: r.endpoint,
    requestHash: r.request_hash,
    inputFirstName: r.input_first_name,
    inputLastName: r.input_last_name,
    inputMiddleName: r.input_middle_name,
    inputFullName: r.input_full_name,
    inputDomain: r.input_domain as Domain | null,
    inputEmail: r.input_email as EmailAddress | null,
    email: r.email as EmailAddress | null,
    status: r.status as Status,
    subStatus: r.sub_status as SubStatus | null,
    score: r.score,
    reasonCodes: r.reason_codes as ReasonCode[],
    provider: r.provider as Provider | null,
    backend: r.backend as Backend,
    evidence: r.evidence as EvidenceTier,
    collisionRisk: r.collision_risk,
    acceptAll: r.accept_all,
    disposable: r.disposable,
    webmail: r.webmail,
    mxRecords: r.mx_records,
    smtpCheck: r.smtp_check,
    rawSmtpCode: r.raw_smtp_code,
    enhancedCode: r.enhanced_code,
    candidates: r.candidates ?? [],
    source: 'derivation',
    billed: r.billed,
    verifiedAt: r.verified_at as IsoTimestamp | null,
    createdAt: r.created_at as IsoTimestamp,
    expiresAt: r.expires_at as IsoTimestamp,
  };
}

const SELECT = `
  SELECT id, tenant_id, request_id, endpoint, request_hash,
         input_first_name, input_last_name, input_middle_name, input_full_name,
         input_domain, input_email, email, status, sub_status, score, reason_codes,
         provider, backend, evidence, collision_risk, accept_all, disposable, webmail,
         mx_records, smtp_check, raw_smtp_code, enhanced_code, candidates, source, billed,
         verified_at, created_at, expires_at
    FROM results`;

export interface ResultsRepo {
  insert(q: Queryable, row: Omit<ResultRow, 'id' | 'createdAt'>): Promise<ResultRow>;
  findFreshByRequestHash(
    q: Queryable,
    tenantId: TenantId,
    requestHash: string,
    notBefore: IsoTimestamp,
  ): Promise<ResultRow | null>;
  byId(q: Queryable, id: string): Promise<ResultRow | null>;
  listForTenantByEmail(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<ResultRow[]>;
  deleteForTenantByEmail(q: Queryable, tenantId: TenantId, email: EmailAddress): Promise<number>;
  markDowngraded(q: Queryable, id: string): Promise<void>;
  purgeExpired(q: Queryable, now: IsoTimestamp, limit: number): Promise<number>;
  countOverdue(q: Queryable, cutoff: IsoTimestamp): Promise<number>;
}

export function createResultsRepo(): ResultsRepo {
  return {
    async insert(q, row) {
      const inserted = await maybeOne<ResultRaw>(
        q,
        `INSERT INTO results
           (tenant_id, request_id, endpoint, request_hash,
            input_first_name, input_last_name, input_middle_name, input_full_name,
            input_domain, input_email, email, status, sub_status, score, reason_codes,
            provider, backend, evidence, collision_risk, accept_all, disposable, webmail,
            mx_records, smtp_check, raw_smtp_code, enhanced_code, candidates, source, billed,
            verified_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27::jsonb,$28,$29,$30,$31)
         ON CONFLICT (tenant_id, request_id) DO UPDATE SET request_id = EXCLUDED.request_id
         RETURNING id, tenant_id, request_id, endpoint, request_hash,
                   input_first_name, input_last_name, input_middle_name, input_full_name,
                   input_domain, input_email, email, status, sub_status, score, reason_codes,
                   provider, backend, evidence, collision_risk, accept_all, disposable, webmail,
                   mx_records, smtp_check, raw_smtp_code, enhanced_code, candidates, source, billed,
                   verified_at, created_at, expires_at`,
        [
          row.tenantId, row.requestId, row.endpoint, row.requestHash,
          row.inputFirstName, row.inputLastName, row.inputMiddleName, row.inputFullName,
          row.inputDomain, row.inputEmail, row.email, row.status, row.subStatus, row.score, row.reasonCodes,
          row.provider, row.backend, row.evidence, row.collisionRisk, row.acceptAll, row.disposable, row.webmail,
          row.mxRecords, row.smtpCheck, row.rawSmtpCode, row.enhancedCode, JSON.stringify(row.candidates),
          row.source, row.billed, row.verifiedAt, row.expiresAt,
        ],
      );
      return mapResult(inserted as ResultRaw);
    },

    async findFreshByRequestHash(q, tenantId, requestHash, notBefore) {
      const row = await maybeOne<ResultRaw>(
        q,
        `${SELECT}
          WHERE tenant_id = $1 AND request_hash = $2 AND created_at >= $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, requestHash, notBefore],
      );
      return row ? mapResult(row) : null;
    },

    async byId(q, id) {
      const row = await maybeOne<ResultRaw>(q, `${SELECT} WHERE id = $1`, [id]);
      return row ? mapResult(row) : null;
    },

    async listForTenantByEmail(q, tenantId, email) {
      const rs = await rows<ResultRaw>(
        q,
        `${SELECT}
          WHERE tenant_id = $1 AND (email = $2 OR input_email = $2)
          ORDER BY created_at DESC`,
        [tenantId, email],
      );
      return rs.map(mapResult);
    },

    async deleteForTenantByEmail(q, tenantId, email) {
      return rowCount(
        q,
        `DELETE FROM results WHERE tenant_id = $1 AND (email = $2 OR input_email = $2)`,
        [tenantId, email],
      );
    },

    async markDowngraded(q, id) {
      await q.query(`UPDATE results SET billed = false WHERE id = $1`, [id]);
    },

    async purgeExpired(q, now, limit) {
      return rowCount(
        q,
        `DELETE FROM results
          WHERE id IN (SELECT id FROM results WHERE expires_at < $1 ORDER BY expires_at LIMIT $2)`,
        [now, limit],
      );
    },

    async countOverdue(q, cutoff) {
      const row = await maybeOne<{ n: string }>(
        q,
        `SELECT count(*)::text AS n FROM results WHERE expires_at < $1`,
        [cutoff],
      );
      return row ? Number(row.n) : 0;
    },
  };
}
