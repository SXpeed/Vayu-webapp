# Vayu Design for Living

Mobile-first PWA for Vayu Design: artworks, collections, catalogs, invoices,
inquiries, team messaging and attendance. Live at https://ateliersupport.com.

## Stack

- **Frontend:** React 19 + Vite + Tailwind v4 (`frontend/`)
- **Backend:** one Cloudflare Worker (`frontend/worker.ts`) serving the API and
  the built frontend, with D1 (data), KV (sessions), R2 (files) and a
  `SyncHub` Durable Object for realtime.

## Develop

```bash
npm install && npm install --prefix frontend
npm run dev          # Vite dev server; /api proxies to the deployed Worker
npm run dev-phone    # same, over HTTPS on the LAN (install the PWA on a phone)
```

Set `VITE_API_PROXY=http://127.0.0.1:8787` in `frontend/.env` to use a local
`wrangler dev` Worker instead of production.

Checks (from `frontend/`): `npm run typecheck`, `npm test`.

## Deploy

Pushing to `main` deploys production (GitHub Actions →
`.github/workflows/deploy.yml`). Manual: `npm run deploy` from the repo root
(uses the root `wrangler.jsonc`).

## Docs

- `docs/ARCHITECTURE.md`: sync and realtime design
- `docs/DEPLOYMENT.md`: feature flags, rollout, rollback, measurement
- `IMPROVEMENTS.txt`: open TODO list
