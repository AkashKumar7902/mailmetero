// @mailmetero/email — typed template builders. Each builder is a pure function that
// returns a fully-rendered `OutboundEmail` whose `tag === kind` (the ESP-analytics
// invariant). Interpolated caller values are HTML-escaped in the html body so a value
// containing '<', '&' or a quote can never break markup or inject an attribute.

import type { EmailMessageKind, OutboundEmail } from './backend.js';

/** Escape the five HTML-significant characters for safe interpolation into markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal HTML document wrapper shared by every template (self-contained, inline). */
function htmlDoc(title: string, bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title></head>',
    '<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;">',
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">',
    '<p style="font-size:12px;color:#888;">mailmetero — sent because you interacted with our API. This is a transactional message.</p>',
    '</body>',
    '</html>',
  ].join('');
}

/**
 * Construct an OutboundEmail with the tag pinned to the kind. Centralizing this is what
 * makes the `tag === kind` invariant hold for every template without repetition.
 */
function makeEmail(
  kind: EmailMessageKind,
  input: { to: string; subject: string; html: string; text: string },
): OutboundEmail {
  return {
    to: input.to,
    kind,
    subject: input.subject,
    html: input.html,
    text: input.text,
    tag: kind,
  };
}

/** Signup: deliver the freshly-minted plaintext API key + a link to the docs. */
export function buildSignupKeyEmail(input: {
  to: string;
  apiKeyPlaintext: string;
  docsUrl: string;
}): OutboundEmail {
  const subject = 'Your mailmetero API key';
  const key = escapeHtml(input.apiKeyPlaintext);
  const docs = escapeHtml(input.docsUrl);
  const html = htmlDoc(subject, [
    '<h2 style="margin:0 0 12px;">Welcome to mailmetero</h2>',
    '<p>Your API key is ready. Use it as a Bearer token on every request:</p>',
    '<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;background:#f4f4f5;padding:12px 16px;border-radius:6px;word-break:break-all;">' +
      key +
      '</p>',
    '<p><strong>Store it now</strong> — for security we cannot show it again.</p>',
    '<p><a href="' + docs + '" style="color:#2563eb;">Read the API documentation</a></p>',
  ].join(''));
  const text = [
    'Welcome to mailmetero',
    '',
    'Your API key (use it as a Bearer token on every request):',
    '',
    '    ' + input.apiKeyPlaintext,
    '',
    'Store it now — for security we cannot show it again.',
    '',
    'Documentation: ' + input.docsUrl,
  ].join('\n');
  return makeEmail('signup_key', { to: input.to, subject, html, text });
}

/** Objection: send the double-opt-in confirmation link with its expiry. */
export function buildObjectionConfirmationEmail(input: {
  to: string;
  confirmUrl: string;
  expiresAt: string;
}): OutboundEmail {
  const subject = 'Confirm your mailmetero data objection request';
  const url = escapeHtml(input.confirmUrl);
  const expires = escapeHtml(input.expiresAt);
  const html = htmlDoc(subject, [
    '<h2 style="margin:0 0 12px;">Confirm your objection request</h2>',
    '<p>We received a request to suppress this email address from mailmetero results. ' +
      'To confirm, click the button below.</p>',
    '<p><a href="' + url + '" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;">Confirm suppression</a></p>',
    '<p style="font-size:13px;color:#555;">Or paste this link into your browser:<br>' + url + '</p>',
    '<p style="font-size:13px;color:#555;">This link expires at <strong>' + expires + '</strong>. ' +
      'If you did not make this request, no action is needed.</p>',
  ].join(''));
  const text = [
    'Confirm your objection request',
    '',
    'We received a request to suppress this email address from mailmetero results.',
    'To confirm, open this link:',
    '',
    '    ' + input.confirmUrl,
    '',
    'This link expires at ' + input.expiresAt + '.',
    'If you did not make this request, no action is needed.',
  ].join('\n');
  return makeEmail('objection_confirmation', { to: input.to, subject, html, text });
}

/** Quota alert: warn the tenant they are approaching (or at) their plan limit. */
export function buildQuotaAlertEmail(input: {
  to: string;
  planName: string;
  usedPct: number;
  resetDate: string;
}): OutboundEmail {
  const pct = Math.max(0, Math.min(100, Math.round(input.usedPct)));
  const subject = `You've used ${pct}% of your mailmetero quota`;
  const plan = escapeHtml(input.planName);
  const reset = escapeHtml(input.resetDate);
  const html = htmlDoc(subject, [
    '<h2 style="margin:0 0 12px;">Quota usage alert</h2>',
    '<p>You have used <strong>' + pct + '%</strong> of your monthly quota on the <strong>' +
      plan + '</strong> plan.</p>',
    '<p>Your quota resets on <strong>' + reset + '</strong>. ' +
      'To avoid interruption, consider upgrading before then.</p>',
  ].join(''));
  const text = [
    'Quota usage alert',
    '',
    'You have used ' + pct + '% of your monthly quota on the ' + input.planName + ' plan.',
    'Your quota resets on ' + input.resetDate + '.',
    'To avoid interruption, consider upgrading before then.',
  ].join('\n');
  return makeEmail('quota_alert', { to: input.to, subject, html, text });
}
