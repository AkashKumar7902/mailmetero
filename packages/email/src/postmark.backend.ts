// @mailmetero/email — the Postmark HTTPS backend. It posts a single transactional
// email through the injected `EgressFetch` (the ONE outbound choke point from
// @mailmetero/config, which enforces the allowlist and re-validates redirects). This
// module never calls `fetch`/undici/node:http directly — the eslint egress rule forbids
// it everywhere but config, and defense-in-depth we also refuse any baseUrl whose host
// is not the known Postmark host in EMAIL_EGRESS_HOSTS.

import type { EgressFetch, Logger } from '@mailmetero/config';
import type { EmailBackend, OutboundEmail, SendReceipt } from './backend.js';
import { EMAIL_EGRESS_HOSTS } from './hosts.ts';

/** Shape of the Postmark `POST /email` JSON response we depend on. */
interface PostmarkResponse {
  MessageID?: string;
  ErrorCode?: number;
  Message?: string;
}

function isAllowedPostmarkHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (EMAIL_EGRESS_HOSTS as readonly string[]).includes(host);
}

/**
 * Build the Postmark backend. `baseUrl` must resolve to the allowlisted Postmark host;
 * `apiKey` is the server token; `fromEmail`/`messageStream` are the account defaults.
 * Each send POSTs `{baseUrl}/email` with the `X-Postmark-Server-Token` header.
 */
export function makePostmarkBackend(deps: {
  fetch: EgressFetch;
  baseUrl: string;
  apiKey: string;
  fromEmail: string;
  messageStream: string;
  logger: Logger;
}): EmailBackend {
  if (!isAllowedPostmarkHost(deps.baseUrl)) {
    throw new Error(
      `postmark backend: baseUrl host is not an allowlisted ESP host (expected one of ${EMAIL_EGRESS_HOSTS.join(', ')})`,
    );
  }
  // Normalize to a single '/email' endpoint regardless of trailing slash on baseUrl.
  const endpoint = new URL('./email', deps.baseUrl.endsWith('/') ? deps.baseUrl : `${deps.baseUrl}/`).toString();

  return {
    kind: 'postmark',
    async send(msg: OutboundEmail): Promise<SendReceipt> {
      const body = {
        From: deps.fromEmail,
        To: msg.to,
        Subject: msg.subject,
        HtmlBody: msg.html,
        TextBody: msg.text,
        MessageStream: msg.messageStream ?? deps.messageStream,
        Tag: msg.tag,
      };

      const res = await deps.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': deps.apiKey,
        },
        body: JSON.stringify(body),
      });

      let parsed: PostmarkResponse = {};
      try {
        parsed = (await res.json()) as PostmarkResponse;
      } catch {
        parsed = {};
      }

      // Postmark signals success with HTTP 200 AND ErrorCode 0.
      const accepted = res.ok && parsed.ErrorCode === 0;
      const providerMessageId = parsed.MessageID ?? '';

      if (!accepted) {
        deps.logger.warn(
          {
            event: 'email_postmark_rejected',
            kind: msg.kind,
            tag: msg.tag,
            httpStatus: res.status,
            errorCode: parsed.ErrorCode ?? null,
            postmarkMessage: parsed.Message ?? null,
          },
          'postmark rejected the message',
        );
      } else {
        deps.logger.info(
          { event: 'email_postmark_sent', kind: msg.kind, tag: msg.tag, providerMessageId },
          'postmark accepted the message',
        );
      }

      return { providerMessageId, accepted };
    },
  };
}
