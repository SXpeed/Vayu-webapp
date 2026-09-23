# The app, per organization

The app (app.ateliersupport.com) signs people in with their **platform
account**, the same one they use on the website, and works in one of their
organizations at a time. Each organization's data is its own.

| Piece | Where |
|---|---|
| Opening an organization per request | `frontend/orgApp.ts` |
| Its storage: database, files, settings | `frontend/orgStorage.ts`, `frontend/orgAppDb.ts` |
| Account and team routes inside an organization | `frontend/orgTeam.ts` |
| Invitations | `frontend/platform/invitations.ts` |
| Connecting the original app's data (Vayu) | `frontend/platform/originalApp.ts` |
| Schema | `frontend/platform/migrations/0007_app_access.sql` |
| App side | `services/workspace.ts`, `views/LoginView.tsx`, `views/JoinView.tsx`, `components/InvitePanel.tsx`, `components/AccountCards.tsx` |
| Tests | `tests/orgApp.integration.test.mjs`, `tests/originalApp.integration.test.mjs` |

## How a request is handled

The app calls `/api/o/<organization id>/<path>`. On the way in:

1. The organization must exist and be active (paused: 403; plan not active: 402).
2. The platform sign-in (cookie) and the membership are checked on **every**
   request, so removing someone takes effect at once. Signed in but not a
   member, or no such organization: the same 404.
3. The request gets that organization's storage, and the member's record in
   the app becomes its session. Then the app's normal routes run, unchanged:
   every permission check, custom role, sync, realtime and file rule applies.

Only private viewing-room links work without a sign-in (`/api/o/<id>/viewing/…`).
Changes must come from our own pages (Origin check; the cookie is SameSite=Lax).

`/api/<path>` without an organization keeps working exactly as before, with
the original app's own sign-in, so installed copies don't break during the move.

## Where each organization's data lives

| | Own storage (every new organization) | Original storage (Vayu) |
|---|---|---|
| Database | Its own SQLite database: a Durable Object (`ORG_APP_DB`) named by the organization id, with the original app's tables | The original D1 database (`VAYU_DB`) |
| Settings (KV) | The shared namespace, keys prefixed `org:<id>:` | Unprefixed, as before |
| Files (R2) | The shared bucket, keys prefixed `orgs/<id>/`; addresses `/api/o/<id>/files/…` | As before, `/api/files/…` |
| Realtime | Its own hub (`org-<id>`) | The original hub |
| Payment links | Only its own Razorpay account | As before (the account chosen for the app's links) |

The adapters make each organization's storage look exactly like the original
bindings, so no handler needed rewriting. A handler can only ever reach the
storage it was given. The isolation tests fail if any of the three is shared.

## People

- **Roles.** Each member has a platform role (owner, admin, manager, staff) and
  an app role (Admin, Staff or a custom role, with the app's permissions).
  Making someone an app admin makes them a platform admin, and back; the owner
  always has full access and can't be removed from inside the app.
- **Invitations** (Team → Invite someone). An email with a link:
  `app…/join/<token>`. The link works once, runs out after 7 days, and only for
  the invited address. The person signs in (email or Google) or creates an
  account right there, even while public sign-up is closed. Only the token's
  hash is stored. The plan's member limit is checked when it is accepted.
  Without email, the admin is shown the link to pass on.
- **Removing** someone ends their membership; what they wrote keeps their name.
- **Their own account**: email, password and signed-in devices are theirs to
  manage (Profile → Password, and the device list). "Forgot password?" is on
  the sign-in screen.

## Signing in to the app

One form. It tries the platform account first; if the platform doesn't know
that email and password, it tries the original app's own sign-in. So nobody is
locked out while Vayu is being connected. Google sign-in shows when it is on
in the control centre. With more than one organization, the person chooses one
(Profile → Workspace → Switch changes it). With none, they are told why.

Each workspace keeps its own offline copy on the device, removed on sign-out.

## Connecting Vayu (once, in the control centre)

1. Apply platform migrations `0006` and `0007` (see below) and deploy.
2. Organizations → the Vayu organization → **App data** → *Use the original
   app's data…* (type its address name to confirm). Only one organization can.
3. **Bring in the original app's people**: a preview first (who joins, who gets
   a new account, who already has one), then for real. Everyone keeps their
   current password and their history; someone who already had a platform
   account keeps it. Running it again changes nothing.
4. Staff sign in to the app as they do today. Their old installed copies keep
   working until they sign in again.

Vayu's data is not moved or copied: the organization simply works on it.

## Deploying this

In this order, each with the owner's go-ahead:

1. `npx wrangler d1 migrations apply PLATFORM_DB --remote` (applies `0006_email`
   and `0007_app_access`). The code reads the new columns, so this comes first.
2. Deploy. The new Durable Object class (`OrgAppDb`, migration tag `v3`) is
   created by the deploy itself.
3. Connect Vayu as above.

## Not done yet

- A business's own plan limits on inventory items etc. inside the app (seats
  are enforced; see `PENDING.md` §3.5).
- Per-organization branding in the app (§3.9).
- Push notifications stay registered to a device after its person signs out of
  a workspace, as they did before.
