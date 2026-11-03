# UI follow-ups: to fix, and to test

Open items from the November 2026 UI work (Back button, downloads, file opening,
photo viewer, Atelier/Lite motion). Everything below shipped except where it says
"not fixed". Tick items off here as they are done.

## Not tested yet (needs a real device)

- [ ] **iPhone, installed app: saving files.** Billing PDF, catalog PDF, chat photo,
      CSV exports. Expected: the share sheet opens ("Save to Files" / "Save Image").
      If Safari refuses the sheet after a slow build or fetch, a "Tap to save …"
      toast appears and tapping it opens the sheet. Check the toast actually shows.
- [ ] **iPhone: full-screen photo size.** Chat photo and artwork photo at the
      Default UI size. Expected: centred, same gap left and right, not cropped.
      The fix measures the page zoom the way the browser reports sizes; Safari
      may report them differently from Chrome. Tested in Chrome only.
- [ ] **iPhone: "Discard your changes?" on Back** in Contacts (iOS swipe-back).
- [ ] **Android, installed app: hardware Back** closes sheets and dialogs one at a
      time, then leaves the screen. Tested with desktop Chrome's Back button (same
      rules), not on a phone.
- [ ] **Android: PDFs.** Chat file PDF and catalog "open PDF" should download
      (phones have no built-in PDF viewer), not open a blank tab.
- [ ] **Phone performance.** Page changes in Atelier and Lite on a mid-range
      Android phone: no dropped frames when changing screens or opening sheets.
      Atelier on phones no longer blurs; check it still looks right.
- [ ] **Lite on a phone:** taps, the dock pill and sheets animate; colour and
      shadow changes snap.

## Tested (local copy, Chrome desktop + headless phone size)

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

## Not fixed yet

- [ ] **Delete `CatalogDetailModal`** in `frontend/views/CatalogsView.tsx`: unused,
      about 150 lines. Waiting for an OK.
- [ ] **Atelier hover lift** (computers only) still animates a large shadow.
      Cheap on desktop; making it cheaper means changing how every card is
      positioned. Left on purpose.
- [ ] **Back step left behind** when a sheet opens with no tap (code-opened): it
      gets no Back step, so Back leaves the screen instead of closing it. Rare.
- [ ] **One server test is flaky** under a full run: "costly routes are limited per
      person" (tests/rateLimits.integration.test.mjs) timed out once at 5 s and
      passed twice alone.

## How to test locally

`npm run dev:local` in `frontend/` (test logins are printed when it starts).
Phone size: Chrome DevTools device mode, or a narrow window. Back: the browser's
Back button, not `history.back()` (Chrome treats them differently).
