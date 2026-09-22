// Starts the real Worker with `wrangler dev --local` (workerd), so tests can
// exercise Durable Objects, which the lighter getPlatformProxy harness cannot
// run. Gives back a fetch client with a cookie jar per simulated browser.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const frontend = fileURLToPath(new URL('../..', import.meta.url));
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

const runWrangler = (args, opts = {}) =>
    execFileSync(process.execPath, [wranglerBin, ...args], { cwd: frontend, encoding: 'utf8', ...opts });

/**
 * Applies the platform migrations to a fresh local database, creates one
 * provider admin, and starts the Worker.
 */
export async function startDevWorker({ port = 8810, inspectorPort = 9240, adminEmail = 'admin@example.com', adminPassword = 'provider-admin-password' } = {}) {
    const persistDir = mkdtempSync(join(tmpdir(), 'as-dev-'));
    const origin = `http://127.0.0.1:${port}`;

    runWrangler(['d1', 'migrations', 'apply', 'PLATFORM_DB', '--local', '-c', 'wrangler.json', '--persist-to', persistDir], { stdio: 'pipe' });
    execFileSync(process.execPath, [join(frontend, 'scripts/create-provider-admin.mjs'),
        '--email', adminEmail, '--name', 'Test Admin', '--persist-to', persistDir],
        { cwd: frontend, stdio: 'pipe', env: { ...process.env, ADMIN_PASSWORD: adminPassword } });

    const child = spawn(process.execPath, [wranglerBin, 'dev', '-c', 'wrangler.json', '--local',
        '--persist-to', persistDir, '--port', String(port), '--inspector-port', String(inspectorPort),
        '--var', `AUTH_ORIGINS:${origin}`, '--var', 'PLATFORM_ENV:development', '--var', 'ADMIN_REQUIRE_2FA:off',
        '--var', `PAYMENT_SECRETS_KEY:${randomBytes(32).toString('base64')}`,
        '--var', `BETTER_AUTH_SECRET:${randomBytes(32).toString('base64')}`,
    ], { cwd: frontend, stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (/Ready on/.test(log)) break;
        if (child.exitCode !== null) throw new Error(`wrangler dev exited: ${log.slice(-1500)}`);
        await new Promise(r => setTimeout(r, 400));
    }
    if (!/Ready on/.test(log)) throw new Error(`wrangler dev did not start: ${log.slice(-1500)}`);
    // Wait for the first request to succeed (workerd finishes wiring up bindings).
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`${origin}/api/v2/public/login-methods`);
            if (res.ok) break;
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }

    /** One simulated browser: its own cookie jar. */
    function browser() {
        const jar = new Map();
        return {
            jar,
            async call(path, { method = 'GET', body, headers = {} } = {}) {
                const h = new Headers(headers);
                if (jar.size) h.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
                if (body !== undefined) h.set('Content-Type', 'application/json');
                if (method !== 'GET' && !h.has('Origin')) h.set('Origin', origin);
                const res = await fetch(`${origin}/api/v2${path}`, {
                    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
                });
                for (const c of res.headers.getSetCookie?.() ?? []) {
                    const [pair] = c.split(';');
                    const i = pair.indexOf('=');
                    const value = pair.slice(i + 1);
                    if (value === '' || /max-age=0/i.test(c)) jar.delete(pair.slice(0, i));
                    else jar.set(pair.slice(0, i), value);
                }
                const text = await res.text();
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                return { status: res.status, body: json, text };
            },
            signIn(email, password) {
                return this.call('/auth/sign-in/email', { method: 'POST', body: { email, password } });
            },
        };
    }

    return {
        origin,
        browser,
        log: () => log,
        async stop() {
            child.kill();
            await new Promise(r => setTimeout(r, 500));
            try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
        },
    };
}

export { frontend, readFileSync };
