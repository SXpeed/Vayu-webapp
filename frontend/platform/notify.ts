// Notifications: queued in the same database step as the change that causes
// them, so a notice can't be lost, and keyed so a retried request never
// queues the same notice twice.
//
// deliverOutbox sends them through Cloudflare Email Service (email.ts): right
// after the request that queued them, and again on a schedule for anything
// that failed. Without the EMAIL binding rows simply wait, and the control
// panel lists them. Nothing depends on delivery: an application is visible in
// the approval queue whether or not its email ever goes out.

import { ADMIN_ORIGIN, APP_ORIGIN, SITE_ORIGIN } from '../brand';
import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { emailConfigured, sendEmail, type EmailContent, type SendResult } from './email';
import { OrgError, type Actor } from './orgs';

const SETTINGS_KEY = 'notifications';

export interface NotificationSettings {
  /** Where "a new application arrived" notices go. */
  providerEmail: string | null;
}

export async function getNotificationSettings(db: D1Database): Promise<NotificationSettings> {
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(SETTINGS_KEY).first<{ value: string }>();
  try {
    const parsed = row ? JSON.parse(row.value) as Partial<NotificationSettings> : {};
    return { providerEmail: typeof parsed.providerEmail === 'string' && parsed.providerEmail ? parsed.providerEmail : null };
  } catch {
    return { providerEmail: null };
  }
}

export async function updateNotificationSettings(db: D1Database, body: Record<string, unknown>, actor: Actor) {
  const raw = typeof body.providerEmail === 'string' ? body.providerEmail.trim().toLowerCase() : '';
  if (raw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new OrgError(400, 'invalid', 'Enter a valid email address, or leave it empty.');
  const next: NotificationSettings = { providerEmail: raw || null };
  await db.batch([
    db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(SETTINGS_KEY, JSON.stringify(next), Date.now(), actor.userId),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'settings.notifications.update', targetType: 'platform_settings', targetId: SETTINGS_KEY, details: next, ip: actor.ip }),
  ]);
  return next;
}

/**
 * Queues one notice. The dedupe key names the event ("application 123
 * submitted, round 2"), so running the same step twice queues it once.
 */
export function outboxStmt(db: D1Database, n: { dedupeKey: string; kind: string; recipient: string; subject: string; body: string }): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notification_outbox (id, dedupe_key, kind, recipient, subject, body, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(crypto.randomUUID(), n.dedupeKey, n.kind, n.recipient, n.subject.slice(0, 200), n.body.slice(0, 4000), Date.now());
}

export async function listOutbox(db: D1Database, params: URLSearchParams) {
  const status = params.get('status');
  const where = status && ['pending', 'sent', 'failed', 'cancelled'].includes(status) ? 'WHERE status = ?' : '';
  const stmt = db.prepare(
    `SELECT id, kind, recipient, subject, status, attempts, last_error, created_at, sent_at
     FROM notification_outbox ${where} ORDER BY created_at DESC LIMIT 100`,
  );
  const { results } = await (where ? stmt.bind(status) : stmt).all();
  const counts = await db.prepare('SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status').all();
  return { notifications: results, counts: Object.fromEntries((counts.results as { status: string; n: number }[]).map(r => [r.status, r.n])) };
}

export async function retryNotification(db: D1Database, id: string, actor: Actor) {
  const row = await db.prepare('SELECT status FROM notification_outbox WHERE id = ?').bind(id).first<{ status: string }>();
  if (!row) throw new OrgError(404, 'not_found', 'Notification not found.');
  if (row.status === 'sent') throw new OrgError(409, 'already_sent', 'This notification was already sent.');
  await db.batch([
    db.prepare("UPDATE notification_outbox SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE id = ?").bind(id),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'notification.retry', targetType: 'notification', targetId: id, ip: actor.ip }),
  ]);
}

export async function cancelNotification(db: D1Database, id: string, actor: Actor) {
  await db.batch([
    db.prepare("UPDATE notification_outbox SET status = 'cancelled' WHERE id = ? AND status <> 'sent'").bind(id),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'notification.cancel', targetType: 'notification', targetId: id, ip: actor.ip }),
  ]);
}

// ── Delivery ──────────────────────────────────────────────────────────────

/** After the first attempt fails: wait 5 min, 30 min, 2 h, 12 h, then give up. */
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** What each kind of notice says and where its button goes. */
export function noticeContent(kind: string, subject: string, body: string): EmailContent {
  const statusPage = { label: 'Open your application', url: `${SITE_ORIGIN}/signup?mode=signin` };
  switch (kind) {
    case 'application_submitted':
      return { heading: subject, paragraphs: [body], action: { label: 'Review it', url: `${ADMIN_ORIGIN}/#/applications` } };
    case 'application_needs_information':
      return {
        heading: 'We need a little more information',
        paragraphs: ['We looked at your application and have a question:', body, 'Answer it and send your application again from your application page.'],
        action: statusPage,
      };
    case 'application_rejected':
      return {
        heading: 'About your application',
        paragraphs: ['We are not able to approve your application at the moment.', body, 'Reply to this email if you have questions.'],
        action: statusPage,
      };
    case 'workspace_ready':
      return {
        heading: 'Your workspace is ready',
        paragraphs: [body, 'Sign in to the app with the same account you applied with.'],
        action: { label: 'Open the app', url: APP_ORIGIN },
      };
    default:
      return { heading: subject, paragraphs: [body] };
  }
}

interface OutboxRow { id: string; kind: string; recipient: string; subject: string; body: string; attempts: number }

/**
 * Sends pending notices that are due. Each attempt is claimed first (the
 * attempt counter moves only if nobody else moved it), so two runs at the
 * same moment never send the same notice twice.
 */
export async function deliverOutbox(env: Env, db: D1Database, limit = 20): Promise<{ sent: number; failed: number }> {
  if (!emailConfigured(env)) return { sent: 0, failed: 0 };
  const now = Date.now();
  const { results } = await db.prepare(
    `SELECT id, kind, recipient, subject, body, attempts FROM notification_outbox
     WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at LIMIT ?`,
  ).bind(now, limit).all<OutboxRow>();
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    const claim = await db.prepare(
      "UPDATE notification_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?",
    ).bind(now + RETRY_DELAYS_MS[0], row.id, row.attempts).run();
    if (!claim.meta.changes) continue;
    const result = await sendEmail(env, row.recipient, row.subject, noticeContent(row.kind, row.subject, row.body));
    await recordAttempt(db, row.id, row.attempts + 1, result);
    if (result.sent) sent++;
    else failed++;
  }
  return { sent, failed };
}

/** Sent, or failed: then either wait for the next try or, after the last one, give up. */
async function recordAttempt(db: D1Database, id: string, attempt: number, result: SendResult): Promise<void> {
  if (result.sent) {
    await db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?").bind(Date.now(), id).run();
    return;
  }
  const giveUp = attempt >= MAX_ATTEMPTS;
  await db.prepare('UPDATE notification_outbox SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?')
    .bind(giveUp ? 'failed' : 'pending', result.error ?? result.reason, giveUp ? null : Date.now() + RETRY_DELAYS_MS[attempt - 1], id).run();
}
