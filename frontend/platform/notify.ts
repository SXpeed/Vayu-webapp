// Notifications: queued in the same database step as the change that causes
// them, so a notice can't be lost, and keyed so a retried request never
// queues the same notice twice.
//
// No email provider is configured yet (see docs/PENDING.md §1.1), so rows
// wait in notification_outbox and the control panel lists them. Nothing
// depends on delivery: an application is visible in the approval queue
// whether or not its email ever goes out.

import { auditStmt } from './audit';
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
    db.prepare("UPDATE notification_outbox SET status = 'pending', last_error = NULL WHERE id = ?").bind(id),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'notification.retry', targetType: 'notification', targetId: id, ip: actor.ip }),
  ]);
}

export async function cancelNotification(db: D1Database, id: string, actor: Actor) {
  await db.batch([
    db.prepare("UPDATE notification_outbox SET status = 'cancelled' WHERE id = ? AND status <> 'sent'").bind(id),
    auditStmt(db, { actorUserId: actor.userId, actorKind: 'provider_admin', action: 'notification.cancel', targetType: 'notification', targetId: id, ip: actor.ip }),
  ]);
}
