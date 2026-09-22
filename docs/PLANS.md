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

Every field lives in `frontend/platform/planFields.ts`, and both the API's
validation and the control panel's editor are generated from it — adding a new
limit or feature later is one entry, not new form code.

**Limits** (blank = unlimited): employee seats, guest accounts, products /
inventory items, collections, catalogs, stores, customer records, private rooms,
storage (MB), PDF generations per month, invoices per month, inquiries per month,
activity history (days).

**Included features**: inventory, collections, catalogs, customers, inquiries,
invoices, payments, direct & group messages, private rooms, calendar &
follow-ups, attendance, catalog PDF export, background removal, bulk CSV import,
data export & reports, custom roles, own branding, API access, priority support,
admin activity history.

Some are **part of every plan** (inventory, admin activity history): the panel
shows them ticked and locked, and the server forces them on even if a request
says otherwise — an override cannot switch them off either.

**Billing**: free, trial, paid or custom, currency, monthly and annual price,
trial length. Prices are typed in rupees and stored in paise. Each version can
carry a short reason, kept with it for your records.

### Enforced today vs. defined but not yet enforced

Enforced now: **employee seats** (atomically, tested under parallel requests)
and **products / inventory items** (a create is refused at the limit).

Defined and stored, but not yet checked at write time: guest accounts (guest
access does not exist yet), collections, catalogs, stores, customer records,
private rooms, storage, the per-month allowances, activity retention, and the
feature flags other than the ones the app already gates. Each is marked in the
panel with "(not enforced yet)" so nothing there misleads you; they are wired up
as each part of the app moves onto the organization databases.

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

## Platform branding

The provider's own name, tagline, accent colour and logo are set in the control
panel (**Branding** tab), not baked into the build: `platform/branding.ts`,
stored in `platform_settings`, served to everyone at
`GET /api/v2/public/branding`. The app and the panel read it at startup and fall
back to the built-in name if the platform layer is unavailable.

Logo uploads are checked properly: PNG, JPEG or WebP only (SVG is refused
outright, since it can carry script), at most 1 MB, 64–2048 pixels, and the
format is read from the file's own bytes — a file that merely claims to be a PNG
is rejected. Each upload gets a new versioned address, so caches pick it up
immediately. An app already installed on a phone keeps its old icon until the
device refreshes it; that cannot be forced.
