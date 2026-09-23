// Pure worker-side rules: realtime tickets, entity visibility, cursor expiry,
// analytics route normalization.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const tickets = await load('realtimeTickets.ts');
const access = await load('entityAccess.ts');
const rooms = await load('privateRooms.ts');
const viewing = await load('viewingRooms.ts');
const perms = await load('permissions.ts');
const { cursorExpired, ackStatus } = await load('deltaSync.ts');
const { normalizeRoute } = await load('rows.ts');

const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
);
const otherKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('other-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
);
const payload = (over = {}) => ({
    jti: 'j1', uid: 'u1', wid: 'default', role: 'user', name: 'Asha',
    iat: 1_000, exp: 1_000 + tickets.TICKET_TTL_MS, ...over,
});

test('tickets: a signed ticket verifies and round-trips its payload', async () => {
    const t = await tickets.signTicket(payload(), key);
    const check = await tickets.verifyTicket(t, key, 2_000);
    assert.equal(check.ok, true);
    assert.deepEqual(check.payload, payload());
});

test('tickets: tampering, wrong key, expiry and bad format are rejected', async () => {
    const t = await tickets.signTicket(payload(), key);
    const [v, body, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify(payload({ uid: 'admin' }))).toString('base64url');
    assert.equal((await tickets.verifyTicket(`${v}.${forged}.${mac}`, key, 2_000)).reason, 'signature');
    assert.equal((await tickets.verifyTicket(t, otherKey, 2_000)).reason, 'signature');
    assert.equal((await tickets.verifyTicket(t, key, 1_000 + tickets.TICKET_TTL_MS + 1)).reason, 'expired');
    assert.equal((await tickets.verifyTicket('v2.x.y', key)).reason, 'format');
    assert.equal((await tickets.verifyTicket(`${v}.${body}`, key)).reason, 'format');
});

test('entity visibility mirrors the REST read rules', () => {
    const none = perms.normalizePermissions({});
    assert.equal(access.readableEntities(none).size, 0);

    const invoicesOnly = perms.normalizePermissions({ invoices: 'view' });
    assert.deepEqual([...access.readableEntities(invoicesOnly)].sort(), ['artwork', 'contact', 'invoice']);

    const messagesOnly = perms.normalizePermissions({ messages: 'view' });
    assert.deepEqual([...access.readableEntities(messagesOnly)].sort(), ['conversation', 'message']);

    const admin = access.permissionsForRoles([], perms.ADMIN_ROLE_ID);
    assert.equal(access.readableEntities(admin).size, access.SYNC_ENTITIES.length);

    assert.equal(access.canReadPayments(perms.normalizePermissions({ payments: 'view' })), true);
    assert.equal(access.canReadPayments(none), false);
    // An unknown role falls back to no access.
    assert.equal(access.readableEntities(access.permissionsForRoles([], 'deleted-role')).size, 0);
});

test('scope: team-wide, participant-only, admin override, malformed fails closed', () => {
    assert.equal(access.scopeAllows(null, 'u1', false), true);
    assert.equal(access.scopeAllows('["u1","u2"]', 'u1', false), true);
    assert.equal(access.scopeAllows('["u2"]', 'u1', false), false);
    assert.equal(access.scopeAllows('["u2"]', 'u1', true), true);
    assert.equal(access.scopeAllows('not json', 'u1', false), false);
    assert.equal(access.scopeAllows('{"u1":1}', 'u1', false), false);
});

test('scope: a private room is members only, even for admins', () => {
    const scope = JSON.stringify(rooms.conversationScope(['u1', 'u2'], true));
    assert.equal(access.scopeAllows(scope, 'u1', false), true, 'member');
    assert.equal(access.scopeAllows(scope, 'u1', true), true, 'admin member');
    assert.equal(access.scopeAllows(scope, 'u3', false), false, 'outsider');
    assert.equal(access.scopeAllows(scope, 'u3', true), false, 'admin outsider');
    assert.equal(access.scopeAllows(JSON.stringify(rooms.conversationScope(['u1'], false)), 'u3', true), true, 'ordinary chat keeps the admin override');
});

test('private rooms: who may use and manage them', () => {
    const room = { members: ['creator', 'member', 'adminIn'], isPrivate: true, createdBy: 'creator' };
    const chat = { members: ['a', 'b'], isPrivate: false, createdBy: null };
    const use = (id, admin, r) => rooms.mayUseConversation(id, admin, r);
    const manage = (id, admin, r) => rooms.mayManageRoom(id, admin, r);
    assert.equal(use('member', false, room), true);
    assert.equal(use('adminOut', true, room), false, 'admins outside a private room are out');
    assert.equal(use('adminOut', true, chat), true, 'admins still reach ordinary chats');
    assert.equal(use('stranger', false, chat), false);
    assert.equal(manage('creator', false, room), true, 'the creator manages it');
    assert.equal(manage('adminIn', true, room), true, 'an admin in it manages it');
    assert.equal(manage('member', false, room), false, 'a plain member does not');
    assert.equal(manage('adminOut', true, room), false);
    assert.equal(manage('a', false, chat), true, 'ordinary chats: any member, as before');
    assert.deepEqual(rooms.roomAccessOf({ participant_ids: '["x"]' }), { members: ['x'], isPrivate: false, createdBy: null }, 'rows from before the new columns');
});

test('viewing rooms: tokens, passcodes and passes', async () => {
    const token = viewing.newRoomToken();
    assert.match(token, viewing.ROOM_TOKEN_RE);
    assert.notEqual(token, viewing.newRoomToken());
    for (let i = 0; i < 50; i++) assert.match(viewing.newPasscode(), /^\d{6}$/);

    const salt = viewing.newSecretHex(16);
    const row = { passcode_salt: salt, passcode_hash: await viewing.hashPasscode('123456', salt) };
    assert.equal(await viewing.passcodeMatches('123456', row), true);
    assert.equal(await viewing.passcodeMatches('123457', row), false);
    assert.equal(await viewing.passcodeMatches('12345', row), false, 'must be six digits');

    const key = viewing.newSecretHex(32);
    const now = 1_800_000_000_000;
    const { pass } = await viewing.issuePass(key, token, now);
    assert.equal(await viewing.passValid(pass, key, token, now + 1000), true);
    assert.equal(await viewing.passValid(pass, key, token, now + viewing.PASS_TTL_MS + 1), false, 'expires');
    assert.equal(await viewing.passValid(pass, viewing.newSecretHex(32), token, now), false, 'a new grant key cancels it');
    assert.equal(await viewing.passValid(pass, key, viewing.newRoomToken(), now), false, 'bound to its room');
    const [exp, mac] = pass.split('.');
    assert.equal(await viewing.passValid(`${Number(exp) + 1000}.${mac}`, key, token, now), false, 'expiry cannot be stretched');
    assert.equal(await viewing.passValid(null, key, token, now), false);
});

test('viewing rooms: the client sees only what the room shares', () => {
    const art = { id: 'a1', title: 'Monsoon', customId: 'VD-1', location: 'Store B', status: 'Available', price: 1000, plusGst: true,
        imageUrls: ['/api/files/uploads/u1/x.png', 'https://elsewhere.example/y.png'] };
    const shown = viewing.clientArtwork(art, 'T'.repeat(43), '1.abc', true);
    assert.equal(shown.price, 1000);
    assert.equal(shown.availability, 'available');
    assert.equal(shown.images.length, 1, 'only stored photos');
    assert.match(shown.images[0].full, /^\/api\/viewing\/T{43}\/image\?k=uploads%2Fu1%2Fx\.png&p=/);
    for (const internal of ['customId', 'location', 'status', 'imageUrls']) assert.ok(!(internal in shown), internal);
    assert.ok(!('price' in viewing.clientArtwork(art, 't', 'p', false)), 'price on request');
    assert.ok(!('price' in viewing.clientArtwork({ ...art, status: 'Sold' }, 't', 'p', true)), 'no price for sold pieces');
    assert.equal(viewing.clientArtwork({ ...art, status: 'Reserved' }, 't', 'p', true).availability, 'reserved');
    assert.deepEqual([...viewing.roomImageKeys([art])], ['uploads/u1/x.png', 'uploads/u1/x.png__thumb']);
    assert.equal(viewing.fileKeyOf('/api/files/../secret'), null);
    for (const ok of ['a@b.co', 'first.last@studio.example.in']) assert.equal(viewing.looksLikeEmail(ok), true, ok);
    for (const bad of ['', 'no-at', '@b.co', 'a@b', 'a@b.', 'a@@b.co', 'a b@c.co', 'a@.co']) assert.equal(viewing.looksLikeEmail(bad), false, bad);
});

test('cursor expiry: pruned, ahead of the log, and the empty log', () => {
    assert.equal(cursorExpired(0, { minSeq: null, maxSeq: null }), false, 'empty log, empty cursor');
    assert.equal(cursorExpired(5, { minSeq: null, maxSeq: null }), true, 'log wiped under a client');
    assert.equal(cursorExpired(10, { minSeq: 1, maxSeq: 10 }), false);
    assert.equal(cursorExpired(11, { minSeq: 1, maxSeq: 10 }), true, 'cursor ahead of the log');
    assert.equal(cursorExpired(4, { minSeq: 5, maxSeq: 10 }), false, 'next needed row still retained');
    assert.equal(cursorExpired(3, { minSeq: 5, maxSeq: 10 }), true, 'row 4 was pruned');
});

test('receipt statuses: only forward delivered/read are accepted', () => {
    assert.equal(ackStatus('read'), 'read');
    assert.equal(ackStatus('delivered'), 'delivered');
    for (const bad of ['sent', 'failed', '', null, undefined, 1]) assert.equal(ackStatus(bad), null);
});

test('analytics routes drop ids so cardinality stays bounded', () => {
    assert.equal(normalizeRoute('/sync'), '/sync');
    assert.equal(normalizeRoute('/messages/abc-123/status'), '/messages/:id/status');
    assert.equal(normalizeRoute('/messages/status-batch'), '/messages/status-batch');
    assert.equal(normalizeRoute('/realtime/ws'), '/realtime/ws');
});

test('realtime fails closed without a proper secret', async () => {
    const envMod = await load('workerEnv.ts');
    const hub = {};
    const strong = 'x'.repeat(32);
    assert.equal(envMod.realtimeEnabled({ REALTIME_ENABLED: 'on', SYNC_HUB: hub, REALTIME_SECRET: strong }), true);
    assert.equal(envMod.realtimeEnabled({ REALTIME_ENABLED: 'on', SYNC_HUB: hub }), false, 'no secret');
    assert.equal(envMod.realtimeEnabled({ REALTIME_ENABLED: 'on', SYNC_HUB: hub, REALTIME_SECRET: 'short' }), false);
    assert.equal(envMod.realtimeEnabled({ REALTIME_ENABLED: 'off', SYNC_HUB: hub, REALTIME_SECRET: strong }), false);
    assert.equal(envMod.realtimeEnabled({ REALTIME_ENABLED: 'on', REALTIME_SECRET: strong }), false, 'no hub binding');
    // The stand-in is random, never a value an attacker could read from source.
    const standIn = envMod.rawRealtimeSecret({});
    assert.ok(standIn.length >= 64);
    assert.doesNotMatch(standIn, /vayu|default|dev/i);
    assert.equal(envMod.rawRealtimeSecret({ REALTIME_SECRET: strong }), strong);
});

test('device limits: defaults, admin exemption, validation, labels', async () => {
    const d = await load('deviceSessions.ts');
    assert.equal(d.deviceLimit({ role: 'user' }), 2);
    assert.equal(d.deviceLimit({ role: 'user', maxDevices: 3 }), 3);
    assert.equal(d.deviceLimit({ role: 'user', maxDevices: 50 }), 10, 'capped');
    assert.equal(d.deviceLimit({ role: 'user', maxDevices: 0 }), 2, 'invalid falls back to default');
    assert.equal(d.deviceLimit({ role: 'admin', maxDevices: 1 }), null, 'admins are never limited');

    assert.deepEqual(d.parseMaxDevices(undefined), { ok: true, value: undefined });
    assert.deepEqual(d.parseMaxDevices(null), { ok: true, value: null });
    assert.deepEqual(d.parseMaxDevices('3'), { ok: true, value: 3 });
    for (const bad of [0, 11, 1.5, 'x', -1]) assert.equal(d.parseMaxDevices(bad).ok, false);

    assert.equal(d.deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome on Android');
    assert.equal(d.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    assert.equal(d.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
    assert.equal(d.deviceLabel(null), 'Browser');
});
