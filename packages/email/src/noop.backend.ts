// @mailmetero/email — the no-op backend. Used in dev, tests and the sandbox: it never
// touches the network. It "sends" by logging the message metadata (never the body,
// which may contain a plaintext API key) and returning a synthetic accepted receipt.

import type { Logger } from '@mailmetero/config';
import type { EmailBackend, OutboundEmail, SendReceipt } from './backend.js';

let counter = 0;

/**
 * Build a backend that captures instead of sending. The logger, if supplied, records
 * one line per message (to + kind only). The returned receipt is always `accepted`
 * with a deterministic, unique-per-process `noop-…` message id.
 */
export function makeNoopBackend(logger?: Logger): EmailBackend {
  return {
    kind: 'noop',
    async send(msg: OutboundEmail): Promise<SendReceipt> {
      const providerMessageId = `noop-${++counter}`;
      logger?.info(
        { event: 'email_noop_send', kind: msg.kind, tag: msg.tag, providerMessageId },
        'noop email backend captured message (not sent)',
      );
      return { providerMessageId, accepted: true };
    },
  };
}
