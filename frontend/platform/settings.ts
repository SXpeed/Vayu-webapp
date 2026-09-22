// Platform-wide login-method switches, managed from the provider control panel.
//
// Stored in platform_settings under 'login_methods'. Read on every auth
// request, so each isolate keeps a short-lived copy; a write through this
// module refreshes it at once, other isolates within CACHE_MS.

import type { Env } from '../workerEnv';

export interface LoginMethods {
  /** Email + password ("local accounts"). */
  emailPassword: { signIn: boolean; signUp: boolean };
  /** Google OAuth. Usable only when GOOGLE_CLIENT_ID/SECRET are configured. */
  google: { signIn: boolean; signUp: boolean };
}

/** Safe starting point: local sign-in only. Public sign-up opens with the
 *  onboarding flow, once verification email is configured. */
export const DEFAULT_LOGIN_METHODS: LoginMethods = {
  emailPassword: { signIn: true, signUp: false },
  google: { signIn: false, signUp: false },
};

const KEY = 'login_methods';
const CACHE_MS = 15_000;
let cached: { value: LoginMethods; at: number } | null = null;

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function normalize(raw: unknown): LoginMethods {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof LoginMethods, Partial<Record<'signIn' | 'signUp', unknown>>>>;
  const pick = (group: keyof LoginMethods, field: 'signIn' | 'signUp') => {
    const v = src[group]?.[field];
    return typeof v === 'boolean' ? v : DEFAULT_LOGIN_METHODS[group][field];
  };
  return {
    emailPassword: { signIn: pick('emailPassword', 'signIn'), signUp: pick('emailPassword', 'signUp') },
    google: { signIn: pick('google', 'signIn'), signUp: pick('google', 'signUp') },
  };
}

/** Stored switches, before applying what the environment can actually do. */
export async function getStoredLoginMethods(db: D1Database): Promise<LoginMethods> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(KEY).first<{ value: string }>();
  let value = DEFAULT_LOGIN_METHODS;
  if (row) {
    try { value = normalize(JSON.parse(row.value)); } catch { value = DEFAULT_LOGIN_METHODS; }
  }
  cached = { value, at: Date.now() };
  return value;
}

/** What is really available right now: Google is off without credentials,
 *  and sign-up implies nothing about sign-in. */
export async function getEffectiveLoginMethods(env: Env, db: D1Database): Promise<LoginMethods> {
  const stored = await getStoredLoginMethods(db);
  const google = googleConfigured(env);
  return {
    emailPassword: { ...stored.emailPassword },
    google: { signIn: google && stored.google.signIn, signUp: google && stored.google.signUp },
  };
}

export class SettingsError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/**
 * Validates a requested change. Refuses anything that could lock everyone
 * out: there must always be a sign-in method that works, and the admin making
 * the change must keep a way back in.
 */
export function validateLoginMethods(
  next: LoginMethods,
  opts: { googleConfigured: boolean; actorHasGoogle: boolean },
): void {
  if ((next.google.signIn || next.google.signUp) && !opts.googleConfigured) {
    throw new SettingsError('google_not_configured', 'Google sign-in needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set first.');
  }
  if (!next.emailPassword.signIn && !next.google.signIn) {
    throw new SettingsError('no_sign_in_method', 'At least one sign-in method must stay on.');
  }
  if (!next.emailPassword.signIn && !opts.actorHasGoogle) {
    throw new SettingsError('actor_lockout', 'Link a Google account to your admin login before turning off email and password sign-in, or you would lock yourself out.');
  }
  if (next.emailPassword.signUp && !next.emailPassword.signIn) {
    throw new SettingsError('signup_without_signin', 'Email sign-up needs email sign-in on too.');
  }
  if (next.google.signUp && !next.google.signIn) {
    throw new SettingsError('signup_without_signin', 'Google sign-up needs Google sign-in on too.');
  }
}

export function parseLoginMethods(body: unknown): LoginMethods {
  const b = body as Record<string, Record<string, unknown>> | null;
  const ok = (g: string) => b && typeof b[g] === 'object'
    && typeof b[g].signIn === 'boolean' && typeof b[g].signUp === 'boolean';
  if (!ok('emailPassword') || !ok('google')) {
    throw new SettingsError('invalid', 'Expected { emailPassword: { signIn, signUp }, google: { signIn, signUp } } with true/false values.');
  }
  return normalize(b);
}

export function saveLoginMethodsStmt(db: D1Database, value: LoginMethods, actorId: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(KEY, JSON.stringify(value), Date.now(), actorId);
}

/** Call after a successful write so this isolate sees it immediately. */
export function rememberLoginMethods(value: LoginMethods): void {
  cached = { value, at: Date.now() };
}

/** Test hook. */
export function resetLoginMethodsCache(): void {
  cached = null;
}
