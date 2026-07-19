// @mailmetero/db — KbProviderFingerprintsRepo (MX-suffix → provider/verifiability).

import type { Provider, VerifiabilityClass } from '@mailmetero/contracts';
import type { Queryable } from '../client.ts';
import { rows } from '../client.ts';
import type { KbProviderFingerprintRow } from '../types.ts';

interface FpRaw {
  id: number;
  mx_suffix: string;
  provider: string;
  verifiability_class: string;
  priority: number;
  notes: string | null;
}

function mapFp(r: FpRaw): KbProviderFingerprintRow {
  return {
    id: r.id,
    mxSuffix: r.mx_suffix,
    provider: r.provider as Provider,
    verifiabilityClass: r.verifiability_class as VerifiabilityClass,
    priority: r.priority,
    notes: r.notes,
  };
}

export interface KbProviderFingerprintsRepo {
  loadAll(q: Queryable): Promise<KbProviderFingerprintRow[]>;
  upsert(q: Queryable, rows: Array<Omit<KbProviderFingerprintRow, 'id'>>): Promise<void>;
}

export function createKbProviderFingerprintsRepo(): KbProviderFingerprintsRepo {
  return {
    async loadAll(q) {
      const rs = await rows<FpRaw>(
        q,
        `SELECT id, mx_suffix, provider, verifiability_class, priority, notes
           FROM kb.provider_fingerprints
          ORDER BY priority DESC, length(mx_suffix) DESC`,
      );
      return rs.map(mapFp);
    },

    async upsert(q, rowsIn) {
      for (const r of rowsIn) {
        await q.query(
          `INSERT INTO kb.provider_fingerprints (mx_suffix, provider, verifiability_class, priority, notes)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (mx_suffix) DO UPDATE SET
             provider = EXCLUDED.provider,
             verifiability_class = EXCLUDED.verifiability_class,
             priority = EXCLUDED.priority,
             notes = EXCLUDED.notes,
             updated_at = now()`,
          [r.mxSuffix, r.provider, r.verifiabilityClass, r.priority, r.notes],
        );
      }
    },
  };
}
