// End-to-end smoke test of delta sync + the SyncHub Durable Object against a
// LOCAL `wrangler dev` (workerd runs the real Worker and hub; D1/KV are local
// files in a temp dir). Nothing touches Cloudflare.
//
//   node frontend/tests/realtime.smoke.mjs
//
// Exits non-zero on the first failed check.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), 'vayu-smoke-'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const results = [];

function check(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { results.push(['ok', name]); console.log(`ok   ${name}`); },
        err => { results.push(['FAIL', name]); console.log(`FAIL ${name}\n     ${err.message}`); throw err; },
    );
}

async function api(path, { token, method = 'GET', body } = {}) {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
}

/** Open a socket and collect frames; resolves once it opens or fails. */
function openSocket(ticket, origin = BASE) {
    const frames = [];
    const waiters = [];
    const url = `ws://localhost:${PORT}/api/realtime/ws?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(url, origin === null ? {} : { headers: { Origin: origin } });
    const state = { closeCode: null, frames, ws };
    ws.onmessage = event => {
        if (event.data === 'pong') return;
        const frame = JSON.parse(event.data);
        frames.push(frame);
        for (const w of [...waiters]) if (w.match(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
    };
    state.next = (match, timeoutMs = 5_000) => {
        const hit = frames.find(match);
        if (hit) { frames.splice(frames.indexOf(hit), 1); return Promise.resolve(hit); }
        return new Promise((resolve, reject) => {
            const w = { match, resolve: f => { clearTimeout(t); frames.splice(frames.indexOf(f), 1); resolve(f); } };
            const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timed out waiting for frame')); }, timeoutMs);
            waiters.push(w);
        });
    };
    state.closed = new Promise(resolve => { ws.onclose = e => { state.closeCode = e.code; resolve(e.code); }; });
    state.opened = new Promise(resolve => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
    });
    return state;
}

async function waitForServer(child) {
    const deadline = Date.now() + 90_000;
    let exited = false;
    child.on('exit', () => { exited = true; });
    while (Date.now() < deadline && !exited) {
        try { await fetch(`${BASE}/api/auth/status`); return; } catch { await new Promise(r => setTimeout(r, 500)); }
    }
    throw new Error('wrangler dev did not start');
}

// ── Boot ─────────────────────────────────────────────────────────────────────
execFileSync(npx, ['wrangler', 'd1', 'execute', 'vayu-messaging-db', '--local', '--persist-to', persist, '--file', 'schema.sql'], {
    cwd: frontend, stdio: 'ignore', shell: process.platform === 'win32',
});
const child = spawn(npx, [
    'wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', persist,
    '--var', 'DELTA_SYNC_ENABLED:on', '--var', 'REALTIME_ENABLED:on',
    '--var', 'REALTIME_SECRET:local-smoke-secret-not-for-production',
], { cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let serverLog = '';
child.stdout.on('data', d => { serverLog += d; });
child.stderr.on('data', d => { serverLog += d; });

let exitCode = 0;
try {
    await waitForServer(child);

    // ── Auth ─────────────────────────────────────────────────────────────────
    let token;
    await check('setup + login', async () => {
        assert.equal((await api('/auth/setup', { method: 'POST', body: { name: 'Smoke Admin', email: 'smoke@test.local', password: 'smoke-pass' } })).status, 200);
        const login = await api('/auth/login', { method: 'POST', body: { email: 'smoke@test.local', password: 'smoke-pass' } });
        assert.equal(login.status, 200);
        token = login.data.token;
    });

    let boundary;
    await check('sync boundary + unauthenticated sync refused', async () => {
        assert.equal((await api('/sync')).status, 401);
        const b = await api('/sync', { token });
        assert.equal(b.data.mode, 'boundary');
        boundary = b.data.cursor;
    });

    // ── Socket ───────────────────────────────────────────────────────────────
    let socket;
    let ticket;
    await check('ticket requires a session', async () => {
        assert.equal((await api('/realtime/ticket', { method: 'POST' })).status, 401);
        const t = await api('/realtime/ticket', { method: 'POST', token });
        assert.equal(t.status, 200);
        ticket = t.data.ticket;
    });

    await check('socket opens and hub says ready', async () => {
        socket = openSocket(ticket);
        assert.equal(await socket.opened, true);
        const ready = await socket.next(f => f.type === 'ready');
        assert.ok(ready.leaseUntil > Date.now());
    });

    await check('a replayed ticket is refused', async () => {
        const replay = openSocket(ticket);
        assert.equal(await replay.opened, false);
    });

    await check('a foreign or missing Origin is refused', async () => {
        const t1 = (await api('/realtime/ticket', { method: 'POST', token })).data.ticket;
        assert.equal(await openSocket(t1, 'https://evil.example').opened, false);
        const t2 = (await api('/realtime/ticket', { method: 'POST', token })).data.ticket;
        assert.equal(await openSocket(t2, null).opened, false);
    });

    await check('a garbage ticket is refused', async () => {
        assert.equal(await openSocket('v1.nope.nope').opened, false);
    });

    await check('a REST write reaches the socket as an invalidate', async () => {
        const created = await api('/artworks', { method: 'POST', token, body: { id: 'smoke-art-1', title: 'Smoke', imageUrls: [], createdAt: Date.now() } });
        assert.equal(created.status, 201, JSON.stringify(created.data));
        const frame = await socket.next(f => f.type === 'invalidate' && f.events.some(e => e.id === 'smoke-art-1'));
        assert.deepEqual(frame.events.find(e => e.id === 'smoke-art-1'), { entity: 'artwork', id: 'smoke-art-1', op: 'put' });
    });

    await check('delta sync returns the write with its record', async () => {
        const page = await api(`/sync?cursor=${boundary}`, { token });
        const change = page.data.changes.find(c => c.id === 'smoke-art-1');
        assert.equal(change.op, 'put');
        assert.equal(change.record.title, 'Smoke');
    });

    await check('delete arrives as invalidate + tombstone', async () => {
        assert.equal((await api('/artworks/smoke-art-1', { method: 'DELETE', token })).status, 200);
        await socket.next(f => f.type === 'invalidate' && f.events.some(e => e.id === 'smoke-art-1' && e.op === 'delete'));
        const page = await api(`/sync?cursor=${boundary}`, { token });
        assert.deepEqual(page.data.changes.filter(c => c.id === 'smoke-art-1').map(c => c.op), ['delete', 'delete']);
    });

    await check('re-auth with a fresh ticket renews the lease', async () => {
        const fresh = (await api('/realtime/ticket', { method: 'POST', token })).data.ticket;
        socket.ws.send(JSON.stringify({ type: 'reauth', ticket: fresh }));
        const ready = await socket.next(f => f.type === 'ready');
        assert.ok(ready.leaseUntil > Date.now());
    });

    await check('presence comes from the hub while connected', async () => {
        const team = await api('/auth/team', { token });
        assert.equal(team.status, 200);
        const me = team.data.find(u => u.email === 'smoke@test.local');
        assert.equal(me?.isOnline, true);
    });

    await check('a heartbeat-only client (older app) still shows online while the hub is up', async () => {
        const created = await api('/auth/users', { method: 'POST', token, body: { name: 'Old Client', email: 'old@test.local', password: 'old-pass-1', role: 'user' } });
        assert.ok(created.status === 200 || created.status === 201, JSON.stringify(created.data));
        const oldToken = (await api('/auth/login', { method: 'POST', body: { email: 'old@test.local', password: 'old-pass-1' } })).data.token;
        assert.equal((await api('/auth/presence/heartbeat', { method: 'POST', token: oldToken })).status, 200);
        const team = (await api('/auth/team', { token })).data;
        assert.equal(team.find(u => u.email === 'old@test.local')?.isOnline, true, 'heartbeat user');
        assert.equal(team.find(u => u.email === 'smoke@test.local')?.isOnline, true, 'socket user');
    });

    // ── Device limit ─────────────────────────────────────────────────────────
    const loginAs = async (email, password, ua) => {
        const res = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
            body: JSON.stringify({ email, password }),
        });
        return (await res.json()).token;
    };
    const works = async t => (await api('/auth/me', { token: t })).status === 200;
    let staffTokens = [];

    await check('device limit: the 3rd login signs out the device used longest ago (default 2)', async () => {
        // "old@test.local" already holds one session (from the presence check).
        const t2 = await loginAs('old@test.local', 'old-pass-1', 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36');
        const t3 = await loginAs('old@test.local', 'old-pass-1', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36');
        assert.equal(await works(t2), true);
        assert.equal(await works(t3), true);
        const users = (await api('/auth/users', { token })).data;
        const old = users.find(u => u.email === 'old@test.local');
        assert.equal(old.deviceLimit, 2);
        assert.equal(old.devices.length, 2);
        assert.deepEqual(old.devices.map(d => d.label).sort(), ['Chrome on Android', 'Chrome on Windows']);
        staffTokens = [t2, t3];
    });

    await check('a signed-out device gets 401 with reason "device-limit"', async () => {
        // The first session of old@test.local was created in the presence check.
        const users = (await api('/auth/users', { token })).data;
        assert.equal(users.find(u => u.email === 'old@test.local').devices.length, 2);
        const newest = await loginAs('old@test.local', 'old-pass-1', 'Mozilla/5.0 (iPhone) Safari/604.1');
        const res = await api('/auth/me', { token: staffTokens[0] });
        assert.equal(res.status, 401);
        assert.equal(res.data.reason, 'device-limit');
        assert.equal(res.data.error, 'Unauthorized', 'older app versions still recognise the 401');
        assert.equal(await works(staffTokens[1]), true);
        assert.equal(await works(newest), true);
        staffTokens = [staffTokens[1], newest];
    });

    await check('lowering the limit signs out extra devices immediately; admins are unlimited', async () => {
        const users = (await api('/auth/users', { token })).data;
        const old = users.find(u => u.email === 'old@test.local');
        const updated = await api(`/auth/users/${old.id}`, { method: 'PUT', token, body: { maxDevices: 1 } });
        assert.equal(updated.status, 200, JSON.stringify(updated.data));
        assert.equal(updated.data.maxDevices, 1);
        assert.equal(updated.data.devices.length, 1);
        const alive = [await works(staffTokens[0]), await works(staffTokens[1])];
        assert.deepEqual(alive, [false, true], 'the less recently used device goes');
        assert.equal((await api(`/auth/users/${old.id}`, { method: 'PUT', token, body: { maxDevices: 99 } })).status, 400);
        const back = await api(`/auth/users/${old.id}`, { method: 'PUT', token, body: { maxDevices: null } });
        assert.equal(back.data.maxDevices, undefined);
        assert.equal(back.data.deviceLimit, 2);

        const adminTokens = [];
        for (let i = 0; i < 4; i++) adminTokens.push(await loginAs('smoke@test.local', 'smoke-pass', 'Firefox/131.0'));
        for (const t of adminTokens) assert.equal(await works(t), true, 'admin logins are never limited');
    });

    await check('everyone can list their own devices, with this device marked', async () => {
        const mine = await api('/auth/devices', { token: staffTokens[1] });
        assert.equal(mine.status, 200);
        assert.equal(mine.data.limit, 2);
        assert.equal(mine.data.devices.filter(d => d.current).length, 1, 'exactly one "this device"');
        assert.ok(mine.data.devices.every(d => !('token' in d)), 'tokens are never exposed');
        const admin = await api('/auth/devices', { token });
        assert.equal(admin.data.limit, null, 'admins: unlimited');
        assert.equal((await api('/auth/devices')).status, 401);
    });

    await check('logging out frees the device slot', async () => {
        const users = (await api('/auth/users', { token })).data;
        const before = users.find(u => u.email === 'old@test.local').devices.length;
        assert.equal((await api('/auth/logout', { method: 'POST', token: staffTokens[1] })).status, 200);
        const after = (await api('/auth/users', { token })).data.find(u => u.email === 'old@test.local').devices.length;
        assert.equal(after, before - 1);
    });

    await check('logout revokes the socket (4403)', async () => {
        assert.equal((await api('/auth/logout', { method: 'POST', token })).status, 200);
        const code = await Promise.race([socket.closed, new Promise(r => setTimeout(() => r('timeout'), 5_000))]);
        assert.equal(code, 4403);
        assert.equal((await api('/realtime/ticket', { method: 'POST', token })).status, 401);
    });
} catch {
    exitCode = 1;
    if (process.env.SMOKE_VERBOSE) console.log(serverLog);
} finally {
    child.kill();
    if (process.platform === 'win32' && child.pid) {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(persist, { recursive: true, force: true }); } catch { /* files still locked on Windows */ }
    console.log(`\n${results.filter(r => r[0] === 'ok').length}/${results.length} checks passed`);
    process.exit(exitCode);
}
