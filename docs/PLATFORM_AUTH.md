# Platform auth and the provider control panel

First slice of the ateliersupport SaaS platform (Phase B). It adds a separate
identity layer and a provider-only control panel **alongside** the existing app.
The current app, its `/api/*` routes and its KV sessions are unchanged; moving
the app's users onto this layer is a later, explicit migration step.

| Piece | Where |
|---|---|
| Platform API (`/api/v2/*`) | `frontend/platform/routes.ts`, wired first in `frontend/worker.ts` |
| Better Auth config | `frontend/platform/auth.ts` |
| Login-method switches | `frontend/platform/settings.ts` |
| Platform DB schema | `frontend/platform/migrations/0001_platform_auth.sql` |
| Control panel UI | `frontend/admin.html`, `frontend/admin/` (served at `/admin`) |
| First-admin script | `frontend/scripts/create-provider-admin.mjs` |
| Tests | `frontend/tests/platformAuth.integration.test.mjs` |

## What works

- **Email + password sign-in** (local accounts) through Better Auth 1.7.5, with
  HttpOnly `SameSite=Lax` session cookies (`Secure` on HTTPS), 14-day sessions,
  and Origin checks on every state-changing request.
- **Passwords migrated from the original app** (PBKDF2 `salt.hash`) verify as-is,
  so nobody has to reset. New passwords use Better Auth's scrypt.
- **Rate limits** on sign-in (5/min per IP), sign-up and 2FA endpoints, stored in
  D1 so every Worker isolate sees the same counters.
- **Provider control panel** at `/admin`. Every admin API call checks, on the
  server: a valid session, an active `provider_admins` row, and 2FA enabled.
  Optional `ADMIN_HOST` restricts the admin API to one host.
- **Mandatory TOTP 2FA** for provider admins, with backup codes.
- **Login-method switches** in the panel: email sign-in, email sign-up, Google
  sign-in, Google sign-up. Changing them needs a sign-in less than 30 minutes old
  and is written to the audit log with before/after values.
- **Google sign-in, built but off.** It stays unavailable until the credentials are
  set *and* an admin switches it on.
- **Append-only platform audit log.** The database refuses updates, and refuses
  deletes of rows younger than 365 days.

### Lockout guards

The panel refuses any change that would lock people out:

- At least one sign-in method must stay on.
- Google can't be switched on without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Email and password sign-in can't be turned off unless the admin making the
  change has a Google account linked (the button appears in the panel).
- Sign-up for a method needs sign-in for that method.

## Local development

```bash
cd frontend
cp .dev.vars.example .dev.vars          # then fill in BETTER_AUTH_SECRET
npx wrangler d1 migrations apply PLATFORM_DB --local -c wrangler.json
ADMIN_PASSWORD='choose-a-password' node scripts/create-provider-admin.mjs \
  --email you@example.com --name "Your Name"
npm run build
npx wrangler dev -c wrangler.json --local \
  --var AUTH_ORIGINS:http://127.0.0.1:8787 --var PLATFORM_ENV:development
# open http://127.0.0.1:8787/admin
```

`frontend/wrangler.json` is for local development and tests only: its
`PLATFORM_DB` id is a placeholder. The production config (root `wrangler.jsonc`)
has **no** `PLATFORM_DB` yet, so in production `/api/v2/*` answers 503 and
nothing else changes.

The Vite dev server (`npm run dev`) proxies `/api` to the deployed Worker, so
`/api/v2` there hits production (503). Set `VITE_API_PROXY` to a local worker to
use the panel through Vite.

## Enabling it in an environment (staging first, then production)

Each step needs your approval when it's run, because it creates or changes
Cloudflare resources.

1. Create the platform database:
   `npx wrangler d1 create ateliersupport-platform-staging` (and `-production`).
2. Add a `PLATFORM_DB` binding with that id and
   `"migrations_dir": "frontend/platform/migrations"` to that environment's
   wrangler config.
3. Apply migrations: `npx wrangler d1 migrations apply PLATFORM_DB --remote`.
4. Set secrets, a different value per environment:
   `npx wrangler secret put BETTER_AUTH_SECRET`.
5. Set vars: `AUTH_ORIGINS` (for example
   `https://app.ateliersupport.com,https://admin.ateliersupport.com`) and
   `ADMIN_HOST` (for example `admin.ateliersupport.com`).
6. Create the first admin with the script, using `--remote --database <name>
   --config <config> --confirm-remote`.
7. Sign in at `/admin` and set up 2FA.

## Enabling Google sign-in (when you have the client ID)

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client
   ID** → type **Web application**.
2. **Authorized redirect URIs:** copy the exact URI the control panel shows under
   *Login methods*, one per host, for example
   `https://admin.ateliersupport.com/api/v2/auth/callback/google`.
3. Configure the OAuth consent screen (app name, support email, privacy policy
   link). A public app needs Google's verification.
4. Store the credentials as Worker secrets. They never go in the frontend build:
   `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
5. In the control panel, switch **Google sign-in** on. Then have each admin click
   **Link my Google account** while signed in.

How Google identities are handled:

- A Google identity is **never** linked to an existing account because the email
  matches (`disableImplicitLinking`). It links only when the person is already
  signed in and clicks link.
- **Google sign-up** is a separate switch. With it off, Google sign-in works only
  for accounts that already linked Google.
- Signing in with Google proves who someone is. It does not grant access to any
  organization; membership is checked separately.
- Google login doesn't make an account secure by itself. Provider admins still
  need 2FA.

## Secrets

- `BETTER_AUTH_SECRET` signs and encrypts sessions and 2FA secrets. Use at least
  32 random bytes, a different value in each environment, set with
  `wrangler secret put` and never committed. Rotating it signs everyone out.
- `GOOGLE_CLIENT_SECRET` is server-only.
- `.dev.vars` is git-ignored; `.dev.vars.example` documents the keys.

## Not done yet (later phases)

- Moving the current app's users and sessions onto this layer (Phase B, next).
- Verification and reset emails (Phase F). Until then, keep public sign-up off.
- Organizations, memberships, invitations, plans, support sessions (Phases B–E).
