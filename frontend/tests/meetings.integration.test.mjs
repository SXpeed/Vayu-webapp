// Meetings against a real local Worker and a fake OpenAI-compatible AI
// service: the checks, role access (Staff starts closed; view reads, edit
// records and runs AI), recordings must be your own upload, and the AI steps.
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

let worker, ai, owner, staff, reader, recorder;
const aiCalls = [];

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

before(async () => {
    // The fake AI: speech-to-text, and chat that says which job it was given.
    ai = createServer((req, res) => {
        const parts = [];
        req.on('data', c => parts.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(parts).toString('latin1');
            aiCalls.push({ path: req.url, auth: req.headers.authorization, raw });
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: 'Priya: sales were four lakh this week.' }));
            const { model, messages } = JSON.parse(raw);
            const job = messages[0].content.startsWith('Translate') ? 'translation' : 'summary';
            res.end(JSON.stringify({ choices: [{ message: { content: `${job} by ${model}` } }] }));
        });
    });
    await new Promise(r => ai.listen(0, '127.0.0.1', r));
    const aiUrl = `http://127.0.0.1:${ai.address().port}/v1`;

    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({
        adminPassword: 'provider-admin-password', seedLegacy: { sql: schema },
        vars: { MEETING_AI_URL: aiUrl, MEETING_AI_KEY: 'test-key', MEETING_TEXT_MODEL: 'text-model', MEETING_TRANSCRIBE_MODEL: 'speech-model' },
    });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    const readRole = (await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Meeting readers', permissions: { meetings: 'view' } } })).body.id;
    const recordRole = (await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Meeting recorders', permissions: { meetings: 'edit' } } })).body.id;
    staff = await person('Priya Mehta', 'priya@example.com');
    reader = await person('Neha Patel', 'neha@example.com', readRole);
    recorder = await person('Kabir Rao', 'kabir@example.com', recordRole);
});

after(async () => { await worker?.stop(); worker?.cleanup(); ai?.close(); });

test('the checks on a meeting, and the AI instructions per type', () => {
    assert.deepEqual(rules.parseMeeting({ type: 'brief', heldAt: 1000, transcript: 'x' }), { type: 'brief', title: 'Brief meeting', heldAt: 1000, transcript: 'x', summary: '' });
    for (const bad of [{ type: 'party' }, { type: 'notes', title: 'x'.repeat(201) }, { type: 'notes', transcript: 'x'.repeat(200_001) }]) {
        assert.ok('problem' in rules.parseMeeting(bad), JSON.stringify(bad).slice(0, 60));
    }
    const systems = rules.MEETING_TYPES.map(t => rules.summaryMessages(t.id, 'T', 'said')[0].content);
    assert.equal(new Set(systems).size, 4); // each type asks for its own layout
    assert.ok(systems.every(s => s.includes('Never invent')));
});

test('Staff starts closed; view reads; edit records', async () => {
    assert.equal((await api(null, '/meetings')).status, 401);
    assert.equal((await api(staff, '/meetings')).status, 403);
    assert.equal((await api(reader, '/meetings')).status, 200);
    assert.equal((await api(reader, '/meetings', { method: 'POST', body: { type: 'notes', transcript: 'hi' } })).status, 403);

    const typed = await api(recorder, '/meetings', { method: 'POST', body: { type: 'brainstorm', title: 'Monsoon show', transcript: 'Ideas: rain theme' } });
    assert.equal(typed.status, 201, typed.text);
    assert.equal(typed.body.createdByName, 'Kabir Rao');
    assert.equal((await api(recorder, '/meetings', { method: 'POST', body: { type: 'notes' } })).status, 400); // nothing recorded or typed

    const list = await api(reader, '/meetings');
    assert.ok(list.body.meetings.some(m => m.id === typed.body.id));
    assert.deepEqual(list.body.ai, { text: true, transcribe: true });
    assert.equal((await api(reader, `/meetings/${typed.body.id}/summarize`, { method: 'POST', body: {} })).status, 403);
    assert.equal((await api(reader, `/meetings/${typed.body.id}`, { method: 'DELETE' })).status, 403);
});

test('a recording must be your own upload', async () => {
    const ownersFile = await uploadAudio(owner);
    const res = await api(recorder, '/meetings', { method: 'POST', body: { type: 'notes', audioKey: ownersFile } });
    assert.equal(res.status, 400);
    assert.equal((await api(recorder, '/meetings', { method: 'POST', body: { type: 'notes', audioKey: 'uploads/../x' } })).status, 400);
});

test('record, transcribe, summarize, translate, delete', async () => {
    const key = await uploadAudio(recorder);
    const made = await api(recorder, '/meetings', { method: 'POST', body: { type: 'reporting', audioKey: key, durationSec: 312 } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.body.audioType, 'audio/webm');
    assert.equal(made.body.durationSec, 312);
    const id = made.body.id;

    assert.equal((await api(recorder, `/meetings/${id}/summarize`, { method: 'POST', body: {} })).status, 400); // no text yet
    const heard = await api(recorder, `/meetings/${id}/transcribe`, { method: 'POST', body: {} });
    assert.equal(heard.status, 200, heard.text);
    assert.equal(heard.body.transcript, 'Priya: sales were four lakh this week.');
    const call = aiCalls.find(c => c.path === '/v1/audio/transcriptions');
    assert.equal(call.auth, 'Bearer test-key');
    assert.ok(call.raw.includes('speech-model') && call.raw.includes('meeting.webm'));

    const sum = await api(recorder, `/meetings/${id}/summarize`, { method: 'POST', body: {} });
    assert.equal(sum.body.summary, 'summary by text-model');
    const chatCall = JSON.parse(aiCalls.at(-1).raw);
    assert.ok(chatCall.messages[0].content.includes('reporting meeting'));
    assert.ok(chatCall.messages[1].content.includes('four lakh'));

    assert.equal((await api(recorder, `/meetings/${id}/translate`, { method: 'POST', body: { lang: 'Klingon' } })).status, 400);
    const tr = await api(recorder, `/meetings/${id}/translate`, { method: 'POST', body: { lang: 'Hindi' } });
    assert.equal(tr.status, 200, tr.text);
    assert.deepEqual([tr.body.translation, tr.body.translationLang], ['translation by text-model', 'Hindi']);
    assert.ok(JSON.parse(aiCalls.at(-1).raw).messages[0].content.includes('into Hindi'));

    const edited = await api(recorder, `/meetings/${id}`, { method: 'PUT', body: { ...tr.body, summary: 'Fixed by hand' } });
    assert.equal(edited.body.summary, 'Fixed by hand');
    assert.equal(edited.body.translation, 'translation by text-model'); // an edit keeps the AI's other work

    assert.equal((await api(recorder, `/meetings/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(owner, `/files/${encodeURIComponent(key)}`)).status, 404); // the recording went with it
    assert.equal((await api(recorder, `/meetings/${id}`, { method: 'DELETE' })).status, 404);
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
    // A fresh sign-in skips this isolate's one-minute plan memo.
    const later = worker.browser();
    assert.equal((await later.signIn('mtg-owner@example.com', 'member password 123')).status, 200);
    let on;
    for (let i = 0; i < 70 && on?.status !== 200; i++) {
        on = await later.call(app('/meetings'));
        if (on.status !== 200) await new Promise(r => setTimeout(r, 1000));
    }
    assert.equal(on.status, 200, on.text);
});
