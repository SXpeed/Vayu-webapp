// The bell and unread inquiries against a real local Worker: dismissing a
// notification leaves its inquiry unread; only opening the inquiry reads it.
//
//   node --test frontend/tests/inbox.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };
const STAFF = { name: 'Desk', email: 'desk@example.com', password: 'staff-password-1234' };

let worker;
let owner;
let staff;

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

const inbox = async token => (await api(token, '/inbox')).body;

/** Notifications are written after the response; wait for them. */
async function inboxWhen(token, ready) {
    for (let i = 0; i < 50; i++) {
        const box = await inbox(token);
        if (ready(box)) return box;
        await new Promise(r => setTimeout(r, 100));
    }
    return inbox(token);
}

let n = 0;
async function newInquiry(token) {
    const inq = { id: `inq_${Date.now()}_${n++}`, inquiryNumber: `INQ-${n}`, customerName: `Client ${n}`, customerPhone: '', customerEmail: '', artworkIds: [], notes: '', source: 'Walk-in', status: 'New', catalogShared: false, date: Date.now() };
    const res = await api(token, '/inquiries', { method: 'POST', body: inq });
    assert.equal(res.status, 201, res.text);
    return inq;
}

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: schema } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
    assert.equal((await api(owner, '/auth/users', { method: 'POST', body: STAFF })).status < 300, true);
    staff = (await api(null, '/auth/login', { method: 'POST', body: { email: STAFF.email, password: STAFF.password } })).body.token;
    assert.ok(staff);
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

test('dismissing notifications leaves inquiries unread; opening one reads only that one', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await newInquiry(staff));

    // 1–2. Five new inquiries: five in the bell, five unread. The creator gets neither.
    let box = await inboxWhen(owner, b => b.notifications.length === 5 && b.unreadInquiryIds.length === 5);
    assert.equal(box.notifications.length, 5);
    assert.deepEqual(new Set(box.unreadInquiryIds), new Set(made.map(i => i.id)));
    assert.equal((await inbox(staff)).unreadInquiryIds.length, 0, 'not unread for whoever added them');

    // Someone else can't dismiss the owner's notifications.
    await api(staff, '/inbox/notifications', { method: 'POST', body: { ids: box.notifications.map(x => x.id), state: 'dismissed' } });
    assert.equal((await inbox(owner)).notifications.length, 5);

    // 3–5. Dismiss all five: bell 0, still five unread.
    const dismiss = await api(owner, '/inbox/notifications', { method: 'POST', body: { ids: box.notifications.map(x => x.id), state: 'dismissed' } });
    assert.equal(dismiss.status, 200, dismiss.text);
    box = await inbox(owner);
    assert.equal(box.notifications.length, 0);
    assert.equal(box.unreadInquiryIds.length, 5);

    // 6–7. Open one inquiry: four unread.
    assert.equal((await api(owner, '/inbox/read', { method: 'POST', body: { inquiryId: made[0].id } })).status, 200);
    // 8–9. Listing inquiries reads nothing.
    assert.equal((await api(owner, '/inquiries')).status, 200);
    box = await inbox(owner);
    assert.equal(box.unreadInquiryIds.length, 4);
    assert.ok(!box.unreadInquiryIds.includes(made[0].id));

    // 10–12. Another inquiry: a new notification (old ones stay dismissed), five unread.
    const sixth = await newInquiry(staff);
    box = await inboxWhen(owner, b => b.notifications.length === 1);
    assert.equal(box.notifications.length, 1);
    assert.equal(box.notifications[0].link.inquiryId, sixth.id);
    assert.equal(box.unreadInquiryIds.length, 5);

    // Mark unread brings one back; opening a notification doesn't read the inquiry.
    await api(owner, '/inbox/read', { method: 'POST', body: { inquiryId: made[0].id, unread: true } });
    await api(owner, '/inbox/notifications', { method: 'POST', body: { ids: [box.notifications[0].id], state: 'opened' } });
    box = await inbox(owner);
    assert.equal(box.notifications.length, 0);
    assert.equal(box.unreadInquiryIds.length, 6);

    // A deleted inquiry stops counting.
    assert.equal((await api(owner, `/inquiries/${made[1].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await inbox(owner)).unreadInquiryIds.length, 5);
});

test('bad requests are refused', async () => {
    assert.equal((await api(null, '/inbox')).status, 401);
    assert.equal((await api(owner, '/inbox/notifications', { method: 'POST', body: { ids: ['x'], state: 'deleted' } })).status, 400);
    assert.equal((await api(owner, '/inbox/read', { method: 'POST', body: {} })).status, 400);
});

test('people react to inquiry messages, one reaction each, as in chat', async () => {
    const inq = await newInquiry(staff);
    const msg = { id: `inqmsg_${Date.now()}`, inquiryId: inq.id, senderId: 'x', senderName: 'x', text: 'Sent the catalog', tags: [], timestamp: Date.now() };
    assert.equal((await api(staff, '/inquiry-messages', { method: 'POST', body: msg })).status, 201);
    const react = (token, emoji) => api(token, `/inquiry-messages/${msg.id}/reaction`, { method: 'PUT', body: { emoji } });
    assert.equal((await react(owner, '👍')).status, 200);
    const both = await react(staff, '❤️');
    assert.equal(Object.keys(both.body.reactions).length, 2);
    const changed = await react(owner, '🙏');
    assert.equal(Object.values(changed.body.reactions).filter(e => e === '🙏').length, 1, 'a second reaction replaces the first');
    const removed = await react(owner, null);
    assert.equal(Object.keys(removed.body.reactions).length, 1);
    assert.equal((await react(owner, 'not-an-emoji')).status, 400);
    assert.equal((await api(owner, '/inquiry-messages/nope/reaction', { method: 'PUT', body: { emoji: '👍' } })).status, 404);
});
