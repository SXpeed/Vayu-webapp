# Implementation plan — what to build next

Written 2026-09-30. The order of work, from now onwards. `PENDING.md` keeps
the full history and notes per area; this file is the queue. Tick items off
here as they ship.

Sources: the architecture review of 2026-09-30, a SaaS gap check against
`PENDING.md`, and the Vayu sign-in question.

---

## Done since this plan was written

| What | Where |
|---|---|
| Email change: yourself (app and control centre Profile, confirmed by links to both addresses) and by a provider admin (Accounts) | `platform/accountEmail.ts`, `docs/PLATFORM_AUTH.md` |
| Close the original sign-in from the control centre (Step 2's missing piece) | `platform/originalSignIn.ts`, `docs/APP_ORGANIZATIONS.md` |
| Security: a support admin could reset an owner's password or disable them; other admins' accounts are now owner-only | `platform/accountEmail.ts` (`guardAccountTarget`) |
| Bug: accounts brought in from the original app (ids like `user_1700…`) could not be opened in the control centre | `platform/centerRoutes.ts` |
| Security: pdf.js 5 ran scripts from malicious PDFs (GHSA-hq66-cqwq-w95j); now 6.3.289; DOMPurify updated | `frontend/package.json` |
| A flaky webhook-health verdict when two signals landed in the same millisecond | `platform/webhookHealth.ts` |
| CI: secret scan, dependency audit, type-check and all tests before any deploy | `.github/workflows/deploy.yml` |
| Staff roster: date bar no longer floats on phones; one-tap Assign (who is free, fewest hours first); drag and drop on desktop; copy last week; CSV import beside the export; time presets | `views/staffRoster/` |
| Skeleton loading instead of spinners (roster, sales, attendance, activity log, lazy screens); new screens must have one | `components/Skeleton.tsx` |
| Artwork page redesigned: minimal, type-led | `views/ArtworkDetailView.tsx` |

## Step 1 — Now (small, low risk, a day or two)

| # | Item | Why | Where |
|---|---|---|---|
| 1.1 | ✅ Run the tests in CI before deploying | Today CI typechecks, builds and deploys; a broken change goes straight to production | `.github/workflows/deploy.yml` |
| 1.2 | ✅ Stop test files colliding on local ports (done with free ports and a start-up retry; moving logic tests in-process stays under Step 5) | 17 files each start a local API; they break when two use the same port | `frontend/tests/` |
| 1.3 | ⏸ Turn `SHARED_RAZORPAY_ALLOW_TEST` off — waits for live keys on the shared account (owner) | Temporary since 2026-09-30 | Worker vars |
| 1.4 | ⏸ Remove the Showcase erase hook, once every workspace has been opened since — owner to confirm | Temporary | `frontend/worker.ts` |
| 1.5 | ✅ Switch to close the original sign-in (see "Vayu: Stage A") | Needed for email-only sign-in | `worker.ts` `/api/auth/login`, `views/LoginView.tsx` fallback |
| 1.6 | ✅ Turnstile on sign-up and "Forgot password?" (applications need a signed-in, confirmed account already; there is no contact form yet). Owner: create the widget and set the keys (`docs/PLATFORM_AUTH.md`) | Public sign-up is open to spam and email abuse | `frontend/signup`, `platform/applications.ts` |
| 1.7 | ✅ Cron-failure alerts by email and in System health. Owner: set the provider notification address, and a Cloudflare Notification for Worker errors | Today a failure is noticed only when a customer reports it | Workers observability / Analytics Engine |
| 1.8 | ✅ gitleaks and `npm audit` in CI (the audit found a high pdf.js issue: upgraded to 6.3.289) | Dependency and secret scanning | `.github/workflows/` |
| 1.9 | ✅ Repo tidying: `cloudflared.exe`, `*.log` and `.wrangler/` were already ignored; stale `frontend/.wrangler/tmp` folders still listed for the owner's OK | Easy to commit by accident | repo root |
| 1.10 | ✅ Correct `docs/architecture-simulation.html` (the seven items at the end, plus the OrgAppDb card). `PENDING.md` is superseded by this plan for ordering | Both are behind the code | `docs/` |

## Step 2 — Vayu on email sign-in only (Stage A)

Vayu's staff sign in with the original app's own accounts (KV
`auth:user:*`, `auth:email:*`). The goal is platform accounts only (Better
Auth: email and password, Google, two-factor, Forgot password). Data stays in
`VAYU_DB`; nothing is moved.

- [ ] **Raise Vayu's member limit first.** An organization with no plan gets
      3 members (`DEFAULT_LIMITS`). Give Vayu Design a plan or a `maxMembers`
      override covering all staff.
- [ ] Control centre → Organizations → Vayu Design → **App data** → *Use the
      original app's data* (type its address name to confirm).
- [ ] **Bring in the original app's people**: dry run, read the report (it
      flags anyone without a stored password), then for real. Same ids, same
      passwords, custom roles kept. Safe to repeat.
- [ ] Staff sign in as usual; the form tries the platform account first.
      Watch Accounts in the control centre until everyone has signed in once.
- [x] **Built: close the original sign-in** (1.5): control centre → Login &
      security → Original app sign-in. It lists who still has no email
      account, refuses to close before an organization owns the data, and
      reopens without losing anything. Anyone without a password uses
      "Forgot password?" (needs email working).
- [ ] Owner: once everyone has signed in with their email account, close it.
- [ ] 2026-11-30: the old bearer fallback ends (`LEGACY_BEARER_UNTIL`); delete it.

## Step 3 — Safety net before moving any data

| # | Item | Notes |
|---|---|---|
| 3.1 | Nightly backup of every organization's database to R2 | Independent of Cloudflare's own recovery; R2 and the cron already exist |
| 3.2 | Tested restore procedure and a written retention policy | Rehearse once on staging |
| 3.3 | Per-organization data export (download everything) | Also needed for 3.4 |
| 3.4 | Organization closure, scheduled deletion; a person deleting their own account | Privacy law (DPDP, GDPR) |
| 3.5 | Support access: "enter organization" with re-authentication, a reason, short expiry, read-only by default, a banner, every action audited | The `support` role exists but is "same as admin today" |
| 3.6 | Staging environment; run sign-up → approval → workspace there | Nothing has run end to end outside local |

## Step 4 — Vayu's data into its own database (Stage B)

**Not built.** `platform/legacyImport.ts` writes into OrgStore, which the app
never reads, so it cannot be used. Needs a new copy tool into `OrgAppDb`:

| What | From → to | Notes |
|---|---|---|
| Database: `schema.sql` tables plus sales and staff roster tables (about 20) | `VAYU_DB` → Vayu's `OrgAppDb` | Keep ids and the change-log order; compare row counts per table |
| Settings, payment links, push subscriptions, custom roles | KV unprefixed → `org:<id>:` | Old sessions and the device registry are not copied |
| Photos and files | R2 `uploads/…` → `orgs/<id>/uploads/…` | Stored addresses `/api/files/…` are rewritten to `/api/o/<id>/files/…`, or the old ones redirect |
| Live updates | original hub → `org-<id>` | Automatic when the storage flips |

Switch-over, in a quiet window:
1. Every device sends its unsent sales and changes (outbox empty).
2. Stop writes; note a D1 Time Travel bookmark.
3. Copy tool: dry run, then real; compare counts.
4. Flip Vayu to `app_storage = 'own'`.
5. Devices reload their offline copy in full (their sync cursor belonged to the old database).

Rollback: flip back to `original`. The old data is never modified, but
anything written after the flip would be lost, so decide within the window.

After a few stable weeks, with the owner's OK:
- [ ] Remove the original sign-in, KV sessions, device registry, `LEGACY_*` switches (about 1,600 lines)
- [ ] Remove the `VAYU_DB` binding and the KV user lists (also fixes the 1,000-user list limit)

## Step 5 — Cleanup and simplification

- [ ] Delete OrgStore, `orgApi.ts`, `orgSchema.ts`, `/api/v2/org/*` and the
      old-data import (about 900 lines; needs a Durable Object deletion migration)
- [ ] Remove the always-on switches `DELTA_SYNC_ENABLED`, `REALTIME_ENABLED`,
      `FILE_AUTH` and their "off" branches (about 30 checks)
- [ ] Load background removal on demand (23 MB of the 30 MB build); stop
      bundling four libraries twice for the PDF worker
- [ ] Offline copy from localStorage (about 5 MB cap, freezes while saving) to
      IndexedDB (`localforage` is already installed)
- [ ] Move payment links, refunds and push subscriptions from KV into each
      organization's database (same transaction as the change log)
- [ ] Split `worker.ts` (5,482 lines) into feature modules: artworks, messaging,
      payments, attendance, rooms, invoices. Merge 4 constant-time compares,
      6 HMAC set-ups, 3 money formatters, 5 client fetch wrappers
- [ ] One set of colour and spacing tokens and one component kit for the app
      and the control centre
- [ ] Merge `HANDOFF.md`, `CHANGES.md`, `IMPROVEMENTS.txt` into `docs/`
- [ ] Optional: serve the three sites from the API Worker (one deploy, not four)

## Step 6 — SaaS features

**Billing**
- [ ] Automatic renewal (Razorpay Subscriptions / e-mandate), reminder emails, failed-payment follow-up
- [ ] GST invoices for plan payments; proration on plan change; refunds from the control centre
- [ ] Apply stored payment webhooks to business records; mark the linked invoice paid per organization

**Making it theirs**
- [ ] Per-organization branding (name, logo, accent) on the app, catalogs, invoices, PDFs and viewing rooms
- [ ] Enforce the remaining plan limits: storage, monthly PDFs/invoices/inquiries,
      collections, catalogs, stores, customer records, private rooms, feature flags, history retention
- [ ] Usage counters, and usage and cost per organization in the control centre
- [ ] Custom roles where the plan allows; store-level access per member
- [ ] Optional logo upload during onboarding

**Per-organization infrastructure**
- [ ] Realtime hub, push and email recipients per organization; reconnect recovery, multi-tab coordination
- [ ] Per-organization file namespace and ownership records; purge previously public cached copies
- [ ] Push subscriptions removed when someone signs out of a workspace
- [ ] Private-room members removed lose downloaded messages without a full refresh

**Growth**
- [ ] Demo organizations (studio and gallery), environment-gated
- [ ] Onboarding checklist in the app; contact form on the website
- [ ] Later: public API and outbound webhooks, status page, help site

## Step 7 — Security and verification

- [ ] `workers_dev: false`, so the workers.dev address can't bypass zone rules
- [ ] Cloudflare Access in front of `/admin`
- [ ] Script-src content security policy (test with the PDF and background-removal libraries)
- [ ] Rate limits on expensive organization endpoints
- [ ] Load tests with adjustable organization and user counts
- [ ] Cross-organization isolation re-checked on staging with real data volumes
- [ ] Production smoke test after each deploy

## Waiting on the owner

- [ ] Real privacy policy, terms, About text, contact email and address
- [ ] Plan names and prices; publish the paid plans
- [ ] Connect and verify the platform Razorpay account and its webhook
- [ ] Google OAuth client id and secret
- [ ] Email Service DNS for ateliersupport.com (SPF/DKIM) and DMARC
- [ ] Cloudflare dashboard: two-factor on the account, Bot Fight Mode, WAF rules, a billing alert
- [ ] Staff: reinstall the home-screen app at `app.ateliersupport.com`
- [ ] Go-ahead for each deploy and each deletion

---

## Corrections for `architecture-simulation.html`

1. Unknown U1 is out of date: organizations with their own storage keep every
   table in their `OrgAppDb`; only Vayu uses the shared `VAYU_DB`.
2. OrgStore is not in the request path; the checks its card describes happen in front of `OrgAppDb`.
3. The offline copy is in localStorage, not IndexedDB.
4. Payment links live in KV, so scenario B ends with a list refetch, not a sync pull.
5. `API_LIMITER` counts per device, not per workspace.
6. Unknown or non-member organizations answer 401 signed out and 404 signed in, not 403.
7. The original sign-in has used a cookie with CSRF checks since 2026-09-30.
