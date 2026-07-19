// @mailmetero/email — the thin ESP (Postmark-class) interface.
// This module owns the transactional-email vocabulary: the three message KINDS the
// product sends (signup key, objection confirmation, quota alert), the outbound
// message shape, the send receipt, and the backend port. Concrete backends
// (postmark / noop) implement `EmailBackend`; templates build `OutboundEmail`s.
//
// Invariant enforced by construction: `OutboundEmail.tag === OutboundEmail.kind`.
// The `tag` is what Postmark records for per-message-type analytics, so keeping it
// equal to `kind` means our internal taxonomy and the ESP's reporting never drift.

/** The exhaustive set of transactional emails mailmetero sends. */
export type EmailMessageKind = 'signup_key' | 'objection_confirmation' | 'quota_alert';

/**
 * A fully-rendered outbound message, provider-agnostic. Templates produce these;
 * backends serialize them onto the wire. `messageStream` is optional here: a template
 * never sets it (the backend applies its configured stream), but a caller may override.
 */
export interface OutboundEmail {
  to: string;
  kind: EmailMessageKind;
  subject: string;
  html: string;
  text: string;
  /** MUST equal `kind` (see module note); templates guarantee this. */
  tag: EmailMessageKind;
  /** Optional per-message stream override; omitted by templates. */
  messageStream?: string;
}

/** Outcome of a send attempt. `accepted` is the ESP's acknowledgement, not delivery. */
export interface SendReceipt {
  providerMessageId: string;
  accepted: boolean;
}

/** The port api/cron depend on. Injected as postmark (prod) or noop (dev/test/sandbox). */
export interface EmailBackend {
  readonly kind: 'postmark' | 'noop';
  send(msg: OutboundEmail): Promise<SendReceipt>;
}
