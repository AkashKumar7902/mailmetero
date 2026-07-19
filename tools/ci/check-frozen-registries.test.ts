// CI invariant (§9.2): the enums + reason/error registries are frozen. A snapshot pins
// every member; changing one requires an intentional snapshot update AND an OpenAPI
// version bump. Uses node:test's built-in snapshots (run with --test-update-snapshots
// to intentionally re-pin). Owned by config-deploy-ops.
import { test } from 'node:test';
import {
  STATUSES, SUB_STATUSES, MX_ENUMS, PROVIDERS, VERIFIABILITY_CLASSES,
  EVIDENCE_TIERS, BACKENDS, PIPELINE_STAGES, SIZE_BRACKETS, SOURCE_TAGS,
  JOB_STATUSES, RESPONSE_HEADERS, REASON_CODES, ERROR_CODES,
} from '@mailmetero/contracts';

test('frozen registries', (t) => {
  t.assert.snapshot({
    STATUSES, SUB_STATUSES, MX_ENUMS, PROVIDERS, VERIFIABILITY_CLASSES,
    EVIDENCE_TIERS, BACKENDS, PIPELINE_STAGES, SIZE_BRACKETS, SOURCE_TAGS,
    JOB_STATUSES, RESPONSE_HEADERS, REASON_CODES, ERROR_CODES,
  });
});
