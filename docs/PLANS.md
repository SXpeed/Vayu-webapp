# Plans, limits and subscriptions

What an organization is allowed to do, and how that is billed. Managed from the
control panel (**Plans** tab, and **Plan and limits** on each organization).

| Piece | Where |
|---|---|
| Schema | `frontend/platform/migrations/0004_plans.sql` |
| Logic | `frontend/platform/plans.ts` |
| Panel | `frontend/admin/PlansPanel.tsx`, the plan card in `admin/OrgsPanel.tsx` |
| Tests | `frontend/tests/plans.integration.test.mjs` |

## Five separate things, on purpose

| | |
|---|---|
| **Plan** | the product, e.g. "Studio" |
| **Plan version** | what it contained when someone signed up |
| **Subscription** | which version an organization is on, and its state |
| **Entitlement override** | a documented exception for one organization |
| **Usage** | what that organization actually uses |

Because of this split, **editing a plan cannot change an existing contract**. A
change means publishing a **new version**, and organizations move to it only when
a provider admin says so. A published version is frozen — the API refuses to
edit it, and a database trigger refuses it too.

## What a version can set

Members, stores, items and storage (blank = unlimited); which modules are on
(catalogs, invoices, inquiries, messaging, attendance, calendar); exports,
catalog PDFs, custom roles, branding; audit retention; allowed integrations.
Billing: free, trial, paid or custom, currency, monthly and annual price, trial
length. Prices are entered in rupees and stored in paise.

## The billing flow

- **Free** plans activate as soon as they are assigned.
- **Trials** start their clock when assigned, and can be extended with a reason.
- **Paid** plans sit at `payment_required` until payment is confirmed. (Taking
  the payment comes with the billing work; today a provider admin can **waive
  payment** with a recorded reason, which activates the organization.)
- An expired trial shows as `trial_expired` and the organization is no longer
  `active` for adding things.

## Limits are enforced on the server

- **Seats are checked inside the insert itself**, so two requests racing for the
  last seat cannot both succeed. Re-enabling a disabled member also needs a free
  seat. Tested with parallel requests.
- **A downgrade never deletes anything.** An organization over its new limit
  keeps every member, item and file; it is simply blocked from adding more until
  it is back under, and the panel says so plainly.
- **Overrides** raise (or lower) one limit for one organization, always with a
  reason, optionally with an expiry, and always audited. An expired override
  stops counting automatically.
- An organization with **no plan** gets conservative defaults rather than
  unlimited access.

## Public pricing

`GET /api/v2/public/plans` returns only plans that are **published and marked
public**, and only the fields a price card needs (name, description, prices,
trial length, headline limits). Internal ids, notes, draft and retired versions
never appear. The response is cacheable for a minute so the marketing site stays
mostly static.

## Not done yet

- **Taking payment** (Razorpay subscriptions for the platform's own billing) and
  what happens on failed renewals — `past_due` exists as a state but nothing
  sets it yet.
- **Item and storage limits are defined but not yet enforced** at write time;
  seats are. Enforcing the rest needs usage counters fed from each
  organization's database.
- **Custom roles** as a plan feature: the flag exists, the feature does not.
- **Self-serve plan choice** during sign-up comes with the onboarding flow.
