# Meetings

Record a meeting (or upload a recording, or type it). While recording, audio
is saved and transcribed every 3 minutes (live text, nothing lost if the tab
closes). Then: a summary for its type (Reporting, Brainstorm, Brief, Notes),
action items (tick off, add to Tasks), who said what (AI, from the words;
rename speakers), questions about one meeting or all of them, translation, and
sharing (share sheet, WhatsApp, email to attendees, print/PDF).

Code: `frontend/meetings.ts` (server), `frontend/meetingRules.ts` (checks + AI
instructions), `frontend/views/MeetingsView.tsx` + `frontend/views/meetings/` (screens).

## Who gets it

1. **Per organization:** off by default. In admin.ateliersupport.com → the
   organization → *Plan and limits* → **Turn Meetings on** (an audited override).
   A plan can also include it: the plan editor shows a *Meetings* module.
   It takes effect within a minute.
2. **Per role, inside the app:** Admin → Roles → *Meetings*:
   **None** (hidden), **Read** (see meetings), **Record** (add, edit, delete, run AI).
   Admins always have Record. Staff starts at None.

## Choosing the AI

**Now (trial, 2026-11-25):** OpenRouter (`https://openrouter.ai/api/v1`): `openai/whisper-large-v3`
for speech-to-text and `openai/gpt-4o-mini` as a stand-in for summaries, action items,
speakers, questions and translation, set in `wrangler.jsonc`. Any OpenRouter model id
works (e.g. `anthropic/claude-sonnet-4.5` for better summaries). The key (an OpenRouter key) is left: `wrangler secret put MEETING_AI_KEY` (prod), `MEETING_AI_KEY=` in
`frontend/.dev.vars` (local).

Any OpenAI-compatible service works. Set these on the API Worker:

| Setting | What |
|---|---|
| `MEETING_AI_URL` | Base URL, e.g. `https://api.openai.com/v1` or `https://api.anthropic.com/v1` |
| `MEETING_AI_KEY` | Secret: `wrangler secret put MEETING_AI_KEY` |
| `MEETING_TEXT_MODEL` | Model for summaries and translation |
| `MEETING_TRANSCRIBE_MODEL` | Speech-to-text model |
| `MEETING_TRANSCRIBE_URL`, `MEETING_TRANSCRIBE_KEY` | Optional: speech-to-text from a different service (e.g. Claude for text, which has no speech-to-text) |

Until they are set, meetings still record and save; the AI buttons say AI isn't set up.

## Limits

- Recordings: up to 4 hours, in 3-minute parts (~1 MB each at 32 kbps). Uploaded
  files over 25 MB are decoded in the browser and split into 10-minute WAV parts
  (a phone may run out of memory on files several hours long).
- 500 meetings per workspace. AI calls share the "costly" rate limit (30 a minute per person).
- Asking across meetings reads the 6 meetings whose words best match the question.
- "Who said what" guesses from the words (names used, replies), not from voices.
- No per-org monthly AI allowance yet: usage is only capped by the rate limit.
