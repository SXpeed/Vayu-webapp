# Payment and session security

Work from the September 2026 security review of payment links, payment
credentials, webhooks, refunds and sign-in sessions. This page says what is
done and how it was verified, what an operator must do, and what risk remains.
"Done" means the code exists **and** its tests pass locally; nothing here has
been exercised against real Razorpay money.

## Status

| # | Issue | Found | Fix | Tests (all local) | Operator prerequisites |
|---|---|---|---|---|---|
| 1 | Session token in JavaScript storage | Yes: the original sign-in kept a 30-day token in localStorage and returned it in JSON; API sent `Access-Control-Allow-Origin: *` | HttpOnly `__Host-` cookie session, CSRF (trusted origin + token), no CORS, one-time exchange of old tokens with a cutoff | `sessionCookies.integration.test.mjs` | Deploy; watch the bearer/cookie split before `LEGACY_BEARER_UNTIL` |
| 2 | Rate limiting | Partly: sign-in and per-device only | Per person / per workspace limits on costly routes; per-IP webhook ingress; no existence leaks | `rateLimits.integration.test.mjs` | None (bindings in `wrangler.jsonc`) |
| 3 | Payment secret keys | Partly: AES-GCM + AAD, but one key, no rotation | Key ids, several keys, verified resumable re-encryption, sanitized failure logs | `paymentSecrets.test.mjs` | Only when rotating |
| 4 | Ambiguous legacy payment routing | Yes: a global "app account" setting | Explicit account per link; setting retired; evidence-based routing of older links | `appPayments.integration.test.mjs` | Turn `LEGACY_PAYMENT_LINKS` off once staff use workspaces |
| 5 | Webhook secret rotation, health, reconciliation | Yes | 24 h secret overlap; health from verified signals only; scheduled reconciliation | `webhookHealth.test.mjs`, `appPayments…` | Apply migrations 0010 and 0011 for health |
| 6 | Refunds and totals | Yes: not modelled | Refund records by Razorpay id; forward-only status; gross / refunded / net | `appPayments…` | Subscribe to refund events (below) |
| 7 | Explicit test/live mode | Yes | Mode on every link; test refused in production unless allowed and confirmed; live-only totals | `paymentLinkPolicy.test.mjs`, `appPayments…`, `billing…` | Live keys; then remove `SHARED_RAZORPAY_ALLOW_TEST` |
| 8 | Server-side amounts and discounts | Yes | Paise; invoice-derived amounts; admin overrides with reason; idempotency | `paymentLinkPolicy.test.mjs`, `appPayments…` | None |

## 1. Sessions

`frontend/sessionCookies.ts`, `worker.ts` (login, `/auth/session`, logout),
`services/apiClient.ts`, `services/authService.ts`.

**Origins.** `app.ateliersupport.com` and `api.ateliersupport.com` are different
origins. Browser pages never call `api.` directly: each site Worker passes its
own `/api` path to the API Worker (docs/HOSTING.md), so the session cookie is
set on, and sent to, the page's own host only. Nothing relies on the two being
the same origin.

- **Cookie:** `__Host-vayu_session` — HttpOnly, Secure, SameSite=Lax, Path=/,
  no Domain, Max-Age 30 days (matching the server session). Local http uses
  `vayu_session` without Secure.
- **No credential in bodies:** the login and exchange responses carry the user,
  never a token.
- **CSRF:** a cookie-signed request that changes anything (not GET/HEAD/OPTIONS)
  must come from a trusted page (its `Origin` is this address or one in
  `AUTH_ORIGINS`, or with no `Origin`, `Sec-Fetch-Site: same-origin`) **and**
  send `X-CSRF-Token` equal to HMAC-SHA256(session token), which the page reads
  from the readable `__Host-vayu_csrf` cookie. Sign-in, first-run setup and the
  exchange need only the trusted origin. Workspace requests (`/api/o/…`, signed
  in by the platform's own HttpOnly SameSite=Lax cookie) now also require a
  trusted origin; a request with no `Origin` used to pass.
- **CORS:** the API sends no `Access-Control-Allow-Origin` at all (stored files
  keep `*` for image loading, without credentials).
- **Server-side expiry and revocation:** sessions live in KV with a TTL; logout
  deletes the session and clears both cookies with matching attributes; an
  admin setting a new password ends that person's other sessions. Every sign-in
  and every exchange creates a new token. Roles are re-read on every request,
  so a role change applies at once without a new session.
- **Old tokens:** a device still holding the old localStorage token sends it
  once to `POST /api/auth/session`, gets a new cookie session, and the old token
  is revoked and deleted from the device. Until `LEGACY_BEARER_UNTIL` the API
  also still accepts it as a bearer token; after that date it is refused
  everywhere (the exchange too) and those devices sign in again.
- **What cookies don't fix:** an injected script on our own pages can still act
  as the signed-in person (it just can't read the token). There is no
  `dangerouslySetInnerHTML` in the app; the CSP has `frame-ancestors`,
  `base-uri`, `object-src` and `form-action` but still no `script-src` (inline
  theme script and third-party libraries need testing first).

**Removing the fallback.** Analytics Engine records how each request signed in
(blob5: `cookie`, `bearer`, `none`, `platform`). When `bearer` stays at zero
for a week, remove `LEGACY_BEARER_UNTIL` from `wrangler.jsonc` (or let the date
pass). Devices that never came back will simply show the sign-in screen.

## 2. Rate limits

`frontend/rateLimits.ts`, `worker.ts` (`costlyLimit`, `webhookIngressLimit`).

| Binding | Limit | Key | Routes |
|---|---|---|---|
| `PAYMENT_LINK_LIMITER` | 10 / min | person | new payment links |
| `COSTLY_USER_LIMITER` | 30 / min | person + group | link checks and rechecks, uploads, contacts import, invitations and new users, viewing rooms, plan checkout |
| `COSTLY_ORG_LIMITER` | 200 / min | workspace + group | the same routes |
| `WEBHOOK_INGRESS_LIMITER` | 1000 / min | client IP | `/api/v2/webhooks/*`, `/api/payments/webhook` |
| `API_LIMITER` (existing) | 600 / min | device | every route |

Refusals are `429` with `Retry-After: 60` and `{"error", "code": "rate_limited"}`.
Workers Rate Limiting is **per Cloudflare location and eventually consistent**:
it stops floods and runaway scripts; it is not an exact global quota. The
costly limits run after the access check (which reads the memoised session)
and before any handler work.

**Webhooks** are limited per client IP before any signature or database work,
never per organization (an attacker could exhaust an organization's allowance
and block its real notices). Razorpay retries anything refused for 24 hours,
so a refusal delays an event rather than losing it. There are no server-side
exports or searches (CSV/PDF exports and searches run in the browser).

**Existence.** A signed-out request to `/api/o/<id>/…` gets the same 401
whether or not the organization exists, before any lookup; a signed-in
non-member gets the same 404 as for no organization, paused or not. No
artificial delays.

## 3. Payment credential keys

`frontend/platform/secrets.ts`, `frontend/platform/secretRotation.ts`.

AES-256-GCM, a random 96-bit nonce per value, associated data binding each value
to `<org>|<provider>|<field>` (or the platform billing account), the format
version and the key id. Format `v2.<kid>.<iv>.<ct>`; `v1` values (key `k0`) still
decrypt. Decryption failures log one line, `event=secret_decrypt_failed`, with
organization, purpose, key id and reason class, never the value.

**Rotating:** `openssl rand -base64 32` → add as `k1` in `PAYMENT_SECRETS_KEYS`
and deploy → set `PAYMENT_SECRETS_ACTIVE_KID=k1` → control centre → Security →
Payment credential keys → **Re-encrypt** (batched; the 10-minute cron finishes
it; a value is replaced only after the new ciphertext decrypts to the same
secret and only if the row still holds what was read) → **Check every value**
shows nothing on `k0` and nothing unreadable → only then remove `k0`.

**Limits of this:** every key is a secret of the same Worker. Whoever can read
those secrets, or run code in this Worker, can decrypt every organization's
credentials. Per-organization associated data separates purposes; it does not
isolate organizations from a key or runtime compromise. Real isolation needs
keys outside this Worker (a KMS/HSM, or a separate service that decrypts only
for the caller's organization).

## 4, 7, 8. Payment links

`frontend/worker.ts` (`linkAccountFor`, `approveAmount`, `handlePaymentLinkCreate`),
`frontend/paymentLinkPolicy.ts`.

- **Account:** a workspace request (`/api/o/<org>/…`) uses only that
  organization's own verified account; the original app without an organization
  uses only the shared `RAZORPAY_*` account, and only while
  `LEGACY_PAYMENT_LINKS=on` (otherwise 410: "sign in with your workspace
  account"). The global "Use for the app's payment links" choice is retired
  (POST 410); a stored value can be cleared and decides nothing.
- **Recorded on each link:** `account`, `orgId`, `mode`, `currency`,
  `keyIdHint`, `referenceId`, `amountPaid`, and an immutable `approved` snapshot
  (amount, invoice totals, override and reason, approver).
- **Older links:** an organization's webhook finds links it made in the
  original storage by the account recorded on each link, never by the setting.
  Links whose mode is unknown get it proven by a successful status read with
  that account's keys (test and live are separate at Razorpay).
- **Test mode:** the mode comes from the key prefix. In production test keys
  make links only when allowed (per organization in the control centre,
  audited; for the shared account `SHARED_RAZORPAY_ALLOW_TEST=on`) and the
  person confirms it's a test. Test links are labelled TEST and never counted
  in money totals. Razorpay shows its own test notice on its hosted page; the
  app can't change that page's labels.
- **Amounts:** whole paise; ₹1 minimum; `PAYMENT_LINK_MAX_PAISE` if set
  (otherwise a ₹100 crore sanity ceiling; the Razorpay account's own limit still
  applies). Against a proforma invoice the server recomputes the total from its
  items and tax and subtracts every paid or payable link of the same mode.
  Instalments are routine; more than outstanding, or a smaller amount marked
  as settling the invoice, needs the workspace **admin** role and a reason
  (5–300 chars), stored on the link and in the activity log. No automatic
  discount threshold was invented.
- **Duplicates:** the client sends `Idempotency-Key` and repeats it on retries;
  the server claims it in `payment_link_requests` (workspace database) and
  sends Razorpay a `reference_id` unique to the request. A lost answer
  (timeout, network, 5xx) or "reference already used" is resolved by looking
  the link up by reference, never by making another.

## 5. Webhooks and reconciliation

`frontend/platform/payments.ts`, `platform/billing.ts`, `platform/webhookHealth.ts`,
`worker.ts` (`handlePaymentWebhook`, `reconcileAllWorkspaces`).

- **Verification:** HMAC-SHA256 of the exact raw body with that account's own
  secret, constant-time compare. No other organization's secret is ever tried;
  there is no way to skip the check.
- **Rotation overlap:** Razorpay signs retries of an event with the secret in
  force when the event was created. Replacing an organization's (or the plan
  account's) webhook secret keeps the previous one valid for 24 hours. For the
  shared account set `RAZORPAY_WEBHOOK_SECRET_PREVIOUS` (secret) and
  `RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL` (ISO time, a day after the change).
- **Duplicates and order:** events are stored once per `x-razorpay-event-id`;
  applying is idempotent; link status only moves forward; refunds only move
  pending → processed/failed.
- **Health (control centre → organization → Customer payments):** from verified
  deliveries, whether they were applied, and what reconciliation found. A
  payment or refund reconciliation found that no webhook delivered, or a
  verified delivery that failed to apply, shows **Needs attention**. No events
  yet shows as such, not as a failure. Rejected deliveries are counted per hour
  (`webhook_rejections`) for telemetry only and never change health or alert
  anyone.
- **Reconciliation:** every 10 minutes the cron checks every workspace's open
  links (soon after creation, then hourly, then every 6 hours, backing off on
  failures) and paid links' refunds (daily for 90 days), within 40 Razorpay
  calls per run, starting at a different workspace each run. The Payments
  screen's refresh (`POST /payments/links/refresh`) runs the same for its
  workspace. Reading the list is side-effect free; "Recheck" is a POST.

## 6. Refunds and totals

Refunds are stored per workspace in `payment_refunds`, keyed by Razorpay's
refund id and scoped to the account that sent them; `refund.created` is
**pending**, `refund.processed` and `refund.failed` are final. Several partial
refunds and a later full refund add up from the rows; a refund from another
account for the same payment is ignored.

`GET /payments/summary?from=&to=` and the Payments screen show, for **live**
links paid in the period: collected (what customers paid, Razorpay's
`amount_paid`), refunded (processed refunds), pending refunds, and net. Test
links and links whose mode isn't proven yet are counted separately and left out.
These are operational figures, not accounting revenue or tax treatment. The
control centre's plan-billing totals are now live payments only, with test
payments counted separately. The Sales ledger (offline store sales) is not
connected to payment links; linking them would be a separate change.

## Razorpay set-up (verified against Razorpay's documentation, 2026-09)

For each account (each organization's own, and the shared one while it's used):
Razorpay Dashboard → Accounts & Settings → Webhooks → Add New Webhook, with the
address shown on the organization's card (`https://api.ateliersupport.com/api/v2/webhooks/razorpay/<orgId>`;
shared: `https://app.ateliersupport.com/api/payments/webhook`), a secret, and
these events:

`payment_link.paid`, `payment_link.partially_paid`, `payment_link.cancelled`,
`payment_link.expired`, `refund.created`, `refund.processed`, `refund.failed`.

Plan payments (platform account): `order.paid`, `payment.captured`,
`payment.failed` at `…/api/v2/webhooks/billing/razorpay` (docs/BILLING.md).
Test and live mode have separate webhooks in Razorpay; add them for the mode
the connected keys use.

## Configuration (names only)

Secrets: `PAYMENT_SECRETS_KEY`, `PAYMENT_SECRETS_KEYS`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
`RAZORPAY_WEBHOOK_SECRET_PREVIOUS`, `BETTER_AUTH_SECRET`.

Vars (`wrangler.jsonc`): `PAYMENT_SECRETS_ACTIVE_KID`, `LEGACY_PAYMENT_LINKS`,
`SHARED_RAZORPAY_ALLOW_TEST`, `PAYMENT_LINK_MAX_PAISE`,
`RAZORPAY_WEBHOOK_SECRET_PREVIOUS_UNTIL`, `LEGACY_BEARER_UNTIL`, `AUTH_ORIGINS`.

Rate-limit bindings: `PAYMENT_LINK_LIMITER`, `COSTLY_USER_LIMITER`,
`COSTLY_ORG_LIMITER`, `WEBHOOK_INGRESS_LIMITER` (plus the existing ones).

Current production values (2026-09-30): `LEGACY_PAYMENT_LINKS=on`,
`SHARED_RAZORPAY_ALLOW_TEST=on` (the shared account still has **test keys**),
`LEGACY_BEARER_UNTIL=2026-11-30T00:00:00Z`.

## Migration order

1. Platform database migrations, before or after the deploy (both are additive
   and the code works without them): `npx wrangler d1 migrations apply PLATFORM_DB --remote`
   applies `0010_payment_security` and `0011_payment_reconciliation`.
2. Workspace tables (`payment_refunds`, `payment_link_requests`) are created by
   the Worker on first use.
3. Sessions: nothing to migrate by hand. Each device swaps its old token on its
   next start; new sign-ins get the cookie.
4. Keys: only when rotating (above).

## Rollback

- The database changes are additive; an older Worker ignores them.
- **Sessions:** code from before the cookie change reads only bearer tokens, so
  after a rollback every device signed in with the cookie must sign in again,
  and the token goes back into localStorage (the XSS exposure returns).
- **Credentials** saved after the key-format change are `v2`; older code reads
  only `v1`, so those accounts' keys must be re-entered after a rollback.
- Rolling back also restores the global "app account" choice, removes the
  test-mode, amount, idempotency and rate-limit checks, and brings back the
  wildcard CORS header. Prefer fixing forward.

## Production rollout checklist

1. Apply migrations 0010 and 0011 (optional for the deploy itself).
2. Deploy (CI on push to `main`).
3. Sign in on `app.` with the original sign-in: DevTools shows the
   `__Host-vayu_session` cookie as HttpOnly/Secure, nothing in localStorage but
   `vayu_signed_in`; saving anything works (CSRF header sent).
4. Open the app on a device signed in before the deploy: it stays signed in
   (exchange), and `vayu_token` disappears from its storage.
5. Make a test payment link; check the TEST banner and label.
6. In Razorpay, subscribe each account's webhook to the events above; send a
   test webhook; the organization's card shows "Arriving".
7. When live keys are connected, remove `SHARED_RAZORPAY_ALLOW_TEST`.

## Monitoring signals

- Analytics Engine blob5 auth kind: `bearer` → 0 before `LEGACY_BEARER_UNTIL`.
- 403 responses with `code` `csrf_token` / `csrf_origin` (a spike after deploy
  means cached old pages; they fix themselves on reload).
- 429 responses with `code` `rate_limited` by route.
- Workers Logs: `secret_decrypt_failed`, `payment_event_account_mismatch`,
  `refund_account_mismatch`, `reconcile_workspace_failed`,
  `payment_keys_unavailable`.
- Control centre: each organization's webhook health; System → checks
  (payment keys, original-app payment links).

## Residual risk and dependencies

- Key or Worker-runtime compromise exposes every organization's credentials
  (see 3); isolation needs an external key boundary.
- Script injection on our own pages can still act as the user; a `script-src`
  CSP is still to do.
- Rate limits are per location and approximate.
- The shared Razorpay account has test keys until you replace them.
