// Meetings against a real local Worker and a fake OpenAI-compatible AI
// service: the checks, role access (Staff starts closed; view reads and asks,
// edit records and runs AI), recordings in parts (live text, order, retries,
// your own uploads only), summary + action items, who said what, questions
// about one meeting or all of them, translation, deleting, and the per-org switch.
//
//   node --test frontend/tests/meetings.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const rules = await load('meetingRules.ts');
const recorder = await load('views/meetings/recorder.ts');
const tasks = await load('views/meetings/tasks.ts');

let worker, ai, owner, staff, reader, kabir;
const aiCalls = [];
let heard = 0;

async function api(token, path, { method = 'GET', body, form } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: withSessionToken(json, res), text };
}

async function person(name, email, role) {
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234', ...(role ? { role } : {}) } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    return (await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } })).body.token;
}

async function uploadAudio(token) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type: 'audio/webm' }), 'meeting.webm');
    const res = await api(token, '/upload', { method: 'POST', form });
    assert.equal(res.status, 200, res.text);
    return res.body.key;
}

/** What the fake chat model says, by the job its instructions give it. */
function chatReply(messages, model) {
    const system = messages[0].content;
    const last = messages.at(-1).content;
    if (system.startsWith('Translate')) return `translation by ${model}`;
    if (system.includes('JSON array')) return 'Here you go:\n```json\n[{"text":"Send the framer the quote","owner":"Priya Mehta","due":"2026-12-01"},{"text":"","owner":"x"}]\n```';
    if (system.includes('Speaker: what they said')) return `Priya Mehta: ${last.split('\n').at(-1)}`;
    if (system.startsWith('Answer questions')) return `answer to: ${last}`;
    return `summary by ${model}`;
}

before(async () => {
    ai = createServer((req, res) => {
        const parts = [];
        req.on('data', c => parts.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(parts).toString('latin1');
            aiCalls.push({ path: req.url, auth: req.headers.authorization, raw });
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/v1/audio/transcriptions') {
                heard += 1;
                return res.end(JSON.stringify({ text: `Part ${heard}: sales were four lakh.` }));
            }
            const { model, messages } = JSON.parse(raw);
            res.end(JSON.stringify({ choices: [{ message: { content: chatReply(messages, model) } }] }));
        });
    });
    await new Promise(r => ai.listen(0, '127.0.0.1', r));
    const aiUrl = `http://127.0.0.1:${ai.address().port}/v1/`; // a trailing slash is fine

    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({
        adminPassword: 'provider-admin-password', seedLegacy: { sql: schema },
        vars: { MEETING_AI_URL: aiUrl, MEETING_AI_KEY: 'test-key', MEETING_TEXT_MODEL: 'text-model', MEETING_SUMMARY_MODEL: 'summary-model', MEETING_TRANSCRIBE_MODEL: 'speech-model' },
    });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    const readRole = (await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Meeting readers', permissions: { meetings: 'view' } } })).body.id;
    const recordRole = (await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Meeting recorders', permissions: { meetings: 'edit' } } })).body.id;
    staff = await person('Priya Mehta', 'priya@example.com');
    reader = await person('Neha Patel', 'neha@example.com', readRole);
    kabir = await person('Kabir Rao', 'kabir@example.com', recordRole);
});

after(async () => { await worker?.stop(); worker?.cleanup(); ai?.close(); });

test('the checks, and the helpers the screens use', () => {
    const m = rules.parseMeeting({ type: 'brief', heldAt: 1000, transcript: 'x', attendees: [{ id: 'u1', name: 'Priya' }, { id: 'u1', name: 'Dup' }, { id: '', name: 'No id' }] });
    assert.equal(m.title, 'Brief meeting');
    assert.deepEqual(m.attendees, [{ id: 'u1', name: 'Priya' }]);
    for (const bad of [{ type: 'party' }, { type: 'notes', title: 'x'.repeat(201) }, { type: 'notes', transcript: 'x'.repeat(400_001) }]) {
        assert.ok('problem' in rules.parseMeeting(bad), JSON.stringify(bad).slice(0, 60));
    }
    const systems = rules.MEETING_TYPES.map(t => rules.summaryMessages(t.id, 'T', 'said')[0].content);
    assert.equal(new Set(systems).size, 4); // each type asks for its own layout

    assert.deepEqual(rules.parseActionItems('nope'), []);
    assert.deepEqual(rules.parseActionItems('```json\n[{"text":"Call","owner":"A","due":"Friday"}]```'), [{ id: 'a1', text: 'Call', owner: 'A', due: '', done: false }]);

    const long = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = rules.chunkText(long, 200);
    assert.ok(chunks.every(c => c.length <= 200 && c.endsWith('.')));
    assert.equal(chunks.join(' '), long);

    const t = 'Speaker 1: hi\nPriya: hello\nSpeaker 1: bye';
    assert.deepEqual(rules.speakersIn(t), ['Speaker 1', 'Priya']);
    assert.equal(rules.renameSpeaker(t, 'Speaker 1', 'Kabir'), 'Kabir: hi\nPriya: hello\nKabir: bye');

    const ms = [{ title: 'Pricing', summary: 'monsoon show prices', transcript: '', heldAt: 1 }, { title: 'Other', summary: 'framing', transcript: '', heldAt: 2 }];
    assert.deepEqual(rules.pickRelevant(ms, 'What about the monsoon prices?', 5).map(x => x.title), ['Pricing']);
    assert.deepEqual(rules.pickRelevant(ms, 'hi', 5), []);
});

test('WAV parts are valid, and action items become Tasks', async () => {
    const wav = recorder.encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    assert.equal(bytes.length, 44 + 8);
    assert.equal(String.fromCodePoint(...bytes.slice(0, 4)), 'RIFF');
    assert.equal(new DataView(bytes.buffer).getInt16(46, true), 0x7fff);

    const m = { title: 'Show', type: 'notes', heldAt: 5, actionItems: [{ id: 'a1', text: 'Call', owner: 'priya mehta ', due: '2026-12-01', done: false }, { id: 'a2', text: 'Done', owner: '', due: '', done: true }] };
    const ev = tasks.tasksEventFor(m, [{ id: 'u9', name: 'Priya Mehta' }], 7);
    assert.equal(ev.title, 'Follow-ups: Show');
    assert.deepEqual(ev.todos, [{ id: 'todo_7_0', text: 'Call', done: false, createdAt: 7, due: '2026-12-01', assigneeId: 'u9', assigneeName: 'Priya Mehta' }]);
});

test('Staff starts closed; view reads and asks; edit records', async () => {
    assert.equal((await api(null, '/meetings')).status, 401);
    assert.equal((await api(staff, '/meetings')).status, 403);
    assert.equal((await api(reader, '/meetings')).status, 200);
    assert.equal((await api(reader, '/meetings', { method: 'POST', body: { type: 'notes', transcript: 'hi' } })).status, 403);

    const typed = await api(kabir, '/meetings', { method: 'POST', body: { type: 'brainstorm', title: 'Monsoon show', transcript: 'Ideas: rain theme for the monsoon show' } });
    assert.equal(typed.status, 201, typed.text);
    assert.equal(typed.body.status, 'ready');
    assert.equal((await api(kabir, '/meetings', { method: 'POST', body: { type: 'notes' } })).status, 400); // nothing recorded or typed

    const list = await api(reader, '/meetings');
    assert.deepEqual(list.body.ai, { text: true, transcribe: true });
    const asked = await api(reader, `/meetings/${typed.body.id}/ask`, { method: 'POST', body: { question: 'What theme?' } });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(asked.body.answer, 'answer to: What theme?');
    const all = await api(reader, '/meetings/ask', { method: 'POST', body: { question: 'What about the monsoon show?' } });
    assert.equal(all.status, 200, all.text);
    assert.ok(all.body.sources.some(s => s.id === typed.body.id));
    assert.equal((await api(reader, `/meetings/${typed.body.id}/summarize`, { method: 'POST', body: {} })).status, 403);
    assert.equal((await api(reader, `/meetings/${typed.body.id}/parts`, { method: 'POST', body: {} })).status, 403);
    assert.equal((await api(reader, `/meetings/${typed.body.id}`, { method: 'DELETE' })).status, 403);
});

test('a recording in parts: live text, in order, retries, your own uploads only', async () => {
    const start = await api(kabir, '/meetings', { method: 'POST', body: { type: 'reporting', recording: true, attendees: [{ id: 'u1', name: 'Priya Mehta' }] } });
    assert.equal(start.status, 201, start.text);
    assert.equal(start.body.status, 'recording');
    const id = start.body.id;

    const ownersFile = await uploadAudio(owner);
    assert.equal((await api(kabir, `/meetings/${id}/parts`, { method: 'POST', body: { audioKey: ownersFile, index: 0 } })).status, 400);

    const first = await uploadAudio(kabir);
    const one = await api(kabir, `/meetings/${id}/parts`, { method: 'POST', body: { audioKey: first, index: 0, durationSec: 180 } });
    assert.equal(one.status, 200, one.text);
    assert.match(one.body.transcript, /^Part \d+: sales/);
    const call = aiCalls.find(c => c.path === '/v1/audio/transcriptions');
    assert.equal(call.auth, 'Bearer test-key');
    assert.ok(call.raw.includes('speech-model') && call.raw.includes('meeting.webm'));

    const again = await api(kabir, `/meetings/${id}/parts`, { method: 'POST', body: { audioKey: first, index: 0, durationSec: 180 } });
    assert.equal(again.body.parts.length, 1); // a retry adds nothing
    const third = await uploadAudio(kabir);
    assert.equal((await api(kabir, `/meetings/${id}/parts`, { method: 'POST', body: { audioKey: third, index: 2 } })).status, 409); // part 1 missing
    const second = await uploadAudio(kabir);
    const two = await api(kabir, `/meetings/${id}/parts`, { method: 'POST', body: { audioKey: second, index: 1, durationSec: 95 } });
    assert.equal(two.body.parts.length, 2);
    assert.equal(two.body.durationSec, 275);
    assert.equal(two.body.transcript.split('\n').length, 2);

    const redo = await api(kabir, `/meetings/${id}/parts/0/transcribe`, { method: 'POST', body: {} });
    assert.equal(redo.status, 200, redo.text);
    assert.equal(redo.body.transcript.split('\n').length, 2);
    const done = await api(kabir, `/meetings/${id}/finish`, { method: 'POST', body: {} });
    assert.equal(done.body.status, 'ready');

    // Summary + action items, who said what, translation.
    const sum = await api(kabir, `/meetings/${id}/summarize`, { method: 'POST', body: {} });
    assert.equal(sum.status, 200, sum.text);
    assert.equal(sum.body.summary, 'summary by summary-model');
    assert.deepEqual(sum.body.actionItems, [{ id: 'a1', text: 'Send the framer the quote', owner: 'Priya Mehta', due: '2026-12-01', done: false }]);
    assert.ok(aiCalls.some(c => c.raw.includes('People in the meeting: Priya Mehta')));

    const who = await api(kabir, `/meetings/${id}/speakers`, { method: 'POST', body: { chunk: 0, known: [] } });
    assert.equal(who.status, 200, who.text);
    assert.equal(who.body.total, 1);
    assert.match(who.body.text, /^Priya Mehta: Part/);
    assert.equal((await api(kabir, `/meetings/${id}/speakers`, { method: 'POST', body: { chunk: 5 } })).status, 400);

    assert.equal((await api(kabir, `/meetings/${id}/translate`, { method: 'POST', body: { lang: 'Klingon' } })).status, 400);
    const tr = await api(kabir, `/meetings/${id}/translate`, { method: 'POST', body: { lang: 'Hindi' } });
    assert.deepEqual([tr.body.translation, tr.body.translationLang], ['translation by text-model', 'Hindi']);

    // Edits keep the AI's other work; ticking an item off is an edit.
    const items = sum.body.actionItems.map(a => ({ ...a, done: true }));
    const edited = await api(kabir, `/meetings/${id}`, { method: 'PUT', body: { ...tr.body, summary: 'Fixed by hand', actionItems: items, tasksEventId: 'added:1' } });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.body.summary, 'Fixed by hand');
    assert.equal(edited.body.actionItems[0].done, true);
    assert.equal(edited.body.tasksEventId, 'added:1');
    assert.equal(edited.body.translation, 'translation by text-model');

    assert.equal((await api(kabir, `/meetings/${id}`, { method: 'DELETE' })).status, 200);
    for (const key of [first, second]) assert.equal((await api(owner, `/files/${encodeURIComponent(key)}`)).status, 404); // the recording went with it
    assert.equal((await api(kabir, `/meetings/${id}`, { method: 'DELETE' })).status, 404);
});

test('an organization gets Meetings only once the platform admin turns them on', async () => {
    const admin = worker.browser();
    assert.equal((await admin.signIn('admin@example.com', 'provider-admin-password')).status, 200);
    assert.equal((await admin.call('/admin/users', { method: 'POST', body: { email: 'mtg-owner@example.com', name: 'Org Owner', temporaryPassword: 'member password 123' } })).status, 201);
    const org = (await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Meeting Org', businessType: 'studio', ownerEmail: 'mtg-owner@example.com' } })).body;
    const orgOwner = worker.browser();
    assert.equal((await orgOwner.signIn('mtg-owner@example.com', 'member password 123')).status, 200);
    const app = path => `/api/o/${org.id}${path}`;

    const off = await orgOwner.call(app('/meetings'));
    assert.equal(off.status, 403); // off by default, owner included
    assert.equal(off.body.code, 'module_off');
    assert.ok((await orgOwner.call(app('/auth/me'))).body.sectionsOff.includes('meetings'));

    assert.equal((await admin.call(`/admin/orgs/${org.id}/entitlements`, { method: 'POST', body: { key: 'meetings', value: true, reason: 'Pilot' } })).status, 200);
    const later = worker.browser();
    assert.equal((await later.signIn('mtg-owner@example.com', 'member password 123')).status, 200);
    let on;
    for (let i = 0; i < 70 && on?.status !== 200; i++) {
        on = await later.call(app('/meetings'));
        if (on.status !== 200) await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal(on.status, 200, on.text);
});
