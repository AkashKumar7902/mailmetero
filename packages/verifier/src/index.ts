// @mailmetero/verifier — pluggable verifier backends (PRD P0-6, D10).
// Public surface: SMTP classifier, MillionVerifier-class vendor client, HttpsApiBackend (v1 default),
// NullBackend (degradation), and the catch-all probe. The VerifierBackend / VerifyOutcome / VerifyContext
// contracts themselves live in @mailmetero/contracts and are re-exported by consumers from there.

export * from './status-codes.js'; // classifySmtpCode, SmtpCodeClassification
export * from './vendor-client.js'; // createFetchVendorClient, HttpsVerifierVendorClient, VendorVerifyResponse
export * from './https-api-backend.js'; // createHttpsApiBackend, DEFAULT_MILLIONVERIFIER_RESULT_MAP, VendorResultMap, HttpsApiBackendOptions
export * from './null-backend.js'; // createNullBackend
export * from './catch-all.js'; // createCatchAllProbe, randomProbeLocalPart, CatchAllProbe, CatchAllVerdict
