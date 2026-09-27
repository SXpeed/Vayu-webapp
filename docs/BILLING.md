# Billing: organizations paying for their plan

An organization's owner or admin changes or renews its plan in the app
(**Admin → Plan → Upgrade or change plan**) and pays straight away in
Razorpay's checkout (UPI, cards, net banking, wallets). The plan changes as soon
as Razorpay confirms the payment.

| Piece | Where |
|---|---|
| Schema | `frontend/platform/migrations/0008_billing.sql` (`billing_payments`) |
| Logic | `frontend/platform/billing.ts` |
| App routes | `/api/o/<org>/billing*` in `frontend/worker.ts` |
| Control centre routes | `/api/v2/admin/billing/*`, webhook `/api/v2/webhooks/billing/razorpay` (`platform/routes.ts`) |
| App screens | `components/PlanPanel.tsx`, `views/PlanBlockedView.tsx`, `services/billingService.ts` |
| Control centre | `admin/BillingPanel.tsx` (**Billing** tab) |
| Tests | `frontend/tests/billing.integration.test.mjs` |

## Two Razorpay accounts, never mixed

- **The platform's own account** takes plan payments. It is connected in the
  control centre under **Billing → Plan payments account** and stored
  encrypted in `platform_settings` (`billing_razorpay`).
- **Each organization's own account** (Organizations → an organization →
  Customer payments) is for the money *its customers* pay it. Plan payments
  never use it.

Organizations see their plans but can't pay until the platform account is
connected **and verified**.

## Setting it up (provider)

1. Razorpay → Settings → API Keys: generate a key (test first).
2. Control centre → Billing → **Connect Razorpay**: key ID, key secret, webhook
   secret. Then **Verify keys**.
3. Razorpay → Settings → Webhooks → Add: the address shown under **Webhook
   set-up** (`https://api.ateliersupport.com/api/v2/webhooks/billing/razorpay`),
   events `order.paid`, `payment.captured`, `payment.failed`, with the same
   webhook secret.
4. Publish at least one **public, paid** plan (Plans tab) with a monthly and/or
   annual price. Only those, plus the organization's own current paid plan, are
   offered.

Switching to live mode later: replace the keys with `rzp_live_…` ones and
verify again. Orders made with the old key can only be rechecked while that key
is connected.

## How a payment goes

1. The app asks for a checkout (`POST /billing/checkout { planKey, period }`).
   The server makes a Razorpay **order** for the plan's price and records it.
   Opening the checkout again within 30 minutes reuses the same order.
2. Razorpay's checkout takes the payment in the browser.
3. The payment is confirmed by whichever comes first:
   - the browser's signed result (`POST /billing/confirm`, signature checked);
   - the platform webhook;
   - **Recheck**, in the app or the control centre.

   Each of them reads the order and its payments back from Razorpay before
   believing anything. An authorised-but-not-captured payment is captured.
4. The plan changes **exactly once** per payment. The row takes a token, and
   the subscription change and its audit entry (`billing.payment.applied`)
   happen in the same transaction only if the token is theirs.

## What a payment buys

- One month or one year. **Nothing renews by itself.**
- Paying for the **same plan** while it is still running adds the period on
  to the end of the current one (Renew).
- Choosing a **different plan** starts it straight away for a full period.
  Time left on the old plan is not credited (no proration yet).
- A paid plan's waiver is cleared, and the subscription becomes `active` with
  `current_period_end` set.
- After the period ends there are **7 days' grace** (`RENEWAL_GRACE_MS`). The
  Plan screen says "Renewal due" and when to renew by. After that the
  subscription reads as `past_due` and the workspace closes until it is paid.
- Plans with no period end (waived, free, assigned by hand) never lapse this way.

## A closed workspace can still pay

When the plan isn't active (`payment_required`, `trial_expired`, `past_due`),
every app route answers 402, except `/plan`, `/billing*` and `/auth/logout`.
The app then shows only the plan screen (`PlanBlockedView`). Owners and admins
can renew or choose a plan there, and the workspace opens again once it is paid.
Everyone else is told an owner or admin needs to renew.

## What people see

- **Organization (owners and admins):** its plan payments, each with status
  (Paid / Payment failed / Not completed), and when opened, Razorpay's record of
  every attempt. That covers the transaction ID, time, how it was paid (UPI ID,
  card network and last 4 digits, bank or wallet), the payer's email and phone,
  bank references (RRN, UPI and bank transaction IDs), the authorisation code,
  refunds and failure reasons. Razorpay's fee is **not** shown to organizations.
- **Provider (control centre → Billing):** every organization's plan payments
  with the same detail plus Razorpay's fee and tax, filters, totals for the
  last 30 days and all time (test-mode payments counted and labelled), and
  Recheck.

## Offers and price changes

A running offer on a plan (`plan_offers`, migration 0009) lowers the checkout
price. `billing_payments` keeps `list_amount`, `discount_percent` and
`offer_label`, which show on the payment in the app and the control centre.
Renewing an organization's own plan charges its own version's price, so a
price change never reaches existing customers (see `docs/PLANS.md`).

## Not done yet

- Automatic renewal (Razorpay Subscriptions / e-mandate) and reminder emails
  before a period ends.
- Proration or credit when changing plan mid-period.
- Invoices / GST receipts for plan payments.
- Refunds from the control centre (do them in the Razorpay dashboard; a
  refunded payment shows as refunded on Recheck, and the plan is not changed back).
