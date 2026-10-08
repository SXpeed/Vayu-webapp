// Saved contacts against a real local Worker: inquiries find or create their
// contact by phone or email, never twice, never by name; conflicts are left
// for a person; tags are the organisation's own.
//
//   node --test frontend/tests/contacts.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Owner', email: 'owner@example.com', password: 'owner-password-1234' };

let worker;
let owner;

async function api(path, { method = 'GET', body } = {}) {
    const headers = new Headers({ Authorization: `Bearer ${owner}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: withSessionToken(json, res), text };
}

let n = 0;
async function newInquiry(fields) {
    const inq = { id: `inq_${Date.now()}_${n++}`, inquiryNumber: `INQ-${n}`, customerName: '', customerPhone: '', customerEmail: '', artworkIds: [], notes: '', source: 'Walk-in', status: 'New', catalogShared: false, date: Date.now(), ...fields };
    const res = await api('/inquiries', { method: 'POST', body: inq });
    assert.equal(res.status, 201, res.text);
    return inq;
}

/** Linking runs after the response; wait until the inquiry has been looked at. */
async function linked(id) {
    for (let i = 0; i < 50; i++) {
        const inq = (await api('/inquiries')).body.find(x => x.id === id);
        if (inq && (inq.contactId || inq.contactMatches?.length)) return inq;
        await new Promise(r => setTimeout(r, 100));
    }
    return (await api('/inquiries')).body.find(x => x.id === id);
}

const contacts = async () => (await api('/contacts')).body;

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: schema } });
    assert.equal((await api('/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    const login = await fetch(`${worker.origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER.email, password: OWNER.password }) });
    owner = withSessionToken(await login.json(), login).token;
});

after(async () => {
    await worker?.stop();
    worker?.cleanup();
});

let rahul;

test('an inquiry creates its contact; the same phone in another spelling links to it', async () => {
    const first = await linked((await newInquiry({ customerName: 'Rahul Sharma', customerPhone: '+91 98765 43210', customerEmail: 'Rahul@Example.com' })).id);
    assert.ok(first.contactId);
    rahul = (await contacts()).find(c => c.id === first.contactId);
    assert.equal(rahul.name, 'Rahul Sharma');
    assert.deepEqual(rahul.phones, ['+91 98765 43210']);
    assert.equal(rahul.source, 'inquiry');

    const second = await linked((await newInquiry({ customerName: 'R. Sharma', customerPhone: '098765 43210' })).id);
    assert.equal(second.contactId, rahul.id);
    const byEmail = await linked((await newInquiry({ customerName: 'Someone', customerEmail: 'rahul@example.com' })).id);
    assert.equal(byEmail.contactId, rahul.id);
    const after = (await contacts()).find(c => c.id === rahul.id);
    assert.equal(after.name, 'Rahul Sharma', 'a later inquiry never renames the contact');
    assert.equal((await contacts()).length, 1);
});

test('a name alone makes no contact, and is never matched on', async () => {
    const nameOnly = await newInquiry({ customerName: 'Rahul Sharma' });
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await api('/inquiries')).body.find(x => x.id === nameOnly.id).contactId, undefined);
    assert.equal((await contacts()).length, 1);
});

test('phone of one contact and email of another: left for a person to choose', async () => {
    const priya = await linked((await newInquiry({ customerName: 'Priya', customerEmail: 'priya@example.com' })).id);
    const mixed = await linked((await newInquiry({ customerName: '?', customerPhone: '9876543210', customerEmail: 'priya@example.com' })).id);
    assert.equal(mixed.contactId, undefined);
    assert.deepEqual(new Set(mixed.contactMatches), new Set([rahul.id, priya.contactId]));

    const chosen = await api(`/inquiries/${mixed.id}`, { method: 'PUT', body: { ...mixed, chooseContactId: rahul.id } });
    assert.equal(chosen.status, 200, chosen.text);
    const now = (await api('/inquiries')).body.find(x => x.id === mixed.id);
    assert.equal(now.contactId, rahul.id);
    assert.deepEqual(now.contactMatches, []);
});

test('several phones and emails; one number belongs to one contact', async () => {
    const current = (await contacts()).find(c => c.id === rahul.id);
    const saved = await api(`/contacts/${rahul.id}`, { method: 'PUT', body: { ...current, phones: ['+91 98765 43210', '+44 20 7946 0958'], emails: ['rahul@example.com', 'rs@studio.in'] } });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.phones, ['+91 98765 43210', '+44 20 7946 0958']);

    const viaSecond = await linked((await newInquiry({ customerName: 'x', customerPhone: '+442079460958' })).id);
    assert.equal(viaSecond.contactId, rahul.id);

    const dup = await api('/contacts', { method: 'POST', body: { id: 'cont_dup', name: 'Copy', phones: ['9876543210'] } });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /Rahul Sharma already has this phone number/);
    assert.equal(dup.body.contactId, rahul.id);

    assert.equal((await api('/contacts', { method: 'POST', body: { id: 'cont_bad', name: 'Bad', emails: ['not-an-email'] } })).status, 400);

    // Saved from an older copy: refused rather than overwriting.
    const stale = await api(`/contacts/${rahul.id}`, { method: 'PUT', body: { ...current, name: 'Old copy' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'stale');
});

test('five inquiries from one new number at the same moment make one contact', async () => {
    const before = (await contacts()).length;
    const made = await Promise.all([0, 1, 2, 3, 4].map(() => newInquiry({ customerName: 'Rush', customerPhone: '+91 90000 00001' })));
    const links = await Promise.all(made.map(i => linked(i.id)));
    assert.equal(new Set(links.map(l => l.contactId)).size, 1);
    assert.equal((await contacts()).length, before + 1);
});

test('tags: unique per name ignoring case, on many contacts at once, removed everywhere on delete', async () => {
    const vip = await api('/contact-tags', { method: 'POST', body: { name: 'VIP  Client', color: 'gold' } });
    assert.equal(vip.status, 201, vip.text);
    assert.equal(vip.body.name, 'VIP Client');
    assert.equal((await api('/contact-tags', { method: 'POST', body: { name: 'vip client' } })).status, 409);
    const architect = (await api('/contact-tags', { method: 'POST', body: { name: 'Architect', color: 'nope' } })).body;
    assert.equal(architect.color, 'gray', 'unknown colours fall back');

    const all = await contacts();
    const bulk = await api('/contacts/bulk-tags', { method: 'POST', body: { contactIds: all.map(c => c.id), add: [vip.body.id, architect.id, 'tag_from_elsewhere'] } });
    assert.equal(bulk.status, 200, bulk.text);
    for (const c of await contacts()) assert.deepEqual(c.tags, [vip.body.id, architect.id], 'unknown tag ids are dropped');

    await api('/contacts/bulk-tags', { method: 'POST', body: { contactIds: [rahul.id], remove: [architect.id] } });
    assert.deepEqual((await contacts()).find(c => c.id === rahul.id).tags, [vip.body.id]);

    assert.equal((await api(`/contact-tags/${vip.body.id}`, { method: 'DELETE' })).status, 200);
    for (const c of await contacts()) assert.ok(!c.tags.includes(vip.body.id));
    assert.deepEqual((await api('/contact-tags')).body.map(t => t.name), ['Architect']);
});

test('deleting a contact frees its numbers and does not bring it back', async () => {
    const c = (await contacts()).find(x => x.name === 'Rush');
    assert.equal((await api(`/contacts/${c.id}`, { method: 'DELETE' })).status, 200);
    const again = await api('/contacts', { method: 'POST', body: { id: 'cont_rush2', name: 'Rush again', phones: ['9000000001'] } });
    assert.equal(again.status, 201, again.text);
    await api('/inbox'); // the background pass that links older inquiries
    await new Promise(r => setTimeout(r, 500));
    assert.ok(!(await contacts()).some(x => x.id === c.id));
});
