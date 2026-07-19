// @mailmetero/api — internal→wire mapping re-export.
//
// The ONE internal→wire boundary lives in `@mailmetero/pipeline` (casing rule). api routes import
// the mappers through this thin re-export so no route hand-builds a snake_case wire shape.

export {
  toFinderResult,
  toVerifierResult,
  toWireCandidate,
  toVerificationSummary,
  toBulkFinderRow,
  toBulkVerifierRow,
} from '@mailmetero/pipeline';
