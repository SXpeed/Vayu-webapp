// Pure worker-side rules: realtime tickets, entity visibility, cursor expiry,
// analytics route normalization.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const tickets = await load('realtimeTickets.ts');
const access = await load('entityAccess.ts');
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
