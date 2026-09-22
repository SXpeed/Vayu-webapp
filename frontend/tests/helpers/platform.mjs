// Shared harness for platform (/api/v2) integration tests: a fresh local D1
// with every platform migration applied, simulated browsers with cookie jars,
// and TOTP codes. No network.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { load } from './load.mjs';

const frontend = fileURLToPath(new URL('../..', import.meta.url));

/** Splits a migration file into statements, keeping trigger bodies whole. */
export function sqlStatements(text) {
    const parts = text.replace(/--.*$/gm, '').split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(Boolean);
    const merged = [];
    for (const s of parts) {
        const last = merged.at(-1);
        if (last && /\bBEGIN\b/i.test(last) && !/\bEND$/i.test(last)) merged[merged.length - 1] = `${last};\n${s}`;
        else merged.push(s);
    }
    return merged;
}

export async function startPlatform(envExtra = {}) {
    const platform = await load('platform/routes.ts');
    const persistDir = mkdtempSync(join(tmpdir(), 'as-platform-'));
    const proxy = await getPlatformProxy({ configPath: join(frontend, 'wrangler.json'), persist: { path: persistDir } });
    const db = proxy.env.PLATFORM_DB;
    const dir = join(frontend, 'platform/migrations');
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
        for (const statement of sqlStatements(readFileSync(join(dir, file), 'utf8'))) await db.prepare(statement).run();
    }
    const env = {
        PLATFORM_DB: db,
        BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
        AUTH_ORIGINS: 'https://admin.test,https://app.test',
        ...envExtra,
    };
    let nextIp = 10;

    /** One simulated browser: own cookie jar and IP (sign-in is rate limited per IP). */
    function browser(origin = 'https://admin.test', ip = `203.0.113.${nextIp++ % 250}`) {
        const jar = new Map();
        return {
            jar,
            async call(path, { method = 'GET', body, headers = {}, envOverride = {} } = {}) {
                const h = new Headers(headers);
                if (jar.size) h.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
                if (body !== undefined) h.set('Content-Type', 'application/json');
                if (method !== 'GET' && !h.has('Origin')) h.set('Origin', origin);
                h.set('cf-connecting-ip', ip);
                const req = new Request(`${origin}/api/v2${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
                const res = await platform.handlePlatformRequest(req, { ...env, ...envOverride });
                for (const c of res.headers.getSetCookie?.() ?? []) {
                    const [pair] = c.split(';');
                    const i = pair.indexOf('=');
                    const name = pair.slice(0, i);
                    const value = pair.slice(i + 1);
                    if (value === '' || /max-age=0/i.test(c)) jar.delete(name); else jar.set(name, value);
                }
                const text = await res.text();
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                return { status: res.status, body: json, text, headers: res.headers };
            },
        };
    }

    async function createUser(id, email, passwordHash) {
        const now = new Date().toISOString();
        await db.batch([
            db.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 1, ?, ?, 0)').bind(id, id, email, now, now),
            db.prepare("INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, 'credential', ?, ?, ?, ?)").bind(`acc-${id}`, id, id, passwordHash, now, now),
        ]);
    }

    async function stop() {
        await proxy.dispose();
        rmSync(persistDir, { recursive: true, force: true });
    }

    return { platform, db, env, browser, createUser, stop };
}

export function totp(secretBase32, time = Date.now()) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
    const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
    const mac = createHmac('sha1', key).update(counter).digest();
    const offset = mac[mac.length - 1] & 0xf;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
