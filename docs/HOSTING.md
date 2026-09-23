# Hosting: four Workers, one per address

| Address | Worker | Code and config | Serves |
|---|---|---|---|
| `ateliersupport.com` (+ `www`, redirected) | `ateliersupport-welcome` | `frontend/hosts/welcome/` | Landing page at `/`, `/signup`, `/legal` |
| `app.ateliersupport.com` | `ateliersupport-app` | `frontend/hosts/app/` | The organization app (PWA) |
| `admin.ateliersupport.com` | `ateliersupport-admin` | `frontend/hosts/admin/` | The provider control centre, at `/` |
| `api.ateliersupport.com` | `vayu-webapp` | `wrangler.jsonc`, `frontend/worker.ts` | The API: all databases, files, sync, sign-in |

Each site Worker has its own build (`dist/app`, `dist/admin`, `dist/welcome`)
and none of them ships another's pages.

## How a request reaches the API

Every site keeps a same-address `/api` path. Its Worker hands those requests to
`vayu-webapp` over a **service binding** (`API`), unchanged: same URL, cookies,
headers and WebSocket upgrade. That is deliberate:

- Saved data links files as `/api/files/...`; those links keep working on
  every address.
- Sign-in cookies stay on the page's own address, with no cross-site cookie or
  CORS setup.
- The API still sees which address a call came from, so `AUTH_ORIGINS`,
  `ADMIN_HOST` (control-centre calls only from `admin.`) and the realtime
  Origin check work as before.

What each address passes on:

| Address | `/api/v2/*` (platform) | `/api/*` (the app's original API) |
|---|---|---|
| `app.` | yes | yes |
| `admin.` | yes | no, 404 |
| `ateliersupport.com` | yes | yes, **for now**: a copy of the app still open there can finish saving. Remove later (docs/PENDING.md) |

`api.ateliersupport.com` answers directly, for callers outside the browser.
Point Razorpay webhooks at
`https://api.ateliersupport.com/api/v2/webhooks/razorpay/<orgId>`.

## Why the API keeps the name `vayu-webapp`

The organization databases (the `OrgStore` and `SyncHub` Durable Objects) and
every secret (`BETTER_AUTH_SECRET`, `PAYMENT_SECRETS_KEY`, `REALTIME_SECRET`,
Razorpay, Calendarific) belong to the Worker's name. A new name would start
with none of them.

## Old addresses

- `ateliersupport.com`: anything that is not a website page (old bookmarks,
  deep links) is sent to `app.ateliersupport.com`. `/admin` goes to
  `admin.ateliersupport.com`. Its `/sw.js` retires the app's old service
  worker, so browsers stop showing a cached copy of the app there.
- `app.ateliersupport.com/admin`, `/welcome`, `/signup`, `/legal` go to their
  own addresses.
- `admin.ateliersupport.com/admin` goes to `/` (the `#section` survives).
- The old `vayu-webapp.<account>.workers.dev` address: opening a page there
  goes to `app.ateliersupport.com`; the API still answers there.

## Build and deploy

```bash
npm run build          # frontend/scripts/build-sites.mjs → dist/app, dist/admin, dist/welcome
npm run deploy         # build, then the three sites, then the API
```

Or one at a time: `npm run deploy:app`, `deploy:admin`, `deploy:welcome`,
`deploy:api` (from the repo root). CI (`.github/workflows/deploy.yml`) runs
the same order.

**The order matters.** A deploy removes any custom domain its config no longer
lists. The sites go first, so no address is ever left without a Worker.

Version skew: the four deploy one after another, so for about a minute a new
page can meet the old API. Keep API changes backward compatible, or deploy the
API first by hand when a page needs a new endpoint.

## First switch-over (one time)

Today `vayu-webapp` holds all four addresses and serves every page.

1. **Tell staff first.** Browser storage is per address, so anyone still using
   the app on `ateliersupport.com` will:
   - need to sign in again at `app.ateliersupport.com`;
   - find the home-screen icon opens the website, so they reinstall from `app.`;
   - keep **any change made offline and not yet uploaded** in that address's
     storage. Ask them to open the app there once while online, before the
     switch, so everything uploads.
2. `npm run build`
3. `npm run deploy:sites`: the three site Workers take `ateliersupport.com`,
   `www`, `app.` and `admin.` over from `vayu-webapp` (unattended wrangler
   moves an existing custom domain without asking).
4. `npm run deploy:api`: `vayu-webapp` keeps only `api.ateliersupport.com`
   (created by this deploy) and its workers.dev address.
5. Check (allow a minute for the edge):

   ```bash
   curl -sI https://ateliersupport.com/            # 200, the landing page
   curl -sI https://www.ateliersupport.com/signup  # 301 → https://ateliersupport.com/signup
   curl -sI -H 'Sec-Fetch-Mode: navigate' https://ateliersupport.com/artworks  # 302 → app.
   curl -sI https://app.ateliersupport.com/        # 200, the app
   curl -sI https://app.ateliersupport.com/admin   # 302 → admin.
   curl -sI https://admin.ateliersupport.com/      # 200, the control centre
   curl -s  https://app.ateliersupport.com/api/artworks     # {"error":"Unauthorized"} from the API
   curl -s  https://admin.ateliersupport.com/api/artworks   # {"error":"Not found"}
   curl -s  https://api.ateliersupport.com/api/artworks     # {"error":"Unauthorized"} from the API
   ```

   Then sign in on `app.` and `admin.`, open a conversation (realtime runs
   through the binding), and open an uploaded image.

### Rollback

Check out the commit before the split and deploy it (`npm run deploy` there
runs the old single `wrangler deploy`). `vayu-webapp` takes all four
addresses back. Then delete the `ateliersupport-app`, `-admin` and `-welcome`
Workers in the dashboard; their data lives in `vayu-webapp` anyway.

## Local development

`npm run dev` is unchanged: one Vite dev server with every page (the landing
page is at `/welcome` there, the control centre at `/admin.html`).

To run the real Workers: start the API (`npm run dev:worker` in `frontend/`),
then `npx wrangler dev -c frontend/hosts/<site>/wrangler.jsonc --port <n>`
from the repo root; the `API` binding connects to the local API
automatically. Local `wrangler dev` rewrites every request's host to the
config's first route, so host-based behaviour (the `www` redirect) is covered
by `frontend/tests/hosts.test.mjs` instead.
