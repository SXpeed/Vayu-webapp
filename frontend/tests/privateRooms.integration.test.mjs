// Private rooms (closed group conversations) against a real local Worker:
// who can create, see, use and manage one, and that admins outside a room
// get nothing: not the room, its messages, receipts, or an archive entry.
// Starts from the conversations table as production has it (without the
// private-room columns), so the columns are added on the fly as there.
//
//   node --test frontend/tests/privateRooms.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const PASSWORD = 'staff-password-1234';

let worker;
let owner;      // admin who creates the room
let other;      // admin who is never in it
let alice;      // staff member of the room
let mallory;    // staff, never in it

async function api(user, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (user) headers.set('Authorization', `Bearer ${user.token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
}

async function login(email, password) {
    const res = await api(null, '/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(res.status, 200, `login ${email}: ${res.text}`);
    return { token: res.body.token, id: res.body.user.id };
}

before(async () => {
    // Production's conversations table predates the private-room columns.
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
        .replace(/\n\s*is_private [^\n]*/, '').replace(/\n\s*created_by TEXT,\s*-- creator[^\n]*/, '');
    assert.ok(!/is_private/.test(schema.split('CREATE TABLE IF NOT EXISTS messages')[0]), 'old schema');
    worker = await startDevWorker({ port: 8818, inspectorPort: 9248, seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = await login(OWNER.email, OWNER.password);
    for (const [name, email, role] of [['Other admin', 'other@example.com', 'admin'], ['Alice', 'alice@example.com'], ['Mallory', 'mallory@example.com']]) {
        const res = await api(owner, '/auth/users', { method: 'POST', body: { name, email, password: PASSWORD, ...(role ? { role } : {}) } });
        assert.ok(res.status === 200 || res.status === 201, res.text);
    }
    other = await login('other@example.com', PASSWORD);
    alice = await login('alice@example.com', PASSWORD);
    mallory = await login('mallory@example.com', PASSWORD);
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

const room = (id, extra = {}) => ({
    id, participantIds: [owner.id, alice.id], participantNames: ['Owner', 'Alice'],
    lastMessage: '', lastMessageTime: Date.now(), unreadCount: 0,
    isGroup: true, groupName: 'Pricing committee', isPrivate: true, ...extra,
});
const enc = encodeURIComponent;

test('only admins create private rooms, as a group they are in', async () => {
    assert.equal((await api(alice, '/conversations', { method: 'POST', body: room(`conv_a_${Date.now()}`, { participantIds: [alice.id, owner.id] }) })).status, 403);
    assert.equal((await api(owner, '/conversations', { method: 'POST', body: room(`conv_b_${Date.now()}`, { isGroup: false }) })).status, 400);
    assert.equal((await api(owner, '/conversations', { method: 'POST', body: room(`conv_c_${Date.now()}`, { participantIds: [alice.id] }) })).status, 400);
    const ok = await api(owner, '/conversations', { method: 'POST', body: room(`conv_d_${Date.now()}`) });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(ok.body.isPrivate, true);
    assert.equal(ok.body.createdBy, owner.id);
});

test('a private room is invisible and unusable to admins and staff outside it', async () => {
    const id = `conv_private_${Date.now()}`;
    assert.equal((await api(owner, '/conversations', { method: 'POST', body: room(id) })).status, 201);
    const msg = { id: `msg_${Date.now()}`, conversationId: id, text: 'the number is 4.2', timestamp: Date.now() };
    assert.equal((await api(alice, '/messages', { method: 'POST', body: msg })).status, 201);

    // Members see it and its messages.
    assert.ok((await api(alice, '/conversations')).body.some(c => c.id === id && c.isPrivate));
    assert.equal((await api(owner, `/messages?conversationId=${enc(id)}`)).body.length, 1);

    for (const [who, user] of [['admin outside', other], ['staff outside', mallory]]) {
        assert.ok(!(await api(user, '/conversations?all=true')).body.some(c => c.id === id), `${who}: not listed`);
        assert.ok(!(await api(user, '/messages?all=true')).body.some(m => m.id === msg.id), `${who}: messages not listed`);
        assert.equal((await api(user, `/messages?conversationId=${enc(id)}`)).status, 403, `${who}: cannot read`);
        assert.equal((await api(user, '/messages', { method: 'POST', body: { ...msg, id: `msg_x_${Date.now()}` } })).status, 403, `${who}: cannot post`);
        assert.equal((await api(user, `/conversations/${enc(id)}`, { method: 'PUT', body: room(id, { participantIds: [owner.id, alice.id, user.id] }) })).status, 403, `${who}: cannot join`);
        assert.equal((await api(user, '/conversations', { method: 'POST', body: room(id, { participantIds: [user.id] }) })).status, 403, `${who}: cannot take over`);
        assert.equal((await api(user, `/conversations/${enc(id)}`, { method: 'DELETE' })).status, 403, `${who}: cannot delete`);
    }
    // Receipts from an admin outside the room change nothing.
    assert.equal((await api(other, '/messages/status-batch', { method: 'PUT', body: { messageIds: [msg.id], status: 'read' } })).status, 200);
    const after = (await api(owner, `/messages?conversationId=${enc(id)}`)).body[0];
    assert.notEqual(after.status, 'read', 'an outside admin cannot mark it read');

    // Ordinary chats keep the admin override.
    const chatId = `conv_chat_${Date.now()}`;
    assert.equal((await api(alice, '/conversations', { method: 'POST', body: { ...room(chatId), isPrivate: false, participantIds: [alice.id, mallory.id], participantNames: ['Alice', 'Mallory'] } })).status, 201);
    assert.equal((await api(other, `/messages?conversationId=${enc(chatId)}`)).status, 200);
    assert.ok((await api(other, '/conversations?all=true')).body.some(c => c.id === chatId));
});

test('only its creator or an admin in it can change a private room', async () => {
    const id = `conv_manage_${Date.now()}`;
    assert.equal((await api(owner, '/conversations', { method: 'POST', body: room(id) })).status, 201);

    // A plain member's update keeps members, name and privacy as stored…
    const sneaky = await api(alice, `/conversations/${enc(id)}`, {
        method: 'PUT', body: room(id, { participantIds: [owner.id, alice.id, mallory.id], participantNames: ['Owner', 'Alice', 'Mallory'], groupName: 'Renamed', isPrivate: false, isPinned: true }),
    });
    assert.equal(sneaky.status, 200);
    let stored = (await api(owner, '/conversations')).body.find(c => c.id === id);
    assert.deepEqual(stored.participantIds, [owner.id, alice.id]);
    assert.equal(stored.groupName, 'Pricing committee');
    assert.equal(stored.isPrivate, true);
    assert.equal(stored.isPinned, true, 'but the rest of the update applies');
    assert.equal((await api(mallory, `/messages?conversationId=${enc(id)}`)).status, 403, 'mallory was not added');
    // …and cannot delete it.
    assert.equal((await api(alice, `/conversations/${enc(id)}`, { method: 'DELETE' })).status, 403);

    // The creator adds someone and renames it.
    const add = await api(owner, `/conversations/${enc(id)}`, {
        method: 'PUT', body: room(id, { participantIds: [owner.id, alice.id, mallory.id], participantNames: ['Owner', 'Alice', 'Mallory'], groupName: 'Deal room' }),
    });
    assert.equal(add.status, 200);
    stored = (await api(mallory, '/conversations')).body.find(c => c.id === id);
    assert.deepEqual(stored?.participantIds, [owner.id, alice.id, mallory.id]);
    assert.equal(stored.groupName, 'Deal room');
    assert.equal(stored.isPrivate, true, 'privacy never changes');
});

test('deleting a private room leaves nothing for admins to read', async () => {
    const id = `conv_gone_${Date.now()}`;
    assert.equal((await api(owner, '/conversations', { method: 'POST', body: room(id, { groupName: 'Secret acquisition' }) })).status, 201);
    assert.equal((await api(owner, `/conversations/${enc(id)}`, { method: 'DELETE' })).status, 200);
    const archived = await api(other, '/deleted-items');
    assert.equal(archived.status, 200, archived.text);
    assert.ok(!JSON.stringify(archived.body).includes(id), 'not in the deleted-items archive');
    assert.ok(!JSON.stringify(archived.body).includes('Secret acquisition'));
    const log = await api(other, '/activity-logs');
    assert.ok(!JSON.stringify(log.body).includes('Secret acquisition'), 'the activity log names no room');
});
