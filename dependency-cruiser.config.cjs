// Structural guardrails for the CONTRACTS_CORE §6 dependency DAG.
//
// Division of labour (intentional):
//   * This file (dependency-cruiser) blocks (a) import cycles and (b) any import that
//     reaches into ANOTHER @mailmetero package's `src/` internals instead of going
//     through its public entry point (the package name → dist/index barrel).
//   * The precise ALLOWED cross-package edge set (the §6 `depends_on` table) is
//     enforced separately by tools/ci/check-dag.test.ts against tools/ci/allowed-edges.cjs.
//     dependency-cruiser 16.x rejects unknown top-level keys, so the allow-list is not
//     embedded here; keeping the two concerns separate is deliberate.
//
// Group-matching note: `$1` in a `to` pattern refers to the capture group in the
// matching `from.path`, letting us compare from-package vs to-package.
'use strict';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'The §6 graph is a strict DAG — no RUNTIME import cycles. type-only edges are ' +
        'excluded (verbatimModuleSyntax erases them at emit, so they cannot form a runtime ' +
        'cycle); a cycle is a violation only if it can be closed using value imports.',
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-deep-cross-package-import',
      severity: 'error',
      comment:
        'Import another @mailmetero package only through its public entry (the package name, ' +
        'which resolves to dist/index), never by reaching into its src/ internals. Same-package ' +
        'src→src imports are allowed. Full allowed-edge DAG conformance is checked by ' +
        'tools/ci/check-dag.test.ts.',
      from: { path: '^packages/([^/]+)/src/' },
      to: {
        // A different package's source tree...
        path: '^packages/([^/]+)/src/',
        // ...but NOT the importer's own package (group-match on the from capture).
        pathNot: '^packages/$1/src/',
      },
    },
  ],
  options: {
    // Never traverse into installed deps or built output; lint source only.
    doNotFollow: { path: '(^|/)(node_modules|dist)/' },
    exclude: { path: '(^|/)(node_modules|dist|test)/|\\.(test|integration\\.test)\\.ts$' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    reporterOptions: { dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' } },
  },
};
