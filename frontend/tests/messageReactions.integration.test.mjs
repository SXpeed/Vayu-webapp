// Chat read receipts per person and reactions, against a real local Worker.
// Starts from the messages table as production has it (without read_by and
// reactions), so the columns are added on the fly as there.
//
//   node --test frontend/tests/messageReactions.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const PASSWORD = 'staff-password-1234';

let worker;
let owner;      // admin, in the group, sends the message
let outsider;   // admin, never in the group
let alice;      // staff, in the group
let bob;        // staff, in the group

async function api(user, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (user) headers.set('Authorization', `Bearer ${user.token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: withSessionToken(json, res), text };
}

async function login(email, password) {
    const res = await api(null, '/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(res.status, 200, `login ${email}: ${res.text}`);
    return { token: res.body.token, id: res.body.user.id };
}

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
        .split('\n').filter(line => !/^ *(read_by|reactions) TEXT/.test(line))
        // The column before them is now the last one: drop its comma.
        .join('\n').replace(/,(\s*\r?\n\);)/g, '$1');
    assert.ok(!/read_by|reactions/.test(schema), 'old schema');
    worker = await startDevWorker({ seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = await login(OWNER.email, OWNER.password);
    for (const [name, email, role] of [['Outsider', 'outsider@example.com', 'admin'], ['Alice', 'alice@example.com'], ['Bob', 'bob@example.com']]) {
        const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: PASSWORD, ...(role ? { role } : {}) } });
        assert.ok(res.status === 200 || res.status === 201, res.text);
    }
    outsider = await login('outsider@example.com', PASSWORD);
    alice = await login('alice@example.com', PASSWORD);
    bob = await login('bob@example.com', PASSWORD);
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

/** A group of owner, Alice and Bob with one message from the owner. */
async function groupWithMessage() {
    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const conv = await api(owner, '/conversations', {
        method: 'POST',
        body: {
            id: conversationId, participantIds: [owner.id, alice.id, bob.id], participantNames: ['Owner', 'Alice', 'Bob'],
            lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0, isGroup: true, groupName: 'Team',
        },
    });
    assert.equal(conv.status, 201, conv.text);
    const message = { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, conversationId, text: 'New stock is in', tags: [], timestamp: Date.now(), status: 'sent' };
    assert.equal((await api(owner, '/messages', { method: 'POST', body: message })).status, 201);
    return message;
}

async function fetchMessage(user, message) {
    const res = await api(user, `/messages?conversationId=${encodeURIComponent(message.conversationId)}`);
    assert.equal(res.status, 200, res.text);
    return res.body.find(m => m.id === message.id);
}

const read = (user, ids) => api(user, '/messages/status-batch', { method: 'PUT', body: { messageIds: ids, status: 'read' } });
const react = (user, id, emoji) => api(user, `/messages/${encodeURIComponent(id)}/reaction`, { method: 'PUT', body: { emoji } });

test('each member who reads a message is recorded once, with the time', async () => {
    const message = await groupWithMessage();
    assert.equal((await fetchMessage(owner, message)).readBy, undefined);

    assert.equal((await read(alice, [message.id])).status, 200);
    const afterAlice = await fetchMessage(owner, message);
    assert.deepEqual(Object.keys(afterAlice.readBy), [alice.id]);
    assert.equal(afterAlice.status, 'read');
    const aliceAt = afterAlice.readBy[alice.id];

    // The sender reading their own message, a repeat read, and an admin
    // looking in from outside the group are not recorded.
    await read(owner, [message.id]);
    await read(alice, [message.id]);
    await read(outsider, [message.id]);
    await read(bob, [message.id]);
    const after = await fetchMessage(owner, message);
    assert.deepEqual(Object.keys(after.readBy).sort(), [alice.id, bob.id].sort());
    assert.equal(after.readBy[alice.id], aliceAt, 'first read time kept');
});

test('one reaction per person: set, replace, remove; members only', async () => {
    const message = await groupWithMessage();

    const first = await react(alice, message.id, '👍');
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.body.reactions, { [alice.id]: '👍' });

    assert.equal((await react(bob, message.id, '❤️')).status, 200);
    assert.equal((await react(alice, message.id, '😂')).status, 200);
    assert.deepEqual((await fetchMessage(owner, message)).reactions, { [alice.id]: '😂', [bob.id]: '❤️' });

    const removed = await react(alice, message.id, null);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.reactions, { [bob.id]: '❤️' });

    assert.equal((await react(outsider, message.id, '👍')).status, 403);
    assert.equal((await react(alice, message.id, 'hello')).status, 400);
    assert.equal((await react(alice, 'msg_missing', '👍')).status, 404);
});

test('sending a message again keeps its reads and reactions', async () => {
    const message = await groupWithMessage();
    await read(alice, [message.id]);
    await react(bob, message.id, '🙏');
    // A device re-sending its copy (retry, migration) must not wipe them.
    assert.equal((await api(owner, '/messages', { method: 'POST', body: { ...message, text: 'New stock is in!' } })).status, 201);
    const after = await fetchMessage(owner, message);
    assert.equal(after.text, 'New stock is in!');
    assert.deepEqual(Object.keys(after.readBy), [alice.id]);
    assert.deepEqual(after.reactions, { [bob.id]: '🙏' });
});
