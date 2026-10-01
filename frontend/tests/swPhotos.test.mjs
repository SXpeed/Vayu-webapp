// The service worker's saved photos (public/sw.js), run in a sandbox with
// stand-ins for the browser: photos stay on the device once shown, show
// without a connection (a full photo falls back to its preview), and the
// full-size store keeps under its limit.
//
//   node --test frontend/tests/swPhotos.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.example.com';
const MB = 1024 * 1024;

/** A fresh worker with a scripted network: `files` maps a path to [status, type, body, headers]. */
function worker(files = {}) {
    const listeners = {};
    const stores = new Map();
    const network = [];
    let online = true;
    const cacheFor = name => {
        if (!stores.has(name)) stores.set(name, new Map());
        const map = stores.get(name);
        const key = k => (typeof k === 'string' ? k : k.url);
        return {
            match: async k => map.get(key(k))?.clone(),
            put: async (k, res) => { map.set(key(k), res); },
            delete: async k => map.delete(key(k)),
            keys: async () => [...map.keys()].map(url => new Request(url)),
        };
    };
    const self = {
        addEventListener: (type, fn) => { listeners[type] = fn; },
        skipWaiting() {},
        location: new URL(`${ORIGIN}/sw.js`),
        registration: { showNotification: async () => {} },
        clients: { matchAll: async () => [], openWindow: async () => {}, claim: async () => {} },
    };
    const fetchStub = async request => {
        const path = new URL(typeof request === 'string' ? request : request.url).pathname;
        network.push(path);
        if (!online) throw new TypeError('Failed to fetch');
        const [status, type, body, headers = {}] = files[path] ?? [404, 'application/json', '{}'];
        return new Response(body, { status, headers: { 'Content-Type': type, ...headers } });
    };
    const context = vm.createContext({
        globalThis: self,
        caches: { open: async name => cacheFor(name), keys: async () => [...stores.keys()], delete: async name => stores.delete(name) },
        URL, URLSearchParams, Response, Request, Headers, Blob, fetch: fetchStub, console,
        BroadcastChannel: class { postMessage() {} close() {} }, setTimeout, Date, Math, JSON, Promise, Number, String,
    });
    vm.runInContext(source, context);

    /** A page asking for a file: the worker's answer, or null when it lets the request through. */
    const get = async (path, headers = {}) => {
        let answer = null;
        const pending = [];
        listeners.fetch({
            request: new Request(`${ORIGIN}${path}`, { headers }),
            respondWith: p => { answer = p; },
            waitUntil: p => pending.push(p),
        });
        if (!answer) return null;
        const res = await answer;
        await Promise.all(pending);
        return res;
    };
    return { get, stores, network, listeners, goOffline: () => { online = false; } };
}

const PHOTO = '/api/o/org1/files/uploads/u1/1-a.jpg';
const PREVIEW = `${PHOTO}__thumb`;

test('a photo shown once is kept, and shows again without asking the server', async () => {
    const w = worker({ [PHOTO]: [200, 'image/jpeg', 'full-bytes'] });
    assert.equal(await (await w.get(PHOTO)).text(), 'full-bytes');
    assert.equal(await (await w.get(PHOTO)).text(), 'full-bytes');
    assert.deepEqual(w.network, [PHOTO], 'the second time came from the device');
    assert.ok(w.stores.get('photos-full').has(`${ORIGIN}${PHOTO}`));
});

test('previews go to their own store', async () => {
    const w = worker({ [PREVIEW]: [200, 'image/jpeg', 'small'] });
    await w.get(PREVIEW);
    assert.ok(w.stores.get('photos-previews').has(`${ORIGIN}${PREVIEW}`));
    assert.ok(!w.stores.get('photos-full')?.size);
});

test('offline, a full photo not kept shows its preview', async () => {
    const w = worker({ [PREVIEW]: [200, 'image/jpeg', 'small'] });
    await w.get(PREVIEW);
    w.goOffline();
    assert.equal(await (await w.get(PHOTO)).text(), 'small');
});

test('a preview the server answered with the original (none made yet) is not kept', async () => {
    const w = worker({ [PREVIEW]: [200, 'image/jpeg', 'the original', { 'X-Preview-Stand-In': '1' }] });
    await w.get(PREVIEW);
    assert.ok(!w.stores.get('photos-previews')?.size);
});

test('refusals, other kinds of file, and parts of a file are not kept', async () => {
    const w = worker({
        [PHOTO]: [401, 'application/json', '{"error":"Unauthorized"}'],
        '/api/files/uploads/u1/2-b.zip': [200, 'application/zip', 'zip'],
    });
    await w.get(PHOTO);
    await w.get('/api/files/uploads/u1/2-b.zip');
    assert.ok(!w.stores.get('photos-full')?.size);
    assert.equal(await w.get(PHOTO, { Range: 'bytes=0-10' }), null, 'a range request goes to the network as it is');
});

test('the full-size store keeps under 300 MB, removing the oldest saved first', async () => {
    const w = worker({ [PHOTO]: [200, 'image/jpeg', 'new'] });
    const full = await (async () => {
        // Two big files already kept: 200 MB (older) and 150 MB (newer).
        const cache = new Map([
            [`${ORIGIN}/api/files/old`, new Response('x', { headers: { 'X-Saved-Size': String(200 * MB), 'X-Saved-At': '1' } })],
            [`${ORIGIN}/api/files/newer`, new Response('x', { headers: { 'X-Saved-Size': String(150 * MB), 'X-Saved-At': '2' } })],
        ]);
        w.stores.set('photos-full', cache);
        return cache;
    })();
    await w.get(PHOTO);
    assert.ok(!full.has(`${ORIGIN}/api/files/old`), 'the oldest went');
    assert.ok(full.has(`${ORIGIN}/api/files/newer`));
    assert.ok(full.has(`${ORIGIN}${PHOTO}`));
});

test('kept photos survive an update of the app', async () => {
    const w = worker({ [PHOTO]: [200, 'image/jpeg', 'full-bytes'] });
    await w.get(PHOTO);
    w.stores.set('vayu-design-v1', new Map());
    let done;
    w.listeners.activate({ waitUntil: p => { done = p; } });
    await done;
    assert.ok(w.stores.has('photos-full'));
    assert.ok(!w.stores.has('vayu-design-v1'), 'old app files still go');
});
