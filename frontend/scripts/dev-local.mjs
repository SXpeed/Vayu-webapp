// A private copy of the app on this computer, for testing: its own database,
// test logins and sample artworks. Nothing here reaches the live site.
//
//   npm run dev:local            start (sets itself up the first time)
//   npm run dev:local -- --reset wipe the local data and start fresh
//
// Then open http://localhost:5173 (the app), /admin.html (control centre).
// The data lives in frontend/.wrangler/local-test (git-ignored).
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const state = join(frontend, '.wrangler', 'local-test');
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const API_PORT = 8787;
const APP_PORT = 5173;
const API = `http://127.0.0.1:${API_PORT}/api`;

/** Test logins. Local only: they exist in this computer's test database and nowhere else. */
const ACCOUNTS = {
    admin: { name: 'Test Admin', email: 'admin@test.local', password: 'localtest-admin' },
    staff: { name: 'Test Staff', email: 'staff@test.local', password: 'localtest-staff' },
};

/** Sample artworks: one available, one reserved, one sold, each with a photo. */
const SAMPLE_ARTWORKS = [
    { title: 'Monsoon I', artist: 'Test Artist', artworkYear: '2024', medium: 'Oil on canvas', dimensions: '36 × 48 in', status: 'Available', price: 250000, plusGst: true, description: 'Sample artwork for local testing.', colors: [[46, 74, 98], [196, 164, 102]] },
    { title: 'Salt Flats at Dusk', artist: 'Test Artist', artworkYear: '2023', medium: 'Acrylic on linen', dimensions: '30 × 30 in', status: 'Reserved', price: 180000, description: 'Sample artwork for local testing.', colors: [[214, 160, 120], [92, 70, 110]] },
    { title: 'Untitled 42', artist: 'Another Artist', artworkYear: '2022', medium: 'Charcoal on paper', dimensions: '22 × 30 in', status: 'Sold', price: 90000, description: 'Sample artwork for local testing.', colors: [[40, 40, 40], [220, 214, 200]] },
];

/** A small gradient PNG, so sample artworks have a real photo. */
function gradientPng(w, h, [[r1, g1, b1], [r2, g2, b2]]) {
    const crc32 = (buf) => {
        let crc = 0xffffffff;
        for (const byte of buf) {
            crc ^= byte;
            for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        }
        return (crc ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const t = (x / w + y / h) / 2;
            const o = y * (w * 3 + 1) + 1 + x * 3;
            raw[o] = r1 + (r2 - r1) * t; raw[o + 1] = g1 + (g2 - g1) * t; raw[o + 2] = b1 + (b2 - b1) * t;
        }
    }
    const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// System tools by their full path, never whatever comes first on PATH.
const SYSTEM32 = join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32');
const TASKKILL = join(SYSTEM32, 'taskkill.exe');
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find(p => existsSync(p));

/** Ends a process and everything it started (on Windows a plain kill leaves wrangler's workerd running). */
function killTree(pid, child) {
    if (process.platform === 'win32') {
        try { execFileSync(TASKKILL, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    } else if (child) {
        child.kill();
    } else {
        try { process.kill(pid); } catch { /* already gone */ }
    }
}

/** The process listening on a port, if any: { pid, command } (command is empty where it can't be read). */
function portOwner(port) {
    if (process.platform !== 'win32') {
        if (!LSOF) return null;
        try {
            const pid = execFileSync(LSOF, ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0];
            return pid ? { pid: Number(pid), command: '' } : null;
        } catch { return null; }
    }
    const script = `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; `
        + `if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($c.OwningProcess)|$($p.CommandLine)" }`;
    try {
        const out = execFileSync(POWERSHELL, ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
        if (!out) return null;
        const [pid, ...rest] = out.split('|');
        return { pid: Number(pid), command: rest.join('|') };
    } catch { return null; }
}

/**
 * Both ports must be free. A server left running by an earlier local test
 * copy of this project (for example when its window was closed) is stopped;
 * anything else is left alone, and we say what is in the way.
 */
function clearPorts() {
    // Compare paths with one kind of slash, whatever the platform wrote.
    const norm = (p) => p.replaceAll('\\', '/').toLowerCase();
    let ours = norm(frontend);
    if (ours.endsWith('/')) ours = ours.slice(0, -1);
    for (const port of [API_PORT, APP_PORT]) {
        const owner = portOwner(port);
        if (!owner) continue;
        if (owner.command && norm(owner.command).includes(ours)) {
            console.log(`Stopping a leftover local test server on port ${port}.`);
            killTree(owner.pid);
            continue;
        }
        const what = owner.command ? `:\n  ${owner.command.slice(0, 160)}` : '';
        console.error(`Port ${port} is in use by another program${what}.\nClose it and try again.`);
        process.exit(1);
    }
}

if (process.argv.includes('--reset')) {
    rmSync(state, { recursive: true, force: true });
    console.log('Local test data wiped.');
}
mkdirSync(state, { recursive: true });
clearPorts();

const wrangler = (args, opts = {}) =>
    execFileSync(process.execPath, [wranglerBin, ...args], { cwd: frontend, stdio: 'pipe', encoding: 'utf8', ...opts });

// ── Database, the first time ──
const marker = join(state, 'set-up');
if (!existsSync(marker)) {
    console.log('Setting up the local test database…');
    wrangler(['d1', 'execute', 'VAYU_DB', '--local', '-c', 'wrangler.json', '--persist-to', state, '--file', 'schema.sql']);
    wrangler(['d1', 'migrations', 'apply', 'PLATFORM_DB', '--local', '-c', 'wrangler.json', '--persist-to', state]);
    // The control centre's own login (a separate account system).
    execFileSync(process.execPath, [join(frontend, 'scripts/create-provider-admin.mjs'),
        '--email', ACCOUNTS.admin.email, '--name', ACCOUNTS.admin.name, '--persist-to', state],
        { cwd: frontend, stdio: 'pipe', env: { ...process.env, ADMIN_PASSWORD: ACCOUNTS.admin.password } });
}

// Platform database changes added since this copy was made (applied ones are skipped).
wrangler(['d1', 'migrations', 'apply', 'PLATFORM_DB', '--local', '-c', 'wrangler.json', '--persist-to', state]);

// Secrets for this local copy only, kept so sign-ins survive a restart.
const secretsFile = join(state, 'secrets.json');
if (!existsSync(secretsFile)) {
    writeFileSync(secretsFile, JSON.stringify({
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        PAYMENT_SECRETS_KEY: randomBytes(32).toString('base64'),
    }));
}
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));

// ── The API and the app ──
const children = [];
const start = (name, args, env = {}) => {
    const child = spawn(process.execPath, args, { cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    child.on('exit', code => {
        if (!stopping) { console.error(`\n${name} stopped (exit ${code}). Last output:\n${log.slice(-1500)}`); stop(1); }
    });
    children.push(child);
    return () => log;
};
let stopping = false;
function stop(code = 0) {
    stopping = true;
    for (const child of children) killTree(child.pid, child);
    process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

start('Local API', [wranglerBin, 'dev', '-c', 'wrangler.json', '--local', '--persist-to', state, '--port', String(API_PORT),
    '--var', `AUTH_ORIGINS:http://localhost:${APP_PORT}`, '--var', 'PLATFORM_ENV:development', '--var', 'ADMIN_REQUIRE_2FA:off',
    // As in production: files need the app's sign-in or its file cookie.
    '--var', 'FILE_AUTH:on',
    '--var', `BETTER_AUTH_SECRET:${secrets.BETTER_AUTH_SECRET}`, '--var', `PAYMENT_SECRETS_KEY:${secrets.PAYMENT_SECRETS_KEY}`]);

async function waitFor(url, what) {
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    console.error(`${what} did not start.`);
    stop(1);
}
await waitFor(`${API}/auth/status`, 'The local API');

// ── Test logins and sample artworks, the first time ──
async function call(path, { token, method = 'GET', body, form } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, { method, headers, body: form ?? (body && JSON.stringify(body)) });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
}

if (!existsSync(marker)) {
  try {
    const { needsSetup } = await call('/auth/status');
    if (needsSetup) await call('/auth/setup', { method: 'POST', body: ACCOUNTS.admin });
    const { token } = await call('/auth/login', { method: 'POST', body: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password } });
    // A re-run after an interrupted first start finds the staff login already there.
    await call('/auth/users', { token, method: 'POST', body: ACCOUNTS.staff }).catch(e => {
        if (!/409|already/i.test(e.message)) throw e;
    });
    for (const [i, art] of SAMPLE_ARTWORKS.entries()) {
        const form = new FormData();
        form.append('file', new File([gradientPng(400, 500, art.colors)], `sample-${i}.png`, { type: 'image/png' }));
        const { url } = await call('/upload', { token, method: 'POST', form });
        const { colors, ...fields } = art;
        await call('/artworks', { token, method: 'POST', body: { id: `art_sample_${i}`, customId: `TEST-${101 + i}`, imageUrls: [url], createdAt: Date.now(), ...fields } });
    }
    writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    console.error(`Setting up the test logins failed: ${e.message}
Try again, or start fresh with: npm run dev:local -- --reset`);
    stop(1);
  }
}

// ── Workspaces, the first time (after the original app's logins exist) ──
// "Vayu (local)" works on the original app's data, with its people brought
// in (same passwords); "Second Studio" has its own empty storage. The admin
// owns both, so the workspace chooser shows.
const workspacesMarker = join(state, 'workspaces-set-up');
if (!existsSync(workspacesMarker)) {
  try {
    const jar = new Map();
    const platform = async (path, body) => {
        const res = await fetch(`${API}/v2${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${APP_PORT}`, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
            body: body && JSON.stringify(body),
        });
        for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
        const json = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
        return json;
    };
    await platform('/auth/sign-in/email', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password });
    const vayu = await platform('/admin/orgs', { name: 'Vayu (local)', businessType: 'gallery', ownerEmail: ACCOUNTS.admin.email });
    await platform(`/admin/orgs/${vayu.id}/app-storage`, { storage: 'original', confirm: vayu.slug });
    await platform(`/admin/orgs/${vayu.id}/import-original-people`, { dryRun: false });
    await platform('/admin/orgs', { name: 'Second Studio', businessType: 'studio', ownerEmail: ACCOUNTS.admin.email });
    writeFileSync(workspacesMarker, new Date().toISOString());
  } catch (e) {
    console.error(`Setting up the test workspaces failed: ${e.message}
Try again, or start fresh with: npm run dev:local -- --reset`);
    stop(1);
  }
}

start('App', [join(frontend, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(APP_PORT), '--strictPort'],
    { VITE_API_PROXY: `http://127.0.0.1:${API_PORT}` });
await waitFor(`http://localhost:${APP_PORT}/`, 'The app');

console.log(`
  Local test copy is running (nothing here touches the live site).

    App             http://localhost:${APP_PORT}
    Control centre  http://localhost:${APP_PORT}/admin.html

    Admin   ${ACCOUNTS.admin.email} / ${ACCOUNTS.admin.password}   (app and control centre; owns both workspaces)
    Staff   ${ACCOUNTS.staff.email} / ${ACCOUNTS.staff.password}   (Vayu (local) only)

    Workspaces: "Vayu (local)" uses the original app's data; "Second Studio" has its own.

  Ctrl+C to stop. Start fresh with: npm run dev:local -- --reset
`);
