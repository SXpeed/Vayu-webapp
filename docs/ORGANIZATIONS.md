# Organizations, members and per-organization Razorpay

Second slice of the platform (Phase B/D groundwork). Adds the organization
registry, memberships, and each organization's **own** Razorpay account.
Everything is managed from the provider control panel at `/admin`
(see `docs/PLATFORM_AUTH.md` for how to sign in there).

| Piece | Where |
|---|---|
| Schema | `frontend/platform/migrations/0002_organizations.sql` |
| Organizations and members | `frontend/platform/orgs.ts` |
| Razorpay per organization | `frontend/platform/payments.ts` |
| Credential encryption | `frontend/platform/secrets.ts` |
| Panel screens | `frontend/admin/OrgsPanel.tsx` |
| Tests | `frontend/tests/platformOrgs.integration.test.mjs` |

## Model

- **Identity is separate from membership.** One account (`user`) can belong to
  several organizations, with a different role in each. Signing in grants
  nothing by itself.
- **Roles:** `owner`, `admin`, `manager`, `staff`. Custom roles come with the
  plan engine.
- **An organization always keeps at least one active owner.** The API refuses to
  demote, disable or delete the last one, and database triggers refuse it too,
  whatever code path tries.
- **Provider admins are a separate table.** No organization API can grant
  provider-admin rights.
- **Statuses:** `active`, `suspended`, `closed`. Suspending needs a reason and is
  audited; it deletes nothing.

## The two money flows

1. **Organization → platform** (subscriptions): the platform's own Razorpay
   account. Not built yet (Phase F).
2. **Customers → organization** (what the app's payment links do today): the
   organization's own Razorpay account, described here. Money never passes
   through the provider's account.

### Connecting an organization's Razorpay account

In the panel: **Organizations → pick one → Razorpay → Connect**.

1. In Razorpay (that business's own account) → **Settings → API Keys →
   Generate key**. The secret is shown once.
2. Paste the **Key ID** (`rzp_test_…` while testing, `rzp_live_…` for real
   payments; the mode is taken from the prefix) and the **Key secret**.
3. In Razorpay → **Settings → Webhooks → Add webhook**, paste the webhook URL the
   panel shows for that organization, choose a webhook secret, and select the
   events `payment_link.paid`, `payment_link.cancelled`, `payment_link.expired`.
   Put the same secret into the panel.
4. Click **Verify keys**. That makes one read-only call to Razorpay with those
   keys and records the result.

How the credentials are protected:

- Encrypted with AES-256-GCM using `PAYMENT_SECRETS_KEY` (a Worker secret: 32
  random bytes, base64). Without it, connecting is refused.
- Each ciphertext is bound to its organization, provider and field, so a stored
  secret copied into another organization's row cannot be decrypted.
- No API ever returns a secret; the panel shows only a masked key id.
- Connecting, replacing or disconnecting needs a sign-in newer than 30 minutes
  and is written to the audit log (without secrets).

### Using an organization's account for the app's payment links

The app (`/api/payments/link`) is not organization-aware yet, so the control
centre says which account it uses: on an organization's Razorpay card, **Use
for the app's payment links** (only once its keys are verified; one
organization at a time; needs a recent sign-in; audited). Then:

- New payment links are created with **only that organization's own keys**.
  If they stop being usable (replaced and not yet verified, or rejected), the
  app refuses to create links with a clear message: it never falls back to
  the shared account, so a business's money cannot land somewhere else.
- That organization's webhook (`/api/v2/webhooks/razorpay/<orgId>`) marks the
  app's payment links paid and notifies staff, exactly as the shared
  account's webhook (`/api/payments/webhook`) does. Other organizations'
  events never touch them.
- Each link records the account it was made in (`account`: the organization
  id, or `shared`). Links already sent keep working where they were made.
- **Stop using for the app**, or disconnecting that account, puts new links
  back on the shared account (`RAZORPAY_*` secrets).

Tests: `tests/appPayments.integration.test.mjs` (a real Worker and a local
stand-in for Razorpay's API, which is only honoured in development).

### Webhooks

Each organization has its own URL: `/api/v2/webhooks/razorpay/<organization id>`.
A delivery is accepted only if its signature matches **that** organization's
webhook secret, so one organization's events can never be accepted for another.
Every event is stored once per event id: retries and replays are acknowledged
but change nothing. Anything unverifiable — wrong signature, unknown
organization, missing event id — answers the same 401, so the endpoint doesn't
reveal which organizations exist.

## Known limitations (next steps)

- **One app, one account at a time.** Until the app is organization-aware, all
  of its payment links use the one account chosen above.
- **Webhook events update payment links, not invoices yet.** Marking the linked
  invoice paid comes once each organization has its own database (§3.1).
- **Members must already have an account.** The panel can create one with a
  temporary password you pass on yourself; expiring email invitations come with
  the plan engine (Phase D).
- **Seat limits, plans and entitlements** are not implemented yet, so no plan
  limits are enforced when adding members.

## Setting it up in an environment

Besides the platform database and auth secrets (see `docs/PLATFORM_AUTH.md`):

```bash
# 32 random bytes, different per environment
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put PAYMENT_SECRETS_KEY
npx wrangler d1 migrations apply PLATFORM_DB --remote   # applies 0002
```

Rotating `PAYMENT_SECRETS_KEY` makes stored payment credentials unreadable;
every organization would have to reconnect. Keep it, back it up, and don't reuse
`BETTER_AUTH_SECRET` for it.
