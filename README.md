# Vayu Design for Living

Mobile-first PWA for Vayu Design: artworks, collections, catalogs, invoices,
inquiries, team messaging and attendance. The app is at https://app.ateliersupport.com, the
website at https://ateliersupport.com, the control centre at https://admin.ateliersupport.com.

## Stack

- **Frontend:** React 19 + Vite + Tailwind v4 (`frontend/`)
- **Backend:** the API Worker (`frontend/worker.ts`, `api.ateliersupport.com`)
  with D1 (data), KV (sessions), R2 (files) and Durable Objects for realtime
  and per-organization databases.
- **Hosting:** one Worker per address (website, app, control centre, API);
  the three sites reach the API at `/api` over a service binding. See
  `docs/HOSTING.md`.

## Develop

```bash
npm install && npm install --prefix frontend
npm run dev          # Vite dev server; /api proxies to the deployed Worker
npm run dev-phone    # same, over HTTPS on the LAN (install the PWA on a phone)
```

Set `VITE_API_PROXY=http://127.0.0.1:8787` in `frontend/.env` to use a local
`wrangler dev` Worker instead of production.

### Local test copy

```bash
npm run dev:local             # a private copy of the app with its own database
npm run dev:local -- --reset  # wipe it and start fresh
```

Opens on http://localhost:5173 (control centre: `/admin.html`) with test
logins `admin@test.local` / `localtest-admin` and `staff@test.local` /
`localtest-staff`, plus three sample artworks. The data lives in
`frontend/.wrangler/local-test` (git-ignored) and never reaches the live site.
Plain `npm run dev` still talks to the live site.

Checks (from `frontend/`): `npm run typecheck`, `npm test`.

## Deploy

Pushing to `main` deploys production (GitHub Actions →
`.github/workflows/deploy.yml`). Manual: `npm run deploy` from the repo root
builds the three sites, deploys them, then the API. The order matters; see
`docs/HOSTING.md`.

## Docs

- `docs/HOSTING.md`: which Worker serves which address, deploy order, the one-time switch-over
- `docs/ARCHITECTURE.md`: sync and realtime design
- `docs/DEPLOYMENT.md`: feature flags, rollout, rollback, measurement
- `docs/PLATFORM_AUTH.md`: platform login (Better Auth), provider control panel, enabling Google
- `docs/ORGANIZATIONS.md`: organizations, members, and each organization's own Razorpay account
- `docs/ORG_DATABASES.md`: one database per organization, the request pipeline, concurrent edits
- `docs/VAYU_MIGRATION.md`: moving the current business in as the first organization
- `docs/PLANS.md`: plans, versions, limits, subscriptions and overrides
- `docs/ONBOARDING.md`: the public website, sign-up and approval flow, and the control centre
- `docs/PENDING.md`: everything still to build, and what is waiting on a decision
- `IMPROVEMENTS.txt`: open TODO list
