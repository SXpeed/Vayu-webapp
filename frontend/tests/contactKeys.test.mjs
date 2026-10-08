// Phone/email keys contacts are matched on (contactKeys.ts).
//
//   node --test frontend/tests/contactKeys.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const k = await load('contactKeys.ts');

test('one Indian number however it is typed', () => {
    for (const raw of ['+91 98765 43210', '098765 43210', '9876543210', '0091 98765 43210']) assert.equal(k.phoneKey(raw), 'p:919876543210', raw);
});

test("a number without a code is read as the organisation's country", () => {
    assert.equal(k.phoneKey('020 7946 0958', 'GB'), 'p:442079460958');
    assert.equal(k.phoneKey('+44 20 7946 0958', 'IN'), 'p:442079460958', 'a + number is the same anywhere');
    assert.equal(k.phoneKey('(212) 555-0199', 'US'), 'p:12125550199');
    assert.equal(k.phoneKey('9876543210', 'not a code'), 'p:919876543210', 'nonsense falls back to the default');
});

test('not a number, not a key', () => {
    assert.equal(k.phoneKey('12'), null);
    assert.equal(k.phoneKey('abc'), null);
    assert.equal(k.emailKey(' Rahul@Example.COM '), 'e:rahul@example.com');
    assert.equal(k.emailKey('rahul@'), null);
    assert.deepEqual(k.contactKeys(['98765 43210', '+91 98765 43210'], ['a@b.co', 'A@B.co']), ['p:919876543210', 'e:a@b.co']);
});
