#!/usr/bin/env node
// Creates (or re-activates) a provider administrator in the platform database.
//
// Public sign-up is off by default, so the first admin is created here. The
// password comes from the ADMIN_PASSWORD environment variable, never argv, so
// it stays out of shell history and process lists.
//
// Local (default):
//   ADMIN_PASSWORD='...' node scripts/create-provider-admin.mjs \
//     --email you@example.com --name "Your Name" [--persist-to <dir>]
//
// Remote (staging/production) needs both flags, and a wrangler login with
// access to that account:
//   ... --remote --database <database-name> --config <wrangler config> --confirm-remote
//
// If the email already exists, the password is left alone and the user is
// (re)granted provider-admin status. The admin sets up 2FA on first sign-in.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { hashPassword } from 'better-auth/crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(`--${name}`);

const email = (arg('email') ?? '').trim().toLowerCase();
const name = (arg('name') ?? '').trim();
const role = arg('role', 'owner');
const remote = flag('remote');
const database = arg('database', 'PLATFORM_DB');
const config = arg('config', 'wrangler.json');
const persistTo = arg('persist-to');
const password = process.env.ADMIN_PASSWORD ?? '';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die('--email is required and must be an email address');
if (!name) die('--name is required');
if (!['owner', 'admin', 'support'].includes(role)) die('--role must be owner, admin or support');
if (password.length < 10) die('set ADMIN_PASSWORD (at least 10 characters)');
if (remote && !flag('confirm-remote')) die('writing to a remote database needs --confirm-remote');

const q = (v) => (v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const now = Date.now();
const iso = new Date(now).toISOString();
const userId = crypto.randomUUID();
const hash = await hashPassword(password);

// INSERT OR IGNORE on the unique email keeps an existing user (and password)
// untouched; everything after looks the user up by email.
const sql = `
INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled)
  VALUES (${q(userId)}, ${q(name)}, ${q(email)}, 1, ${q(iso)}, ${q(iso)}, 0);
INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
  SELECT ${q(crypto.randomUUID())}, u.id, 'credential', u.id, ${q(hash)}, ${q(iso)}, ${q(iso)}
  FROM "user" u WHERE u.email = ${q(email)}
    AND NOT EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'credential');
INSERT INTO provider_admins (user_id, role, status, created_at, created_by)
  SELECT u.id, ${q(role)}, 'active', ${now}, 'bootstrap-script' FROM "user" u WHERE u.email = ${q(email)}
  ON CONFLICT(user_id) DO UPDATE SET status = 'active', role = excluded.role;
INSERT INTO platform_audit (id, at, actor_user_id, actor_kind, action, target_type, target_id, details)
  SELECT ${q(crypto.randomUUID())}, ${now}, NULL, 'system', 'provider_admin.bootstrap', 'user', u.id,
         ${q(JSON.stringify({ email, role }))}
  FROM "user" u WHERE u.email = ${q(email)};
`;

const dir = mkdtempSync(join(tmpdir(), 'as-admin-'));
const file = join(dir, 'bootstrap.sql');
writeFileSync(file, sql);
try {
  const args = ['d1', 'execute', database, '-c', config, '--file', file, remote ? '--remote' : '--local'];
  if (!remote && persistTo) args.push('--persist-to', persistTo);
  if (remote) args.push('-y');
  // Run wrangler's own entry with this Node, no shell: nothing is re-parsed.
  const pkg = createRequire(import.meta.url).resolve('wrangler/package.json');
  const wrangler = join(dirname(pkg), 'bin', 'wrangler.js');
  execFileSync(process.execPath, [wrangler, ...args], { stdio: 'inherit' });
  console.log(`\nProvider admin ready: ${email} (${role}). Sign in at /admin and set up 2FA.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
