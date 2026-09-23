// Better Auth, configured for the platform database.
//
// Identity only: who someone is and their session. Organization membership,
// roles and provider-admin status live in our own tables and are checked
// separately; signing in (with a password or Google) never grants either.
//
// One instance per (origin, login-method switches) per isolate: the config
// depends on the switches the control panel sets, so a change builds a new one.

import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { APIError } from 'better-auth/api';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { APP_NAME } from '../brand';
import type { Env } from '../workerEnv';
import type { LoginMethods } from './settings';
import { emailConfigured, sendEmail } from './email';

export const AUTH_BASE_PATH = '/api/v2/auth';

// ── Passwords ─────────────────────────────────────────────────────────────
// New passwords use Better Auth's scrypt hash ("salt:key", hex). Accounts
// migrated from the original app keep their PBKDF2 hash ("salt.hash",
// base64, 100k iterations, SHA-256) so nobody has to reset a password.

const LEGACY_PBKDF2 = /^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.codePointAt(0) ?? 0);
}

export function isLegacyHash(hash: string): boolean {
  return LEGACY_PBKDF2.test(hash);
}

export async function verifyLegacyPbkdf2(password: string, stored: string): Promise<boolean> {
  const [saltB64, hashB64] = stored.split('.');
  const expected = fromB64(hashB64);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations: 100_000 }, key, 256,
  ));
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

// ── Origins ───────────────────────────────────────────────────────────────

export function configuredOrigins(env: Env): string[] {
  return (env.AUTH_ORIGINS ?? '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * The configured origin this request is for, or null (fail closed). In
 * development a single configured origin also covers the Vite proxy, which
 * rewrites the Host header to the local worker's.
 */
export function resolveAuthOrigin(env: Env, url: URL): string | null {
  const origins = configuredOrigins(env);
  const match = origins.find(o => new URL(o).host === url.host);
  if (match) return match;
  if (env.PLATFORM_ENV === 'development' && origins.length === 1) return origins[0];
  return null;
}

// ── Instance ──────────────────────────────────────────────────────────────

function buildAuth(env: Env, db: D1Database, origin: string, methods: LoginMethods) {
  const secure = origin.startsWith('https://');
  return betterAuth({
    appName: APP_NAME,
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: db,
    trustedOrigins: configuredOrigins(env),
    emailAndPassword: {
      // Sign-in and sign-up are switched separately; with both off, the
      // email endpoints are disabled outright.
      enabled: methods.emailPassword.signIn || methods.emailPassword.signUp,
      disableSignUp: !methods.emailPassword.signUp,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      // Signing in never waits on a confirmed email: accounts made before
      // email existed (and by the control centre) would be locked out.
      // Sending an application does need one (applyRoutes.ts).
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 3600,
      // A reset ends every session, so a stolen one stops working.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(env, user.email, 'Reset your password', {
          heading: 'Reset your password',
          paragraphs: [`Someone asked to reset the password for ${user.email}. If it was you, choose a new one with the button below.`],
          action: { label: 'Choose a new password', url },
          footnote: 'The link works for one hour and only once. If you did not ask for this, ignore this email: your password stays as it is.',
        });
      },
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) =>
          isLegacyHash(hash) ? verifyLegacyPbkdf2(password, hash) : verifyPassword({ hash, password }),
      },
    },
    emailVerification: {
      sendOnSignUp: emailConfigured(env),
      autoSignInAfterVerification: true,
      expiresIn: 86_400,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(env, user.email, 'Confirm your email address', {
          heading: 'Confirm your email address',
          paragraphs: [`Confirm that ${user.email} is yours, so we can reach you about your account and your application.`],
          action: { label: 'Confirm email', url },
          footnote: 'The link works for 24 hours. If you did not create an account, ignore this email.',
        });
      },
    },
    socialProviders: methods.google.signIn
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            disableSignUp: !methods.google.signUp,
            prompt: 'select_account',
          },
        }
      : {},
    account: {
      accountLinking: {
        enabled: true,
        // A Google identity joins an existing account only when that person
        // is already signed in and links it explicitly (linkSocial). Never on
        // email match alone.
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 14 * 86_400,
      updateAge: 86_400,
      // Sensitive actions (control-panel settings, support sessions) ask for
      // a sign-in newer than this.
      freshAge: 30 * 60,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 3600, max: 5 },
        '/two-factor/verify-totp': { window: 60, max: 5 },
        '/two-factor/verify-backup-code': { window: 60, max: 5 },
        '/two-factor/enable': { window: 60, max: 5 },
      },
    },
    advanced: {
      // Off: the check starts when the instance is created and every later
      // database call waits on it. On Workers, a request that finishes before
      // it settles leaves it pending forever, so sign-in requests handled by
      // that isolate hang (seen in production, 2026-09-23). The schema is ours
      // anyway: platform/migrations, covered by the integration tests.
      database: { validateSchema: false },
      useSecureCookies: secure,
      cookiePrefix: 'as',
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure },
    },
    databaseHooks: {
      session: {
        create: {
          // A disabled account cannot start a session by any sign-in method.
          // (Disabling also revokes the sessions it already has.)
          before: async (session) => {
            const row = await db.prepare('SELECT status FROM platform_user_status WHERE user_id = ?')
              .bind(session.userId).first<{ status: string }>();
            if (row?.status === 'disabled') {
              throw new APIError('FORBIDDEN', { message: 'This account has been disabled. Contact support.', code: 'ACCOUNT_DISABLED' });
            }
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: APP_NAME }),
    ],
  });
}

export type PlatformAuth = ReturnType<typeof buildAuth>;

const instances = new Map<string, PlatformAuth>();

/**
 * One Better Auth instance per origin and login-method set, reused across
 * requests. An instance is shared only once its start-up has finished inside
 * the request that built it: Workers never lets one request wait on a promise
 * that belongs to another, so sharing a half-started instance would leave
 * every later request on it hanging.
 */
export async function getAuth(env: Env, db: D1Database, origin: string, methods: LoginMethods): Promise<PlatformAuth> {
  const key = `${origin}|${JSON.stringify(methods)}`;
  const cached = instances.get(key);
  if (cached) return cached;
  const auth = buildAuth(env, db, origin, methods);
  await auth.$context;
  if (instances.size > 16) instances.clear();
  instances.set(key, auth);
  return auth;
}

/** Test hook: bindings differ between test runs. */
export function resetAuthInstances(): void {
  instances.clear();
}
