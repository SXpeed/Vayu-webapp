// The original app's own sign-in (its accounts in KV), switched off from the
// control centre once its people sign in with platform accounts.
//
// Stored in platform_settings under 'original_signin'. While closed:
//  - /api/auth/login, /api/auth/setup and /api/auth/session refuse, so no new
//    original session can start;
//  - a request carrying an original session is treated as signed out, so the
//    app shows its sign-in screen, which uses the platform account.
// Nothing is deleted: opening it again brings the old sessions back, which
// makes closing it safe to try.
//
// It can only be closed once an organization owns the original app's data
// (otherwise its people would have nowhere to sign in to), and, unless the
// admin says otherwise, once everyone in the original app has a platform
// account.

import type { Env } from '../workerEnv';
import { auditStmt } from './audit';
import { legacyPasswordHash, readLegacyUsers } from './legacyImport';
import { OrgError, type Actor } from './orgs';

const KEY = 'original_signin';
const CACHE_MS = 15_000;
let cached: { open: boolean; at: number } | null = null;

/** Whether the original sign-in still works. Open unless a provider admin closed it. */
export async function originalSignInOpen(db: D1Database | undefined): Promise<boolean> {
  if (!db) return true;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.open;
  let open = true;
  try {
    const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(KEY).first<{ value: string }>();
    if (row) open = (JSON.parse(row.value) as { open?: unknown }).open !== false;
  } catch {
    // Unreadable setting or database: keep the last known answer, else open,
    // so a platform outage never locks the original app's people out.
    open = cached?.open ?? true;
  }
  cached = { open, at: Date.now() };
  return open;
}

/** Test hook. */
export function resetOriginalSignInCache(): void {
  cached = null;
}

export interface OriginalSignInStatus {
  open: boolean;
  /** The organization that owns the original app's data, if one does. */
  connectedOrg: { id: string; name: string } | null;
  people: {
    total: number;
    /** Have a platform account with the same email. */
    withAccount: number;
    /** Emails still without a platform account (first 50). */
    withoutAccount: string[];
  };
}

export async function originalSignInStatus(env: Env, db: D1Database): Promise<OriginalSignInStatus> {
  const connectedOrg = await db.prepare("SELECT id, name FROM organizations WHERE app_storage = 'original'").first<{ id: string; name: string }>();
  const emails = [...new Set((await readLegacyUsers(env))
    .filter(u => !!legacyPasswordHash(u)) // records the app made for platform members have no password of their own
    .map(u => u.email?.trim().toLowerCase())
    .filter((e): e is string => !!e))];
  const found = await Promise.all(emails.map(email => db.prepare('SELECT 1 FROM "user" WHERE email = ?').bind(email).first()));
  const without = emails.filter((_, i) => !found[i]);
  return {
    open: await originalSignInOpen(db),
    connectedOrg: connectedOrg ?? null,
    people: { total: emails.length, withAccount: emails.length - without.length, withoutAccount: without.slice(0, 50) },
  };
}

/**
 * Opens or closes the original sign-in. Closing needs a connected
 * organization, and everyone to have a platform account unless `force`.
 */
export async function setOriginalSignIn(env: Env, db: D1Database, body: Record<string, unknown>, actor: Actor): Promise<OriginalSignInStatus> {
  if (typeof body.open !== 'boolean') throw new OrgError(400, 'invalid', 'Expected { open: true | false }.');
  const status = await originalSignInStatus(env, db);
  if (!body.open) {
    if (!status.connectedOrg) {
      throw new OrgError(409, 'not_connected', "Connect an organization to the original app's data first (Organizations → App data), or its people would have nowhere to sign in.");
    }
    const missing = status.people.total - status.people.withAccount;
    if (missing > 0 && body.force !== true) {
      throw new OrgError(409, 'people_without_accounts',
        `${missing} ${missing === 1 ? 'person has' : 'people have'} no platform account yet: bring in the original app's people first, or close it anyway.`);
    }
  }
  await db.batch([
    db.prepare(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).bind(KEY, JSON.stringify({ open: body.open }), Date.now(), actor.userId),
    auditStmt(db, {
      actorUserId: actor.userId, actorKind: 'provider_admin', action: body.open ? 'settings.original_signin.open' : 'settings.original_signin.close',
      targetType: 'platform_settings', targetId: KEY,
      details: { withoutAccount: status.people.total - status.people.withAccount, forced: body.force === true },
      ip: actor.ip,
    }),
  ]);
  cached = { open: body.open, at: Date.now() };
  return { ...status, open: body.open };
}
