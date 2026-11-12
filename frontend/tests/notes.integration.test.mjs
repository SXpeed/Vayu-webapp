// My Notes against a real local Worker: each person writes, lists, changes and
// deletes their own notes, the checks on what is saved, and privacy (nobody
// else, an admin included, can read, change or delete someone's note).
//
//   node --test frontend/tests/notes.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';
import { load } from './helpers/load.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };
const rules = await load('noteRules.ts');

let worker;
let owner;
let staff;
let neha;

async function api(token, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: withSessionToken(json, res), text };
}

async function person(name, email) {
    const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: 'staff-password-1234' } });
    assert.ok(res.status === 200 || res.status === 201, res.text);
    const login = await api(null, '/auth/login', { method: 'POST', body: { email, password: 'staff-password-1234' } });
    assert.equal(login.status, 200, login.text);
    return login.body.token;
}

const idea = { title: 'Show ideas', body: 'Monsoon group show\nAsk the framer about prices', pinned: false };

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ adminPassword: 'provider-admin-password', seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    staff = await person('Priya Mehta', 'priya@example.com');
    neha = await person('Neha Patel', 'neha@example.com');
});

after(async () => { await worker?.stop(); worker?.cleanup(); });

test('the checks on a note', () => {
    assert.deepEqual(rules.parseNote(idea), idea);
    assert.deepEqual(rules.parseNote({ body: 'just text' }), { title: '', body: 'just text', pinned: false });
    assert.equal(rules.parseNote({ ...idea, title: '  trimmed  ' }).title, 'trimmed');
    assert.equal(rules.parseNote({ ...idea, pinned: 'yes' }).pinned, false);
    assert.equal(rules.parseNote({ ...idea, body: 'x'.repeat(20_000) }).body.length, 20_000);
    for (const bad of [{ title: '', body: '  \n ' }, { title: 'x'.repeat(201) }, { body: 'x'.repeat(20_001) }]) {
        assert.ok('problem' in rules.parseNote({ ...idea, ...bad }), JSON.stringify(bad).slice(0, 60));
    }
    assert.ok('problem' in rules.parseNote(null));
});

test('you write, list, change and delete your own notes', async () => {
    assert.equal((await api(null, '/notes')).status, 401);
    const made = await api(staff, '/notes', { method: 'POST', body: idea });
    assert.equal(made.status, 201, made.text);
    const second = await api(staff, '/notes', { method: 'POST', body: { title: '', body: 'Call the courier' } });
    assert.equal(second.status, 201, second.text);
    assert.equal((await api(staff, '/notes', { method: 'POST', body: { title: '', body: '' } })).status, 400);

    let list = (await api(staff, '/notes')).body.notes;
    assert.deepEqual(list.map(n => n.id), [second.body.id, made.body.id]); // newest first

    const pinned = await api(staff, `/notes/${made.body.id}`, { method: 'PUT', body: { ...idea, pinned: true } });
    assert.equal(pinned.status, 200, pinned.text);
    assert.equal(pinned.body.createdAt, made.body.createdAt);
    list = (await api(staff, '/notes')).body.notes;
    assert.deepEqual(list.map(n => [n.id, n.pinned]), [[made.body.id, true], [second.body.id, false]]); // pinned on top
    assert.equal(list[0].body, idea.body);

    assert.equal((await api(staff, `/notes/${second.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await api(staff, `/notes/${second.body.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api(staff, `/notes/${second.body.id}`, { method: 'PUT', body: idea })).status, 404);
    assert.equal((await api(staff, '/notes')).body.notes.length, 1);
});

test('nobody else reads, changes or deletes your note, admins included', async () => {
    const mine = (await api(neha, '/notes', { method: 'POST', body: { ...idea, body: 'Neha only' } })).body;
    for (const other of [owner, staff]) {
        assert.ok(!(await api(other, '/notes')).body.notes.some(n => n.id === mine.id));
        assert.equal((await api(other, `/notes/${mine.id}`, { method: 'PUT', body: idea })).status, 404);
        assert.equal((await api(other, `/notes/${mine.id}`, { method: 'DELETE' })).status, 404);
    }
    const still = (await api(neha, '/notes')).body.notes;
    assert.deepEqual(still.map(n => [n.id, n.body]), [[mine.id, 'Neha only']]);
});
