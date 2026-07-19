// @mailmetero/email — public surface. The thin ESP interface: message types + backend
// port, the Postmark and no-op backends, the typed template builders, and the ESP
// egress host reference constant.
export type {
  EmailBackend,
  OutboundEmail,
  SendReceipt,
  EmailMessageKind,
} from './backend.js';
export { makePostmarkBackend } from './postmark.backend.js';
export { makeNoopBackend } from './noop.backend.js';
export {
  buildSignupKeyEmail,
  buildObjectionConfirmationEmail,
  buildQuotaAlertEmail,
} from './templates.js';
export { EMAIL_EGRESS_HOSTS } from './hosts.js';
