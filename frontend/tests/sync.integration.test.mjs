// /api/sync, change_log writes, receipt acks and retention against a real
// local D1 + KV (workerd via wrangler's getPlatformProxy). No Cloudflare
// account or network needed; each run uses a fresh temporary database.
//
//   node --test frontend/tests/sync.integration.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { getPlatformProxy } from 'wrangler';
import { load } from './helpers/load.mjs';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const sync = await load('deltaSync.ts');

let proxy;
let persistDir;
let db;
let kv;
let env;
const waits = [];

const execCtx = { waitUntil: p => { waits.push(p); }, passThroughOnException() {} };

function ctxFor(path, token, envOverride = {}) {
    const url = new URL(`https://app.test/api${path}`);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const request = new Request(url, { headers });
    return { request, env: { ...env, ...envOverride }, url, path: url.pathname.slice(4), method: 'GET', execCtx };
}

async function get(path, token, envOverride) {
    const res = await sync.handleSync(ctxFor(path, token, envOverride));
    return { status: res.status, body: await res.json() };
}

async function writeArtwork(id, title) {
    await db.batch([
        db.prepare("INSERT OR REPLACE INTO artworks (id, title, image_urls, created_at) VALUES (?, ?, '[]', ?)").bind(id, title, Date.now()),
        sync.changeLogStmt(db, env, 'artwork', id, 'put', { actorId: 'admin' }),
    ]);
}

async function deleteArtwork(id) {
    await db.batch([
        db.prepare('DELETE FROM artworks WHERE id = ?').bind(id),
        sync.changeLogStmt(db, env, 'artwork', id, 'delete', { actorId: 'admin' }),
    ]);
}

async function session(token, userId, role) {
    await kv.put(`auth:session:${token}`, JSON.stringify({ userId, email: `${userId}@x`, name: userId, role, expiresAt: Date.now() + 3_600_000 }));
    await kv.put(`auth:user:${userId}`, JSON.stringify({ id: userId, name: userId, email: `${userId}@x`, role }));
}

before(async () => {
    persistDir = mkdtempSync(join(tmpdir(), 'vayu-sync-'));
    proxy = await getPlatformProxy({ configPath: join(frontend, 'wrangler.json'), persist: { path: persistDir } });
    db = proxy.env.VAYU_DB;
    kv = proxy.env.VAYU_KV;
    env = { VAYU_DB: db, VAYU_KV: kv, DELTA_SYNC_ENABLED: 'on', WORKSPACE_ID: 'default' };

    // schema.sql, minus comments (some contain semicolons).
    const statements = readFileSync(join(frontend, 'schema.sql'), 'utf8')
        .replace(/--.*$/gm, '')
        .split(';')
        .map(s => s.trim())
        .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();

    await session('t-admin', 'admin1', 'admin');
    await session('t-staff', 'u2', 'user'); // built-in staff: edit on everything but attendance/activity
    await kv.put('auth:roles', JSON.stringify([
        { id: 'viewer', name: 'Viewer', permissions: { messages: 'view' } },
    ]));
    await session('t-viewer', 'u3', 'viewer');
});

after(async () => {
    await Promise.allSettled(waits);
    await proxy?.dispose();
    if (persistDir) rmSync(persistDir, { recursive: true, force: true });
});

test('auth and flag gates', async () => {
    assert.equal((await get('/sync', null)).status, 401);
    assert.equal((await get('/sync', 'bogus')).status, 401);
    assert.equal((await get('/sync', 't-admin', { DELTA_SYNC_ENABLED: 'off' })).status, 404);
    assert.equal((await get('/sync?cursor=-1', 't-admin')).status, 400);
    assert.equal((await get('/sync?cursor=abc', 't-admin')).status, 400);
});

test('empty log: boundary 0, and cursor 0 is a valid incremental cursor', async () => {
    const boundary = await get('/sync', 't-admin');
    assert.deepEqual(boundary.body, { mode: 'boundary', cursor: 0, hasMore: false, changes: [] });
    const page = await get('/sync?cursor=0', 't-admin');
    assert.equal(page.body.mode, 'incremental');
    assert.equal(page.body.cursor, 0);
    assert.equal((await get('/sync?cursor=5', 't-admin')).body.resyncRequired, true, 'cursor ahead of an empty log');
});

test('puts carry the current record; deletes are tombstones; vanished puts degrade', async () => {
    const start = (await get('/sync', 't-admin')).body.cursor;
    await writeArtwork('a1', 'First');
    await writeArtwork('a1', 'First, retitled');
    await writeArtwork('a2', 'Second');
    await deleteArtwork('a2');

    const page = (await get(`/sync?cursor=${start}`, 't-staff')).body;
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.changes.map(c => [c.id, c.op]), [['a1', 'put'], ['a1', 'put'], ['a2', 'delete'], ['a2', 'delete']]);
    assert.equal(page.changes[0].record.title, 'First, retitled', 'records are read at sync time');
    assert.equal(page.changes[2].record, undefined, 'a put whose row is gone becomes a tombstone');
    const seqs = page.changes.map(c => c.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(page.cursor, seqs.at(-1));
});

test('pagination follows hasMore without gaps or repeats', async () => {
    const start = (await get('/sync', 't-admin')).body.cursor;
    for (let i = 0; i < 5; i++) await writeArtwork(`p${i}`, `Paged ${i}`);
    const seen = [];
    let cursor = start;
    for (;;) {
        const page = (await get(`/sync?cursor=${cursor}&limit=2`, 't-admin')).body;
        seen.push(...page.changes.map(c => c.id));
        cursor = page.cursor;
        if (!page.hasMore) break;
    }
    assert.deepEqual(seen, ['p0', 'p1', 'p2', 'p3', 'p4']);
});

test('role filtering hides entities but still advances the cursor', async () => {
    const start = (await get('/sync', 't-admin')).body.cursor;
    await writeArtwork('hidden', 'Viewer may not read artworks');
    const page = (await get(`/sync?cursor=${start}`, 't-viewer')).body;
    assert.deepEqual(page.changes, []);
    assert.equal(page.cursor, start + 1, 'filtered rows must not be re-read forever');
    assert.equal((await get('/sync?snapshot=artwork', 't-viewer')).status, 403);
});

test('chat rows are visible to participants only', async () => {
    await db.prepare(`INSERT INTO conversations (id, participant_ids, participant_names) VALUES ('c1', '["admin1","u3"]', '["A","C"]')`).run();
    const start = (await get('/sync', 't-admin')).body.cursor;
    await db.batch([
        db.prepare("INSERT INTO messages (id, conversation_id, sender_id, sender_name, timestamp, status) VALUES ('m1', 'c1', 'admin1', 'A', 1, 'sent')"),
        sync.changeLogStmt(db, env, 'message', 'm1', 'put', { scope: ['admin1', 'u3'] }),
    ]);
    const member = (await get(`/sync?cursor=${start}`, 't-viewer')).body;
    assert.deepEqual(member.changes.map(c => c.id), ['m1']);
    const outsider = (await get(`/sync?cursor=${start}`, 't-staff')).body;
    assert.deepEqual(outsider.changes, [], 'staff can read messages, but not this conversation');
    assert.equal(outsider.cursor, member.cursor);
});

test('receipt acks: forward-only, atomic with their change row, idempotent, member-checked', async () => {
    const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'message' AND entity_id = 'm1'").first()).n;
    const ack = async (status, options) => {
        const results = await db.batch(sync.statusUpgradeStmts(db, env, 'messages', 'm1', status, { actorId: 'u3', ...options }));
        return results[0].results.length;
    };
    const before = await count();
    assert.equal(await ack('read', { memberId: 'u2' }), 0, 'non-participant cannot mark read');
    assert.equal(await ack('read', { conversationId: 'other' }), 0, 'wrong conversation');
    assert.equal(await count(), before, 'refused acks write no change row');
    assert.equal(await ack('delivered', { memberId: 'u3' }), 1);
    assert.equal(await ack('delivered', { memberId: 'u3' }), 0, 're-ack is a no-op');
    assert.equal(await ack('read', { conversationId: 'c1' }), 1);
    assert.equal(await ack('delivered', {}), 0, 'read never goes back to delivered');
    assert.equal(await count(), before + 2);
    const row = await db.prepare("SELECT scope, actor_id FROM change_log WHERE entity_id = 'm1' ORDER BY seq DESC LIMIT 1").first();
    assert.deepEqual(JSON.parse(row.scope), ['admin1', 'u3']);
    assert.equal(row.actor_id, 'u3');
    assert.equal((await db.prepare("SELECT status FROM messages WHERE id = 'm1'").first()).status, 'read');
});

test('retention prunes old rows, keeps the newest, and expires stale cursors', async () => {
    const { maxSeq } = await db.prepare('SELECT MAX(seq) AS maxSeq FROM change_log').first();
    // Everything so far is "old" relative to a clock far in the future.
    const future = Date.now() + sync.CHANGE_LOG_RETENTION_MS + 60_000;
    const deleted = await sync.pruneChangeLog(env, future);
    assert.ok(deleted > 0);
    const left = await db.prepare('SELECT MIN(seq) AS minSeq, MAX(seq) AS maxSeq, COUNT(*) AS n FROM change_log').first();
    assert.equal(left.n, 1, 'only the newest row survives');
    assert.equal(left.maxSeq, maxSeq, 'the boundary never moves backwards');

    const stale = (await get('/sync?cursor=1', 't-admin')).body;
    assert.equal(stale.resyncRequired, true);
    assert.equal(stale.cursor, maxSeq);
    const fresh = (await get(`/sync?cursor=${maxSeq - 1}`, 't-admin')).body;
    assert.equal(fresh.mode, 'incremental', 'a cursor right before the kept row is still valid');
});
