// The original app's users, kept in KV (auth:user:<id>), read for the
// original sign-in (originalSignIn.ts) and for bringing its people into an
// organization (originalApp.ts).

import type { Env } from '../workerEnv';

export interface LegacyUser {
  id: string;
  name?: string;
  email?: string;
  role?: string;
  /** The original app stores its PBKDF2 hash here. */
  hashedPassword?: string;
  password?: string;
  passwordHash?: string;
}

/** The stored password hash of an original-app user, whichever field holds it. */
export function legacyPasswordHash(user: LegacyUser): string | undefined {
  return user.hashedPassword || user.password || user.passwordHash || undefined;
}

export async function readLegacyUsers(env: Env): Promise<LegacyUser[]> {
  const users: LegacyUser[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.VAYU_KV.list({ prefix: 'auth:user:', cursor }); // NOSONAR: each page needs the previous page's cursor
    for (const raw of await Promise.all(page.keys.map(key => env.VAYU_KV.get(key.name)))) { // NOSONAR: one page at a time
      if (!raw) continue;
      try { users.push(JSON.parse(raw) as LegacyUser); } catch { /* skip unreadable */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return users;
}
