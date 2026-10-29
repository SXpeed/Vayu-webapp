// Contact suggestions for customer fields (contactSearch.ts).
//
//   node --test frontend/tests/contactSearch.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { searchContacts } = await load('contactSearch.ts');

const contacts = [
    { id: 'a', name: 'Anjali Mehta', phone: '+91 98201 44120', email: 'anjali@example.com', source: 'manual', createdAt: 1, lastInteractionAt: 50 },
    { id: 'b', name: 'Rohan Desai', phone: '99300 21877', phones: ['99300 21877', '022 2400 1100'], source: 'manual', createdAt: 2 },
    { id: 'c', name: 'Kavya Mehra', phone: '', email: 'kavya@studio.example', source: 'inquiry', createdAt: 30 },
    { id: 'd', name: 'Dev Kapoor', phone: '9004077812', source: 'import', createdAt: 3, updatedAt: 40 },
];
const ids = list => list.map(c => c.id);

test('nothing typed lists the most recently active first', () => {
    assert.deepEqual(ids(searchContacts(contacts, '')), ['a', 'd', 'c', 'b']);
    assert.deepEqual(ids(searchContacts(contacts, '   ', 2)), ['a', 'd']);
});

test('name start beats a later word, which beats anywhere in the name', () => {
    assert.deepEqual(ids(searchContacts(contacts, 'meh')), ['a', 'c']);
    assert.deepEqual(ids(searchContacts(contacts, 'KAV')), ['c']);
    assert.deepEqual(ids(searchContacts(contacts, 'ap')), ['d']);
});

test('phone digits match however the number is written, including second numbers', () => {
    assert.deepEqual(ids(searchContacts(contacts, '98201')), ['a']);
    assert.deepEqual(ids(searchContacts(contacts, '+91 9820144120')), ['a']);
    assert.deepEqual(ids(searchContacts(contacts, '2400')), ['b']);
    assert.deepEqual(ids(searchContacts(contacts, '99')), [], 'two digits are too few to match a phone');
});

test('email matches, and nothing matches nothing', () => {
    assert.deepEqual(ids(searchContacts(contacts, 'studio.example')), ['c']);
    assert.deepEqual(ids(searchContacts(contacts, 'zzz')), []);
});
