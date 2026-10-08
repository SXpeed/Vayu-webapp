// The service worker's notification handling (public/sw.js), run in a
// sandbox with stand-ins for the browser: a notification is shown only to
// the person signed in on the device, and a tap leads to the exact chat.
//
//   node --test frontend/tests/swPush.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

/** A fresh worker: its listeners, what it showed, opened and stored. */
function worker({ identity, windows = [] } = {}) {
    const listeners = {};
    const stores = new Map();
    const shown = [];
    const opened = [];
    const posted = [];
    const cacheFor = name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const map = stores.get(name);
        return {
            match: async url => (map.has(url) ? new Response(map.get(url)) : undefined),
            put: async (url, res) => { map.set(url, await res.text()); },
            delete: async url => map.delete(url),
        };
    };
    if (identity !== undefined) stores.set('push-identity', new Map([['/__push-identity', JSON.stringify(identity)]]));
    const clients = windows.map(url => ({ url, postMessage: m => posted.push(m), focus: async () => 'focused' }));
    const self = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting() {},
        location: new URL('https://app.example.com/sw.js'),
        registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
        clients: {
            matchAll: async () => clients,
            openWindow: async url => { opened.push(url); },
            claim: async () => {},
        },
    };
    const context = vm.createContext({
        globalThis: self, caches: { open: async name => cacheFor(name), keys: async () => [...stores.keys()], delete: async () => true },
        URL, URLSearchParams, Response, Request, Headers, fetch: async () => new Response(''), console,
        BroadcastChannel: class { postMessage() {} close() {} }, setTimeout, Date, Math, JSON, Promise,
    });
    Object.assign(self, { caches: context.caches });
    vm.runInContext(source, context);
    const fire = async (type, event) => {
        let done;
        listeners[type]({ ...event, waitUntil: p => { done = p; } });
        await done;
    };
    return { fire, shown, opened, posted, stores };
}

const push = (data, title = 'Asha · Studio team') => ({ data: { json: () => ({ title, body: 'New prints arrive Friday', data }) } });

test('shown to the person it is for', async () => {
    const w = worker({ identity: { userId: 'u1' } });
    await w.fire('push', push({ view: 'messaging', conversationId: 'c1', to: 'u1' }));
    assert.equal(w.shown.length, 1);
});

test('hidden on a device signed in as someone else, or signed out', async () => {
    const other = worker({ identity: { userId: 'u2' } });
    await other.fire('push', push({ view: 'messaging', to: 'u1' }));
    assert.equal(other.shown.length, 0);
    const out = worker({ identity: { userId: null } });
    await out.fire('push', push({ view: 'messaging', to: 'u1' }));
    assert.equal(out.shown.length, 0);
});

test('the same person working in another organization does not see it', async () => {
    // A person's id is the same in every organization that keeps its own storage.
    const elsewhere = worker({ identity: { userId: 'u1', org: 'org-b' } });
    await elsewhere.fire('push', push({ view: 'messaging', to: 'u1', org: 'org-a' }));
    assert.equal(elsewhere.shown.length, 0);
    const here = worker({ identity: { userId: 'u1', org: 'org-a' } });
    await here.fire('push', push({ view: 'messaging', to: 'u1', org: 'org-a' }));
    assert.equal(here.shown.length, 1);
});

test('without an organization on either side, the person alone decides (older versions, original sign-in)', async () => {
    const oldDevice = worker({ identity: { userId: 'u1' } });
    await oldDevice.fire('push', push({ view: 'messaging', to: 'u1', org: 'org-a' }));
    assert.equal(oldDevice.shown.length, 1);
    const oldPush = worker({ identity: { userId: 'u1', org: 'org-b' } });
    await oldPush.fire('push', push({ view: 'messaging', to: 'u1' }));
    assert.equal(oldPush.shown.length, 1);
});

test('a device the app never told (an older version) shows it, as before', async () => {
    const w = worker();
    await w.fire('push', push({ view: 'messaging', to: 'u1' }));
    assert.equal(w.shown.length, 1);
});

test('a tap with no app open launches it at the exact chat, and leaves the tap for the app', async () => {
    const w = worker();
    await w.fire('notificationclick', { notification: { close() {}, data: { view: 'messaging', conversationId: 'c1', to: 'u1' } } });
    assert.deepEqual(w.opened, ['./?view=messaging&conversation=c1']);
    const stored = JSON.parse(w.stores.get('push-nav').get('/__push-nav'));
    assert.equal(stored.conversationId, 'c1');
});

test('a tap with the app open tells that window where to go (not the website or control centre)', async () => {
    const w = worker({ windows: ['https://app.example.com/admin.html', 'https://app.example.com/'] });
    await w.fire('notificationclick', { notification: { close() {}, data: { view: 'inquiry', inquiryId: 'i9', chat: true } } });
    assert.equal(w.opened.length, 0);
    assert.equal(w.posted.length, 1);
    assert.equal(w.posted[0].type, 'PUSH_NAVIGATE');
    assert.equal(w.posted[0].inquiryId, 'i9');
    assert.equal(w.posted[0].chat, true);
});
