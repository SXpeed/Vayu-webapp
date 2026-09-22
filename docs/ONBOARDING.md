# Public website, sign-up and the control centre

## Pages

| Address | What it is | Code |
|---|---|---|
| `/welcome` | Landing page: what it does, features, how it works, pricing, about, contact | `frontend/site/Landing.tsx` |
| `/signup` | Create an account, apply, and follow the application | `frontend/site/Signup.tsx` |
| `/signup?mode=signin` | "Log in" for applicants and owners | same |
| `/legal` | Privacy policy and terms (placeholders) | `frontend/site/Legal.tsx` |
| `/admin` | The control centre | `frontend/admin/` |

All wording on the public pages lives in **`frontend/site/content.ts`**. Anything
marked `placeholder(...)` shows on the page inside a dashed "Placeholder" frame
until you replace it: the About text, contact email and address, the privacy
policy and the terms. No testimonials, certifications, security claims or legal
text have been invented.

Pricing on the landing page comes from the plans you publish in the control
centre and mark as public — nothing else about plans or organizations is exposed.

`/welcome` is not yet the root of `ateliersupport.com`: staff still use the main
domain for the app. Once everyone has moved to `app.ateliersupport.com`, the main
domain's root switches to the landing page (see `docs/PENDING.md`).

## The applicant's journey

1. **Create an account** — name, email, password (10+ characters). Needs public
   sign-up switched on in the control centre (**Login & security**); when it is
   off, the page says sign-up is by invitation and points to Contact.
2. **Business details** — name, type, owner, phone, address, country, time zone
   are required; website, team size, stores, tax ID and a note are optional.
   **Everything saves**, so they can leave and come back.
3. **Plan** — monthly or yearly, from the published public plans.
4. **Review and send.** Sending twice changes nothing.
5. **Status page** — shows where it is, any question from you, or the reason for
   a rejection. When you ask for information, they update and send again.

A new account opens nothing: it has no organization until one is approved and
set up. Applicants only ever see their own application — it is found from their
session, never from an id in the request.

## Reviewing (control centre → Applications)

| Action | What happens |
|---|---|
| **Approve** | Creates the organization, its own database, the owner membership and the subscription. Free plans go live, trials start, paid plans wait for payment. |
| **Approve with a billing exception** | Same, but activates without payment. A reason is required and recorded. |
| **Ask for information** | Sends it back with your question; they see it and resubmit. |
| **Change plan** | Records the change and your reason. |
| **Reject** | A reason is required; they see it. |

Approval is **safe to repeat**. The organization takes the application's id and
every step is "only if not already there", so a double click, a retry, or a
failure halfway never creates a second organization, database or membership. If
set-up fails, the application shows the error to you (not to the applicant) and
**Retry setup** resumes it.

Review, set-up and billing are three separate states internally: approving does
not by itself mean a workspace exists or that anything was paid.

**Email is not verified yet** (no email provider). The review screen warns you
about this; confirm the applicant is genuine before approving.

## The control centre

| Section | What it does |
|---|---|
| **Overview** | What needs attention: applications to review, organizations, accounts, notices waiting, trials ending, payments awaited, plan mix, recent activity |
| **Applications** | The queue and every decision above |
| **Organizations** | Members, plan and limits, Razorpay, suspend/reactivate |
| **Accounts** | Everyone who can sign in: search, organizations, signed-in devices; **sign out everywhere**, **reset password** (temporary password shown once), **disable** (ends sessions immediately and blocks sign-in by any method) |
| **Plans** | Plans, versions and every limit and feature |
| **Notifications** | Your notification email, and the outbox of notices waiting for an email provider (retry, cancel) |
| **Branding** | Platform name, tagline, accent colour, logo |
| **Login & security** | Login methods, and the list of provider administrators (owners only can change it; the last owner can't be removed; nobody can change their own access) |
| **System health** | What is configured, as yes/no only — never a secret's value — plus migrations and flags |
| **Audit log** | Every administrative action |

Changing accounts, administrators, approvals and other sensitive settings needs
a sign-in newer than 30 minutes; the centre asks you to confirm and then carries
on.

Nothing in the control centre ever shows a password, a session token, an API
secret or a payment credential.

## Notifications

Notices are queued in the same step as the change that causes them (so none are
lost), and keyed so a repeated action never queues the same notice twice. With
no email provider connected they wait in the outbox; every application is in the
queue regardless.

## Running it locally

```bash
cd frontend
npm run db:migrate     # after pulling new migrations
npm run build
npm run dev:worker     # http://localhost:8787 — restart it after every build
```

Then **Login & security → Email & password sign-up: on** to try the public flow.
Use `http://localhost:8787` for the public pages and `http://127.0.0.1:8787` for
the control centre if you want to be signed in as an applicant and as the admin
at the same time (cookies are per host).
