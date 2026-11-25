# Meetings

Record a meeting (or type it), get it transcribed, summarized for its type
(Reporting, Brainstorm, Brief, Notes) and translated. Code: `frontend/meetings.ts`
(server), `frontend/meetingRules.ts` (checks + AI instructions),
`frontend/views/MeetingsView.tsx` (screen).

## Who gets it

1. **Per organization:** off by default. In admin.ateliersupport.com → the
   organization → *Plan and limits* → **Turn Meetings on** (an audited override).
   A plan can also include it: the plan editor shows a *Meetings* module.
   It takes effect within a minute.
2. **Per role, inside the app:** Admin → Roles → *Meetings*:
   **None** (hidden), **Read** (see meetings), **Record** (add, edit, delete, run AI).
   Admins always have Record. Staff starts at None.

## Choosing the AI

**Now (trial, 2026-11-25):** OpenAI `whisper-1` for speech-to-text and `gpt-4o-mini`
as a stand-in for summaries and translation, set in `wrangler.jsonc`. Only the
key is left: `wrangler secret put MEETING_AI_KEY` (prod), `MEETING_AI_KEY=` in
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

- Recordings: up to 90 minutes at 32 kbps (~22 MB); transcription takes one file up to 25 MB.
- 500 meetings per workspace; AI calls share the "costly" rate limit (30 a minute per person).
- No per-org monthly AI allowance yet: usage is only capped by the rate limit.
