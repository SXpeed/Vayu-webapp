// The assistant against a real local Worker and a fake OpenAI-compatible AI
// service: who may ask, the lookups a role allows (and the ones it doesn't),
// the answer after the lookups, and spoken questions.
//
//   node --test frontend/tests/assistant.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
let worker, ai, owner, staff, reader;
const chats = [];
/** The lookups the fake model asks for first: [name, arguments]. */
let wanted = [];

async function api(token, path, { method = 'GET', body, raw, type } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (type) headers.set('Content-Type', type);
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
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

/** The fake model: first asks for two lookups, then answers with what came back. */
function reply(messages) {
    const tools = messages.filter(m => m.role === 'tool');
    if (!tools.length) {
        return { role: 'assistant', content: null, tool_calls: wanted.map(([name, args], i) => ({ id: `c${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
    }
    return { role: 'assistant', content: `found: ${tools.map(t => t.content).join(' | ')}` };
}

before(async () => {
    ai = createServer((req, res) => {
        const parts = [];
        req.on('data', c => parts.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(parts).toString('latin1');
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: ` status of Priya's inquiry ${raw.includes('question.webm') ? 'webm' : '?'} ` }));
            const body = JSON.parse(raw);
            chats.push(body);
            res.end(JSON.stringify({ choices: [{ message: reply(body.messages) }] }));
        });
    });
    await new Promise(r => ai.listen(0, '127.0.0.1', r));
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({
        adminPassword: 'provider-admin-password', seedLegacy: { sql: schema },
        vars: { MEETING_AI_URL: `http://127.0.0.1:${ai.address().port}/v1`, MEETING_AI_KEY: 'test-key', MEETING_TEXT_MODEL: 'text-model', MEETING_TRANSCRIBE_MODEL: 'speech-model' },
    });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    // Can ask, and read inquiries, but not the inventory.
    const role = (await api(owner, '/auth/roles', { method: 'POST', body: { name: 'Askers', permissions: { meetings: 'view', inquiries: 'view' } } })).body.id;
    staff = await person('Priya Mehta', 'priya@example.com');
    reader = await person('Neha Patel', 'neha@example.com', role);
    const inq = { id: 'inq_1', inquiryNumber: 'INQ-7', customerName: 'Priya Shah', customerPhone: '9800000000', customerEmail: '', artworkIds: [], notes: 'Wants the blue print', source: 'Walk-in', status: 'New', catalogShared: false, date: Date.UTC(2026, 10, 20) };
    assert.equal((await api(owner, '/inquiries', { method: 'POST', body: inq })).status, 201);
});

after(async () => { await worker?.stop(); worker?.cleanup(); ai?.close(); });

test('who may ask', async () => {
    assert.equal((await api(null, '/assistant/ask', { method: 'POST', body: { question: 'hi' } })).status, 401);
    assert.equal((await api(staff, '/assistant/ask', { method: 'POST', body: { question: 'hi' } })).status, 403); // Staff starts without meetings
    assert.equal((await api(reader, '/assistant/ask', { method: 'POST', body: { question: '  ' } })).status, 400);
});

test('lookups follow the role, and the answer uses what they found', async () => {
    chats.length = 0;
    wanted = [['find_inquiries', { query: 'Priya' }], ['find_artworks', { query: 'Raza' }]];
    const res = await api(reader, '/assistant/ask', { method: 'POST', body: { question: "Status of Priya's inquiry?", history: [{ q: 'earlier', a: 'before' }] } });
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.answer, /INQ-7/);
    assert.match(res.body.answer, /Wants the blue print/);
    assert.match(res.body.answer, /role can't see/); // find_artworks was refused
    const first = chats[0];
    assert.deepEqual(first.tools.map(t => t.function.name), ['find_inquiries', 'meetings', 'my_expenses', 'my_notes']);
    assert.match(first.messages[0].content, /can't see: .*inventory/);
    assert.deepEqual(first.messages.slice(1, 3).map(m => m.content), ['earlier', 'before']);

    // The owner gets every lookup; the inventory has nothing yet.
    chats.length = 0;
    const all = await api(owner, '/assistant/ask', { method: 'POST', body: { question: 'Raza?' } });
    assert.equal(all.status, 200, all.text);
    assert.equal(chats[0].tools.length, 17);
    assert.match(all.body.answer, /\| \[\]$/);
});

test("the app's own read requests run as the person asking", async () => {
    assert.equal((await api(reader, '/notes', { method: 'POST', body: { title: 'Framer', body: 'Call Ravi about the gold frame' } })).status, 201);
    chats.length = 0;
    wanted = [['my_notes', {}], ['attendance', { from: '2026-11-01', to: '2026-11-30' }]];
    const res = await api(reader, '/assistant/ask', { method: 'POST', body: { question: 'my notes?' } });
    assert.equal(res.status, 200, res.text);
    assert.match(res.body.answer, /Call Ravi about the gold frame/);
    assert.match(res.body.answer, /role can't see/); // no attendance section
    // The owner's notes are the owner's: the reader's note isn't there.
    wanted = [['my_notes', {}], ['attendance', { from: '2026-11-01', to: '2026-11-30' }], ['staff_roster', { from: '2026-11-23', to: '2026-11-29' }]];
    const own = await api(owner, '/assistant/ask', { method: 'POST', body: { question: 'notes, attendance and roster' } });
    assert.equal(own.status, 200, own.text);
    assert.doesNotMatch(own.body.answer, /gold frame/);
    assert.match(own.body.answer, /"canManage":true/);
    assert.doesNotMatch(own.body.answer, /error/);
});

test('spoken questions', async () => {
    const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const heard = await api(reader, '/assistant/transcribe', { method: 'POST', raw: audio, type: 'audio/webm;codecs=opus' });
    assert.equal(heard.status, 200, heard.text);
    assert.equal(heard.body.text, "status of Priya's inquiry webm");
    assert.equal((await api(reader, '/assistant/transcribe', { method: 'POST', raw: 'hello', type: 'text/plain' })).status, 415);
    assert.equal((await api(reader, '/assistant/transcribe', { method: 'POST', raw: new Uint8Array(), type: 'audio/webm' })).status, 400);
});
