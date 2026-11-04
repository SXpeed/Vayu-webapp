# UI follow-ups: to fix, and to test

Open items from the November 2026 UI work (Back button, downloads, file opening,
photo viewer, Atelier/Lite motion). Everything below shipped except where it says
"not fixed". Tick items off here as they are done.

## Not tested yet (needs a real device)

What a desktop browser could stand in for was checked on 2026-11-04 (below). What
only a real phone shows:

- [ ] **iPhone, installed app: the real share sheet.** Safari really opening it
      ("Save to Files" / "Save Image") and really refusing it after a slow build.
      The toast and the second tap were checked with a stand-in share sheet.
- [ ] **iPhone: swipe-back** in Contacts. Back was checked; the swipe gesture can't be simulated.
- [ ] **Android, installed app: the hardware Back button** (Chrome's Back follows the same rules).
- [ ] **Phone performance** on a real mid-range Android phone (see the numbers below).

## Tested

Local copy, Chrome desktop + headless phone size (2026-11-03):

- Back closes overlays: Billing document and editor, Contacts (with keep
  editing / discard), notification sheet, artwork form, full-screen artwork
  photo, calendar floating month, private rooms panel and room form.
- Chrome's own Back button never skips a screen (steps are only added after a tap).
- Billing PDF, report CSVs: saved under the right name, the app stays put.
- Photo viewer: centred at UI size 95%; pinch zoom keeps the pinched point.
- Contacts: typing a name no longer loses focus after the first letter.
- Attendance: no duplicate-key warning.
- Sweep of all main screens in Classic, Atelier, Lite, light and dark: no errors,
  nothing wider than the screen.

Local copy, Safari's engine (Playwright WebKit 26.6, iPhone 13 size) and Chrome
at Pixel 7 size (2026-11-04):

- iPhone: full-screen artwork photo centred (11.7 px left, 10.7 px right at UI
  size 95%), not cropped. Chat photos use the same viewer.
- iPhone app: when the share sheet is refused, "Tap to save inventory-….csv"
  shows at the top, nothing covers it, and tapping it asks for the sheet again
  with a fresh tap. Checked with a stand-in for Safari's share sheet.
- iPhone: Back in Contacts with unsaved changes asks "Discard your changes?";
  keep editing keeps the text, discard closes and stays on Contacts. Dark mode fine.
- Android: with no PDF viewer (as phones report), a PDF downloads under its
  name with no blank tab and the app stays put; with a viewer it opens a tab.
- A sheet opened by code gets its Back step on the next tap; Back then closes
  it. If that tap is the sheet's own ✕, the step is taken off again.
- Speed, production build, Chrome slowed 4×: opening and closing sheets
  is smooth in all three styles (0–1 long frames). Each screen change has
  1–3 long frames (worst 100–225 ms) in every style, Classic included, with
  Atelier and Lite a little heavier than Classic. A real phone has to confirm.
- Atelier on phones: Contacts and calendar sheets still blurred the screen
  behind them (an inline style beat the phone rule). Fixed; Classic unchanged.
- Local only: this WebKit build won't send the Secure file cookie to
  http://localhost, so photos 401 there. Production is https; not an app bug.

## Not fixed yet

- [ ] **Atelier hover lift** (computers only) still animates a large shadow.
      Cheap on desktop; making it cheaper means changing how every card is
      positioned. Left on purpose.

Done 2026-11-04: `CatalogDetailModal` deleted; code-opened sheets get a Back
step on the next tap; flaky rate-limit tests fixed (wrangler's local limiter
resets every clock minute, so a burst crossing one was never refused; the
tests now start a burst early in a minute); the account email test ignores
the earlier tests' late "email was changed" notices.

## How to test locally

`npm run dev:local` in `frontend/` (test logins are printed when it starts).
Phone size: Chrome DevTools device mode, or a narrow window. Back: the browser's
Back button, not `history.back()` (Chrome treats them differently).
