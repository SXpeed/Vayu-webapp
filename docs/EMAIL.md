# Email (Cloudflare Email Service)

Every email the platform sends goes through Cloudflare Email Service, using the
API Worker's `send_email` binding `EMAIL`. One module builds them all
(`frontend/platform/email.ts`), so they share one look and always carry a
plain-text version.

| Email | When | How it is sent |
|---|---|---|
| Confirm your email address | Sign-up with email and password (Google accounts arrive confirmed) | Directly, link valid 24 hours |
| Reset your password | "Forgot password?" on the sign-in page | Directly, link valid 1 hour, works once, signs out every device |
| New or updated application | An applicant sends their application | Outbox, to the notification address in the control centre |
| We need a little more information | You ask the applicant a question | Outbox |
| About your application | You reject an application | Outbox |
| Your workspace is ready | Approval finishes setting up the organization | Outbox, with a link to the app |

**Directly** means inside the request that makes the link; the link's token
never touches a table anyone can list. **Outbox** means the notice is written in
the same database step as the change that causes it, so it can't be lost, and is
then sent right after the request. A notice that fails is retried after 5
minutes, 30 minutes, 2 hours and 12 hours (a cron runs every 10 minutes), then
marked failed; the control centre's Notifications screen can retry it.

**An application can only be sent from a confirmed address** while email is on.
Signing in never waits for confirmation, so accounts made before email existed,
or by the control centre, are not locked out.

## Setting it up (once, in the Cloudflare dashboard)

1. **Email → Email Service → Onboard a domain** (the name in the dashboard may
   be Email Sending): choose `ateliersupport.com`. Cloudflare adds the SPF and
   DKIM records to the zone itself.
2. Add a DMARC record if the zone has none, for example
   `_dmarc.ateliersupport.com TXT "v=DMARC1; p=quarantine; rua=mailto:<your address>"`.
3. Apply the platform migration that adds retry timing:
   `npx wrangler d1 migrations apply PLATFORM_DB --remote` (migration `0006_email`).
4. Deploy. The sender is `EMAIL_FROM` in `wrangler.jsonc`
   (`no-reply@ateliersupport.com`); set `EMAIL_REPLY_TO` if replies should reach
   a mailbox.
5. Control centre → **System health** should show *Email delivery: Cloudflare
   Email Service*. Send yourself a password reset to check.

Until the domain is onboarded, sends fail: notices stay in the outbox and are
retried, and confirmation or reset links don't arrive.

## Switching it off

`EMAIL_SENDING: "off"` in the Worker's vars stops all email even with the
binding present: notices wait, and applications no longer need a confirmed
address. The local config (`frontend/wrangler.json`) starts with it off, so
tests opt in (`tests/email.integration.test.mjs`).

## Testing locally

`wrangler dev` simulates the binding: each email's text and HTML are written to
temporary files and the log says where. The test helper
(`tests/helpers/devWorker.mjs`, `emails()`) reads them back, so the tests follow
the real confirmation and reset links.
