// Email, sent through Cloudflare Email Service (the `EMAIL` send_email
// binding). One place builds every message the platform sends, so they all
// look the same and always carry a plain-text version.
//
// Two kinds of sending:
// - Links that act on an account (confirm your email, reset your password,
//   join an organization) are sent directly, inside the request that makes
//   them. Their tokens never touch the outbox table.
// - Notices (application received, approved, questions) go through the
//   outbox (notify.ts), which retries until they are delivered.
//
// Without the binding nothing is sent and callers get { sent: false }:
// sign-up and approvals keep working, and notices wait in the outbox.

import { APP_NAME } from '../brand';
import type { Env } from '../workerEnv';

export interface EmailContent {
  /** Short heading at the top of the message. */
  heading: string;
  /** Paragraphs of plain text; blank lines are not needed. */
  paragraphs: string[];
  /** One call to action. */
  action?: { label: string; url: string };
  /** Small print under the button, such as how long a link lasts. */
  footnote?: string;
}

export type SendResult = { sent: true } | { sent: false; reason: 'not_configured' | 'failed'; error?: string };

/** The binding exists and sending isn't switched off (EMAIL_SENDING=off stops all email). */
export function emailConfigured(env: Env): boolean {
  return !!env.EMAIL && env.EMAIL_SENDING !== 'off';
}

function fromAddress(env: Env): string {
  return env.EMAIL_FROM?.trim() || `no-reply@ateliersupport.com`;
}

export async function sendEmail(env: Env, to: string, subject: string, content: EmailContent): Promise<SendResult> {
  if (!env.EMAIL || !emailConfigured(env)) return { sent: false, reason: 'not_configured' };
  try {
    await env.EMAIL.send({
      from: { name: APP_NAME, email: fromAddress(env) },
      to,
      subject,
      text: renderText(content),
      html: renderHtml(subject, content),
      ...(env.EMAIL_REPLY_TO ? { replyTo: env.EMAIL_REPLY_TO } : {}),
    });
    return { sent: true };
  } catch (e) {
    // The provider's message says why (domain not onboarded, bad address);
    // it is kept for the outbox and the logs, never shown to the recipient.
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Email to ${to.replace(/^(.).*@/, '$1…@')} failed: ${error}`);
    return { sent: false, reason: 'failed', error: error.slice(0, 300) };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────

export function renderText(c: EmailContent): string {
  const parts = [c.heading, '', ...c.paragraphs.flatMap(p => [p, ''])];
  if (c.action) parts.push(`${c.action.label}: ${c.action.url}`, '');
  if (c.footnote) parts.push(c.footnote, '');
  parts.push('—', APP_NAME);
  return parts.join('\n');
}

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Table layout and inline styles: what email clients reliably render. */
export function renderHtml(subject: string, c: EmailContent): string {
  const paragraphs = c.paragraphs
    .map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#33373d;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 8px;"><tr><td style="border-radius:10px;background:#c5a028;">
         <a href="${esc(c.action.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#1d1a12;text-decoration:none;border-radius:10px;">${esc(c.action.label)}</a>
       </td></tr></table>
       <p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#6b7078;">Or paste this address into your browser:<br><span style="word-break:break-all;color:#33373d;">${esc(c.action.url)}</span></p>`
    : '';
  const footnote = c.footnote ? `<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#6b7078;">${esc(c.footnote)}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef0f3;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f3;padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 6px 14px;font-family:Georgia,'Times New Roman',serif;font-size:20px;color:#1d2127;">${esc(APP_NAME)}</td></tr>
<tr><td style="background:#ffffff;border-radius:14px;padding:28px 26px;">
<h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:22px;line-height:1.3;color:#1d2127;">${esc(c.heading)}</h1>
${paragraphs}${button}${footnote}
</td></tr>
<tr><td style="padding:14px 6px 0;font-size:12px;color:#6b7078;">You received this because of an account at ${esc(APP_NAME)}. If it wasn't you, you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;
}
