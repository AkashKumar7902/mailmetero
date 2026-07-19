// The §6 (CONTRACTS_CORE) / §2 dependency DAG allow-list: package -> [packages it MAY import].
// Kept out of dependency-cruiser.config.cjs because dependency-cruiser 16.x validates that
// config against a strict schema that forbids unknown top-level keys. Consumed by
// tools/ci/check-dag.test.ts, which asserts every observed @mailmetero/* edge is permitted.
'use strict';

/** allowed intra-repo edges: package -> [packages it MAY import] */
const ALLOWED = {
  contracts: [],
  config: ['contracts'],
  core: ['contracts'],
  db: ['contracts', 'config'],
  dns: ['contracts', 'config'],
  verifier: ['contracts', 'config'],
  email: ['contracts', 'config'],
  pipeline: ['contracts', 'config', 'core', 'db', 'dns', 'verifier'],
  api: ['contracts', 'config', 'db', 'core', 'pipeline', 'verifier', 'dns', 'email'],
  worker: ['contracts', 'config', 'db', 'pipeline', 'verifier', 'dns', 'core'],
  cron: ['contracts', 'config', 'db', 'dns', 'email'],
};

module.exports = { ALLOWED };
