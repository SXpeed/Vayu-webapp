// Starts the real Worker with `wrangler dev --local` (workerd), so tests can
// exercise Durable Objects, which the lighter getPlatformProxy harness cannot
// run. Gives back a fetch client with a cookie jar per simulated browser.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export async function startDevWorker({ port = 8810, inspectorPort = 9240, adminEmail = 'admin@example.com', adminPassword = 'provider-admin-password', seedLegacy, vars = {} } = {}) {
    const persistDir = mkdtempSync(join(tmpdir(), 'as-dev-'));
    const origin = `http://127.0.0.1:${port}`;

    /** Runs SQL against a local D1 database in this test's storage. */
    const execSql = (binding, sql) => {
        const file = join(persistDir, `seed-${Date.now()}.sql`);
        writeFileSync(file, Array.isArray(sql) ? sql.map(s => `${s};`).join('\n') : sql);
        return runWrangler(['d1', 'execute', binding, '--local', '-c', 'wrangler.json', '--persist-to', persistDir, '--file', file, '--json'], { stdio: 'pipe' });
    };

    // Seeding happens before the Worker starts, so nothing else holds the
    // database files.
    if (seedLegacy?.sql) execSql('VAYU_DB', seedLegacy.sql);
    for (const [key, value] of seedLegacy?.kv ?? []) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        runWrangler(['kv', 'key', 'put', key, text, '--binding', 'VAYU_KV', '--local', '-c', 'wrangler.json', '--persist-to', persistDir], { stdio: 'pipe' });
    }

    runWrangler(['d1', 'migrations', 'apply', 'PLATFORM_DB', '--local', '-c', 'wrangler.json', '--persist-to', persistDir], { stdio: 'pipe' });
    execFileSync(process.execPath, [join(frontend, 'scripts/create-provider-admin.mjs'),
        '--email', adminEmail, '--name', 'Test Admin', '--persist-to', persistDir],
        { cwd: frontend, stdio: 'pipe', env: { ...process.env, ADMIN_PASSWORD: adminPassword } });

    const child = spawn(process.execPath, [wranglerBin, 'dev', '-c', 'wrangler.json', '--local',
        '--persist-to', persistDir, '--port', String(port), '--inspector-port', String(inspectorPort),
        '--var', `AUTH_ORIGINS:${origin}`, '--var', 'PLATFORM_ENV:development', '--var', 'ADMIN_REQUIRE_2FA:off',
        '--var', `PAYMENT_SECRETS_KEY:${randomBytes(32).toString('base64')}`,
        '--var', `BETTER_AUTH_SECRET:${randomBytes(32).toString('base64')}`,
        ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
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
                // '/api/…' is used as is (the app's routes); anything else is under /api/v2.
                const res = await fetch(path.startsWith('/api/') ? `${origin}${path}` : `${origin}/api/v2${path}`, {
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
                return { status: res.status, body: json, text, location: res.headers.get('Location') };
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
        /**
         * Emails "sent" so far. Locally the send_email binding writes each
         * message's text to a file and logs where; this reads them back.
         */
        emails() {
            const plain = log.replace(/\u001b\[[0-9;]*m/g, '');
            const out = [];
            for (const block of plain.split('send_email binding called with MessageBuilder:').slice(1)) {
                const to = /^To: (.+)$/m.exec(block)?.[1]?.trim();
                const subject = /^Subject: (.+)$/m.exec(block)?.[1]?.trim();
                const file = /^Text: (.+\.txt)\s*$/m.exec(block)?.[1]?.trim();
                out.push({ to, subject, text: file ? readFileSync(file, 'utf8') : '' });
            }
            return out;
        },
        /** Reads from the legacy shared database (after the Worker stops). */
        queryLegacy(sql) {
            const out = execSql('VAYU_DB', sql);
            const parsed = JSON.parse(out.slice(out.indexOf('[')));
            return parsed[0]?.results ?? [];
        },
        /** Stops the Worker; storage stays so it can still be inspected. */
        async stop() {
            if (child.exitCode === null) {
                // On Windows, killing wrangler leaves its workerd child running,
                // so end the whole process tree.
                if (process.platform === 'win32') {
                    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
                } else {
                    child.kill();
                }
                await new Promise(r => setTimeout(r, 500));
            }
        },
        cleanup() {
            try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
        },
    };
}

export { frontend, readFileSync };
