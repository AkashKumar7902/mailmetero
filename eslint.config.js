// Flat ESLint config. Two mailmetero-specific enforcement rules (CONTRACTS_CORE §9):
//   (A) egress centralization — no direct network APIs outside @mailmetero/config
//   (B) scoring magic numbers — cap literals forbidden in scoring code
import tseslint from 'typescript-eslint';

/** Network primitives banned everywhere except @mailmetero/config (the egress choke point). */
const BANNED_NET_IMPORTS = ['node:http', 'node:https', 'http', 'https', 'undici', 'axios', 'got', 'node-fetch'];

export default tseslint.config(
  // Never lint build output or deps — only source. (dist/*.d.ts break the TS parser.)
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },
  {
    files: ['packages/**/src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      // (A) egress allowlist: force all outbound HTTP through @mailmetero/config's egressFetch.
      'no-restricted-imports': ['error', { paths: BANNED_NET_IMPORTS.map((name) => ({
        name,
        message: 'Outbound network is centralized in @mailmetero/config (egressFetch). Do not import raw HTTP clients.',
      })) }],
      'no-restricted-globals': ['error', {
        name: 'fetch',
        message: 'Use egressFetch from @mailmetero/config so the host is allowlist-checked and logged.',
      }],
    },
  },
  {
    // @mailmetero/config IS the choke point — it may use fetch + node:http(s).
    files: ['packages/config/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-globals': 'off' },
  },
  {
    // (B) no scoring magic numbers: cap ceilings must come from a loaded ScoringConfig (D8).
    files: ['packages/core/src/scoring/**/*.ts', 'packages/pipeline/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'Literal[value=84], Literal[value=60], Literal[value=55], Literal[value=70], Literal[value=95]',
        message: 'Scoring caps/bands must be read from ScoringConfig, never inlined (D8, CONTRACTS_CORE §9.7).',
      }],
    },
  },
);
