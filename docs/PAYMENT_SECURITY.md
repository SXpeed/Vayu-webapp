# Payment security hardening

Work from the September 2026 security review of payment links, payment
credentials and sessions. This page says what is **done and tested**, what is
**not done yet**, and what an operator must do. Code is not "done" here until
its tests pass.

## Status

| # | Issue | Status | Tests |
|---|---|---|---|
| 3 | Payment credential encryption, key ids, rotation | **Done** (local tests) | `tests/paymentSecrets.test.mjs` |
| 4 | Explicit organization on every new payment link | **Done** | `tests/appPayments.integration.test.mjs` |
| 7 | Explicit test/live mode | **Done** (links); billing totals not yet | `paymentLinkPolicy.test.mjs`, `appPayments…` |
| 8 | Server-side amounts, invoice balance, overrides, idempotency | **Done** | `paymentLinkPolicy.test.mjs`, `appPayments…` |
| 5 | Webhook secret overlap, health, scheduled reconciliation | Not done | — |
| 6 | Refunds and gross/refunded/net totals | Not done | — |
| 2 | Rate limits on costly routes | Not done (sign-in and per-device limits exist) | — |
| 1 | Session token out of localStorage (cookies, CSRF, CORS) | Not done | — |

## Payment credentials (issue 3)

`frontend/platform/secrets.ts`, `frontend/platform/secretRotation.ts`.

- AES-256-GCM, a random 96-bit nonce per value, associated data binding the
  value to `<org>|<provider>|<field>` (or the platform billing account), the
  format version and the key id. Format `v2.<kid>.<iv>.<ct>`; the older `v1`
  values (key `k0`) still decrypt.
- Keys, all Worker secrets, 32 random bytes base64 each:
  - `PAYMENT_SECRETS_KEY`: key id `k0` (the original key).
  - `PAYMENT_SECRETS_KEYS`: optional JSON `{"k1":"…","k2":"…"}`.
  - `PAYMENT_SECRETS_ACTIVE_KID`: the key that encrypts new values (default `k0`).
- Decryption failures are logged as one line, `event=secret_decrypt_failed`,
  with the organization, purpose, key id and a reason class. Never the value.

**Rotating a key**

1. `openssl rand -base64 32` → add it as `k1` in `PAYMENT_SECRETS_KEYS`
   (`npx wrangler secret put PAYMENT_SECRETS_KEYS`). Deploy. Nothing changes yet.
2. Set `PAYMENT_SECRETS_ACTIVE_KID` to `k1`. New values use `k1`.
3. Control centre → Security → Payment credential keys → **Re-encrypt**. It
   runs in batches; the 10-minute cron finishes any left. A value is only
   replaced after the new one decrypts back to the same secret, and only if
   the row still holds what was read; a failure leaves the old value.
4. **Check every value**: zero values on `k0`, nothing unreadable.
5. Only then remove the old key. Removing a key that still holds values makes
   those credentials unreadable (the panel lists such keys).

**What this does not protect against.** Every key is a secret of the same
Worker. Anyone who can read those secrets, or run code in this Worker, can
decrypt every organization's credentials. The per-organization associated data
separates purposes (a copied ciphertext won't decrypt elsewhere); it does not
isolate organizations from a key or runtime compromise. Real isolation needs
keys held outside this Worker (a KMS or HSM, or a separate service that only
decrypts for the caller's organization).

## Payment links (issues 4, 7, 8)

`frontend/worker.ts` (`linkAccountFor`, `approveAmount`, `handlePaymentLinkCreate`),
`frontend/paymentLinkPolicy.ts`.

**Which account.** A request for an organization (`/api/o/<org>/…`) makes links
only in that organization's own verified Razorpay account. The original app
without an organization (`/api/payments/link`) uses only the shared account in
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`, and only while
`LEGACY_PAYMENT_LINKS=on`; otherwise it answers **410** asking the person to
sign in with their workspace account. The control centre's old "Use for the
app's payment links" choice is retired (POST answers 410); an old stored value
can be cleared on the organization's card and no longer decides anything.

Each new link records `account`, `orgId`, `mode`, `currency`, `keyIdHint`,
`referenceId`, and an immutable `approved` snapshot (amount, invoice totals,
any override with its reason, who approved it).

**Webhooks and older links.** An event only changes links made in the account
whose secret verified it. Links made before this change carry the account they
were made in, so an organization's webhook finds its older links in the original
storage by that record, never by the old global setting. A link's status only
moves forward: a late "expired" cannot un-pay a paid link.

**Test and live.** The mode comes from the key (`rzp_test_`/`rzp_live_`). In
production a test-mode account can make customer links only when allowed:
per organization in the control centre (audited), or for the shared account
with `SHARED_RAZORPAY_ALLOW_TEST=on`. Even then the person making the link must
confirm it's a test. Local development always allows test keys. Test links are
labelled TEST. Razorpay shows its own test-mode notice on its hosted page; the
app can't change that page's labels.

**Amounts.** Whole paise. At least ₹1, at most `PAYMENT_LINK_MAX_PAISE` if set
(otherwise a ₹100 crore sanity ceiling; the Razorpay account's own limit still
applies). A link can be tied to a proforma invoice: the server recomputes the
invoice total from its items and tax and subtracts every paid or still-payable
link of the same mode. Collecting part of what's outstanding is routine.
Collecting more than is outstanding, or marking a smaller amount as settling the
invoice (a discount), needs the workspace **admin role** and a reason (5–300
characters), which is stored on the link and in the activity log. There is no
automatic discount threshold; none was invented.

**Duplicates.** The app sends an `Idempotency-Key` per request and repeats it
on retries. The server stores the claim (`payment_link_requests` in the
workspace database) and gives each request a Razorpay `reference_id`, which
Razorpay accepts once per link. If Razorpay's answer is lost (timeout, network
error, 5xx) or it says the reference was used, the server looks the link up by
reference instead of making another.

## Configuration names

Secrets: `PAYMENT_SECRETS_KEY`, `PAYMENT_SECRETS_KEYS`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.

Vars (in `wrangler.jsonc`): `PAYMENT_SECRETS_ACTIVE_KID`, `LEGACY_PAYMENT_LINKS`,
`SHARED_RAZORPAY_ALLOW_TEST`, `PAYMENT_LINK_MAX_PAISE`.

**Current production settings (2026-09-30):** `LEGACY_PAYMENT_LINKS=on` (staff
still sign in the original way) and `SHARED_RAZORPAY_ALLOW_TEST=on`, because the
shared account still has **test keys**. Remove `SHARED_RAZORPAY_ALLOW_TEST` once
live keys are set.

## Database migration

`frontend/platform/migrations/0010_payment_security.sql`: additive (new
nullable columns and two new tables). The code works without it; until it is
applied, the control centre's "Allow test links" switch answers "apply
migration 0010 first". Apply when convenient:

```bash
npx wrangler d1 migrations apply PLATFORM_DB --remote
```

## Rollback

- Code rollback is safe for the database (the migration is additive).
- **Credentials saved after this deploy are in format v2.** Code from before
  this change reads only v1, so after a rollback those accounts' keys can't be
  decrypted until they are re-entered. Credentials saved earlier are untouched.
- Rolling back re-enables the global "app account" choice and removes the
  test-mode, amount and duplicate checks.

## Still to do

Issues 5, 6, 2 and 1 above, and excluding test payments from the control
centre's billing totals.
