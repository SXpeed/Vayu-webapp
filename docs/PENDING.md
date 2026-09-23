# Pending work — ateliersupport SaaS

Everything still to do, and everything waiting on a decision. Updated
2026-09-23.

**Done so far** (all local commits; see the per-area docs):

| Built | Commit | Doc |
|---|---|---|
| Rename to ateliersupport | `8c87d41` | — |
| Platform login + provider control panel | `d4b73a9` | `PLATFORM_AUTH.md` |
| app.ateliersupport.com (live) + moved notice (off) | `9ae4325` | — |
| Organizations, members, per-organization Razorpay | `6300ab5` | `ORGANIZATIONS.md` |
| One database per organization | `0dcb803` | `ORG_DATABASES.md` |
| Business tables + import of the current app | `846eee0` | `VAYU_MIGRATION.md` |
| Plan engine, limits, branding from the panel | `2513a57`, `f7cbfe6` | `PLANS.md` |
| Landing page, sign-up and application flow, redesigned control centre | `9f4ce8c` | `ONBOARDING.md` |

**Live in production:** only the rename, the cleanup and the new app address.
Everything else is committed locally and dormant in production, because the
platform database does not exist there yet.

---

## 1. Waiting on the owner

| # | Needed | Blocks | Notes |
|---|---|---|---|
| 1.1 | **Email provider decision** (Resend recommended, or wait for Cloudflare's, or stay invite-only) | Public sign-up, invitations, password resets, approval notices | Free tier covers early use. Invite-only works meanwhile. |
| 1.2 | **Go-ahead to create production/staging resources** (platform database, secrets) | Everything platform-related going live | See §2 |
| 1.3 | **Marketing content**: business description, contact email and address, whether privacy policy and terms exist | Marketing site | No legal text, testimonials or security claims will be invented |
| 1.4 | **Plan line-up**: names, prices, what each includes | Public pricing | Or say the word and a starter set is created as drafts to edit |
| 1.5 | **Logo file** (or upload it in the panel once live) | Provider branding | Panel upload is built |
| 1.6 | **Google OAuth client id and secret** | Google sign-in | Code is built and switched off |
| 1.7 | **Razorpay keys per organization** | Organizations collecting customer payments | Panel screen is built |
| 1.8 | ~~Confirmation staff have moved to app.ateliersupport.com~~ | — | Superseded: the owner chose to switch `ateliersupport.com` to the website straight away (hosting split, §2b) |

## 2. Production enablement (needs approval, then one session)

- [ ] Create D1 databases: `ateliersupport-platform-staging`, `…-production`
- [ ] Add the `PLATFORM_DB` binding to the deploy config
- [ ] Apply platform migrations (`0001`–`0005`)
- [ ] Set secrets per environment: `BETTER_AUTH_SECRET` (generated, with the
      owner), `PAYMENT_SECRETS_KEY`
- [ ] Set vars: `AUTH_ORIGINS`, `ADMIN_HOST`
- [ ] Create the first provider admin and set up 2FA
- [ ] Point `admin.ateliersupport.com` at the Worker
- [ ] Separate staging resources so testing never touches production data

## 2b. Hosting split — live since 2026-09-23

One Worker per address (`docs/HOSTING.md`): website, app, control centre, and
the API (`vayu-webapp`, now on `api.ateliersupport.com`). Deployed by CI
(`2dfd767`, `7b8dc3d`) after a dashboard Workers Route on the bare domain,
which blocked the website Worker, was removed. All live checks passed.

- [x] First switch-over: sites, then the API, then the checks in `docs/HOSTING.md`
- [ ] Staff: sign in again and reinstall the home-screen app at `app.`
- [ ] Sign in on `app.` and `admin.`, open a conversation (realtime through the
      binding) and an uploaded image, as a final hands-on check
- [ ] Point the Razorpay webhook at `api.ateliersupport.com` when it is set up
- [ ] A few weeks after: stop passing the app's original `/api` on
      `ateliersupport.com` (`frontend/hosts/welcome/worker.ts`)

## 2c. Private rooms — built (staff chat rooms and client viewing rooms)

**Part 2, private viewing rooms** (`frontend/viewingRooms.ts`, staff screen
Catalogs → Private rooms, client page `app.ateliersupport.com/room/<secret>`):
staff pick works for one client and send a secret link with a 6-digit
passcode and an expiry (7/14/30/90 days); prices shown or "Price on request"
per room. The client views the works and "I'm interested" creates an inquiry
(source "Private room") and notifies staff. Passcodes are hashed and shown
only when made; guesses are rate limited; photos load only through the room
with a short-lived pass (so they keep working once FILE_AUTH is on). Tests:
`tests/viewingRooms.integration.test.mjs`.

**Part 1, closed staff chat rooms:**

`frontend/privateRooms.ts`. A private room is a group only its members can see,
even admins: not listed, not readable, not in sync, the live hub, receipts or
the deleted-items archive. Admins create them (New chat → New Group → Private
room); the creator, or an admin in the room, renames, changes members or
deletes. Tests: `tests/privateRooms.integration.test.mjs`.

- [ ] Viewing rooms show the platform's look, not the organization's branding (§3.9)
- [ ] The plan's "Private rooms" limit and switch are not checked yet (the main
      app is not on plans until §3.1)
- [ ] Someone removed from a room keeps its already-downloaded messages on
      their device until the app's next full refresh (true of groups too)

## 3. Pending implementation

### 3.1 The app on the new foundation (biggest remaining piece)
- [ ] Point the app's screens at `/api/v2/org/:id/*` instead of the shared database
- [ ] Organization switcher for people who belong to more than one
- [ ] Move the app's own sign-in onto platform login (keeping current sessions working during the change)
- [ ] Offline storage keyed per person **and** organization, cleared on switch and sign-out
- [ ] Run Vayu's real import immediately before this switch, so nothing written in between is missed

### 3.2 Marketing website (Phase C) — built, content pending
- [x] Home, What it does, Features, How it works, Pricing, About, Contact, Login, Get started (`/welcome`)
- [x] Pricing fed from published public plans
- [x] Privacy policy and terms pages (`/legal`) — **placeholders until real text arrives** (§1.3)
- [ ] Real About text, contact email and address (§1.3), in `frontend/site/content.ts`
- [x] Make the landing page the root of `ateliersupport.com` (hosting split, §2b)
- [ ] Bot protection on sign-up and contact (Turnstile)
- [ ] A contact form (today the Contact section shows the address and email only)

### 3.3 Sign-up and approval flow (Phase C) — built
- [x] Create account → business details → choose plan → review and submit (`/signup`)
- [x] All the application states, with review, set-up and billing kept separate
- [x] Save and resume, status page, answer questions and resubmit, no duplicate submissions
- [x] Queue actions: approve, reject with reason, ask for information, change plan, approve with a billing exception
- [x] Approval creates the organization, its database, owner membership and subscription — safe to retry, never duplicating; failed set-up is retryable
- [x] Owner and provider notices queued (they wait for an email provider)
- [ ] **Email verification** at sign-up (blocked on §1.1; the review screen warns meanwhile)
- [ ] Optional logo upload during onboarding
- [ ] Hosted checkout for paid plans after approval (§3.6)
- [ ] An approved owner entering their workspace in the app (§3.1)

### 3.4 Invitations and roles (Phase D)
- [ ] Expiring single-use invitations tied to recipient, organization, role, store access and inviter
- [ ] Decide and enforce whether a pending invitation holds a seat
- [ ] Owners and admins manage their own team from inside the app
- [ ] Custom roles where the plan allows
- [ ] Store-level access per member

### 3.5 Plan limits not yet enforced
Seats and inventory items are enforced. Still to wire up (each is labelled
"(not enforced yet)" in the panel):
- [ ] Collections, catalogs, stores, customer records, private rooms
- [ ] Storage (needs per-organization usage counters)
- [ ] Per-month allowances: PDF generations, invoices, inquiries
- [ ] Activity-history retention
- [ ] Feature flags the app does not yet check (exports, bulk CSV import, custom roles, API access, branding)
- [ ] Guest accounts (the feature itself does not exist)

### 3.6 Billing (Phase F)
- [ ] Razorpay subscriptions for what organizations pay the platform
- [ ] Hosted checkout, signed webhooks, idempotent handling
- [ ] Failed renewals → `past_due`, dunning, cancellation
- [ ] Apply stored payment webhooks to business records (they are verified and stored, not yet applied)
- [x] Wire the app's payment links to an organization's own connected account (control centre: "Use for the app's payment links"; its webhook marks links paid)
- [ ] Mark the linked invoice paid too, per organization (with §3.1)

### 3.7 Email (Phase F, blocked on §1.1)
- [x] Retryable, idempotent outbox (notices queue and wait; shown in the control centre)
- [ ] Sending adapter that delivers the outbox
- [ ] Verification, password reset, invitations, approval and ready notices
- [ ] DNS records (SPF/DKIM/DMARC) for the sending domain

### 3.7b Control centre — built
- [x] Sidebar layout with Overview, Applications, Organizations, Accounts, Plans, Notifications, Branding, Login & security, System health, Audit log
- [x] Accounts: search, memberships, signed-in devices, sign out everywhere, reset password, disable (blocks sign-in by any method)
- [x] Provider administrators: owner-only changes, last-owner and self guards
- [x] System health as yes/no only, never secret values
- [x] Neumorphic polish pass: shared kit (drawers, dialogs, skeletons, status pills), address-based navigation,
      command palette (Ctrl K), phone tab bar, Plans redesign, organization page with at-a-glance tiles.
      Checked headlessly at 1400px and 390px: no layout shift, no sideways scroll, no clipped text on any screen
- [x] Same design as the organization app: its floating shell, sidebar rows, phone dock, cards, pills, status chips,
      sheets and sign-in screen, light and dark
- [x] Profile: name, password change (optionally signing out other devices), two-factor on/off and new backup codes,
      signed-in devices with per-device sign-out, dark mode, sign out
- [ ] Organization data export, closure and scheduled deletion (§3.13)
- [ ] Usage and cost visibility per organization (needs usage counters, §3.5)

### 3.8 Support access (Phase E)
- [ ] "Enter organization" sessions: re-authentication, a reason, short expiry, read-only by default
- [ ] Persistent banner and an obvious exit
- [ ] Audit entry, exit and every action, recording both the real admin and the organization
- [ ] Elevated access as a separate, harder step; ownership, login and billing changes blocked
- [ ] Publish the support-access policy to organization owners

### 3.9 Organization branding (Phase E)
- [ ] Per-organization name, logo and accent colour (provider always; owners when the plan allows)
- [ ] Apply to the app, catalogs, invoices and PDFs
- [ ] Same upload checks as the platform logo

### 3.10 Realtime and notifications (Phase G)
- [ ] Move the hub into each organization's own object
- [ ] Per-organization push recipients and email recipients
- [ ] Reconnect recovery, bounded fallback polling, multi-tab coordination
- [ ] Measure before claiming any saving

### 3.11 File security (Phase G)
- [ ] Turn on `FILE_AUTH` in production (files are currently reachable by URL)
- [ ] Per-organization file namespace and ownership records
- [ ] Purge previously public cached copies (already-downloaded copies cannot be recalled)

### 3.12 Demo data (Phase G)
- [ ] Seed two demo organizations (a studio and a gallery) with different plans
- [ ] Reserved example.com addresses, no usable secrets, clearly marked demo
- [ ] Idempotent, environment-gated, with a reset that can only touch demo resources

### 3.13 Backups and lifecycle (Phase H)
- [ ] Per-organization export
- [ ] Nightly independent backup to R2, separate from Cloudflare's own recovery
- [ ] Tested restore procedure and a written retention policy
- [ ] Closure and scheduled deletion; recovery from failed provisioning

### 3.14 Security and correctness
Security review of 2026-09-23 — fixed locally, **not yet deployed** (commits a55c9ac … 4c630d2):
- [x] Private chats: only members may read, update or delete a conversation; no take-over by re-creating an id
- [x] Uploads can never run as the app (type from the file's bytes; only images, PDFs, text shown; the rest downloads, sandboxed, nosniff)
- [x] Files: remove only your own / as admin / as an inventory editor; nothing outside `uploads/`; file list limited to your own
- [x] Sign-in limited per IP (10/min) and per email (5/min); 600 API calls/min per device; no account-existence timing; 10-character passwords
- [x] Security headers on every page and asset (`public/_headers`); nosniff on both APIs; old `/api` error handler no longer returns internal messages
- [x] Manual activity-history entries admin-only; dev server bound to this computer

Production steps, each needing the owner's go-ahead:
- [ ] Deploy the commits above, then check sign-in, chat, uploads and images on the live app
- [ ] A day later: `FILE_AUTH=on` (see §3.11 and `DEPLOYMENT.md`); test images in the installed PWA
- [ ] After staff have moved to app.ateliersupport.com (it is still a legacy host in `brand.ts`): `workers_dev: false`, so the workers.dev address can't bypass zone rules
- [ ] Cloudflare dashboard (owner): two-factor on the account, Bot Fight Mode, managed WAF rules, a usage/billing alert

Still open:
- [ ] Rate limits on expensive organization endpoints (auth endpoints are covered)
- [ ] Dependency and secret scanning in CI (gitleaks, `npm audit`)
- [ ] A script-src content security policy (needs testing with the PDF and background-removal libraries)
- [ ] Move the old app's sign-in token out of `localStorage` into an HttpOnly cookie, as the new platform already does
- [ ] Before opening public sign-up: Turnstile on sign-up and applications, email verification, `ADMIN_HOST`, Cloudflare Access in front of `/admin`
- [ ] Split the old worker's KV user lists, which stop at 1,000 and break the team list
- [ ] Concurrency review of the remaining inventory paths as they move over

## 4. Verification still to do

- [ ] Staging: the whole sign-up → approval → workspace flow
- [ ] Production: smoke test after each deploy
- [ ] Load tests with adjustable organization and user counts (nothing load-tested yet)
- [ ] Cross-organization isolation re-checked on staging with real data volumes
- [ ] Restore rehearsal from a backup

Nothing in §4 has been done yet; only local automated tests (107 passing),
local runs of the real Worker, and a scripted browser run of the full
sign-up → approval journey.

## 5. Decided, for the record

- App lives at `app.ateliersupport.com`; the main domain becomes the marketing site.
- Local email and password login stays on, switchable off from the panel later.
- Google sign-in is built but off, and never links by email match alone.
- Each organization gets its own database (Durable Object), not a shared table.
- Each organization collects its customers' payments into its **own** Razorpay account.
- Published plan versions are frozen; changes mean a new version.
- Downgrades never delete data.
