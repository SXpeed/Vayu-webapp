// Who push notifications go to, and which person a device belongs to (pushRules.ts).
//
//   node --test frontend/tests/pushRules.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const r = await load('pushRules.ts');

const roles = [
    { id: 'user', name: 'Staff', permissions: { inquiries: 'edit', payments: 'none' } },
    { id: 'packer', name: 'Packer', permissions: { inquiries: 'none', payments: 'none' } },
];
const subs = [
    { userId: 'admin', endpoint: 'a' },
    { userId: 'staff', endpoint: 's' },
    { userId: 'packer', endpoint: 'p' },
    { userId: 'removed', endpoint: 'r' },
];
const roleOf = new Map([['admin', 'admin'], ['staff', 'user'], ['packer', 'packer']]);
const who = list => list.map(s => s.userId);

test('inquiry notifications reach only people who can see inquiries, still on the team', () => {
    assert.deepEqual(who(r.sectionRecipients(subs, roleOf, roles, 'inquiries', '')), ['admin', 'staff']);
});

test('payment notifications reach only people who can see payments', () => {
    assert.deepEqual(who(r.sectionRecipients(subs, roleOf, roles, 'payments', '')), ['admin']);
});

test('the person who did it is left out', () => {
    assert.deepEqual(who(r.sectionRecipients(subs, roleOf, roles, 'inquiries', 'staff')), ['admin']);
});

test('a device claimed by someone else drops the previous registration, wherever it was', () => {
    // Same workspace, another person signs in on the phone.
    assert.equal(r.staleRegistration({ scope: '', userId: 'admin' }, { scope: '', userId: 'staff' }, 'dev1'), 'push:sub:admin:dev1');
    // The same person moves the phone to another workspace.
    assert.equal(r.staleRegistration({ scope: 'org:o1:', userId: 'u1' }, { scope: 'org:o2:', userId: 'u9' }, 'dev1'), 'org:o1:push:sub:u1:dev1');
    // Already theirs, or never anyone's: nothing to remove.
    assert.equal(r.staleRegistration({ scope: 'org:o1:', userId: 'u1' }, { scope: 'org:o1:', userId: 'u1' }, 'dev1'), null);
    assert.equal(r.staleRegistration(null, { scope: '', userId: 'staff' }, 'dev1'), null);
});
