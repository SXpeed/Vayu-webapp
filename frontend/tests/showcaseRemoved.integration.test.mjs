// The Showcase was removed (2026-09-29) and its saved data erased with it:
// a workspace that still has its tables loses them, and its archived
// sections, on the next request; its routes are gone.
//
//   node --test frontend/tests/showcaseRemoved.integration.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { sessionTokenFrom, withSessionToken } from './helpers/session.mjs';
import { startDevWorker } from './helpers/devWorker.mjs';

const OWNER = { name: 'Aarav Shah', email: 'owner@example.com', password: 'owner-password-1234' };

// The Showcase's tables as they were, with a section, a favourite and an archived section.
const SHOWCASE_DATA = `
CREATE TABLE roster_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', artwork_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE roster_favorites (user_id TEXT NOT NULL, artwork_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, artwork_id));
INSERT INTO roster_sections (id, name, created_at, updated_at) VALUES ('rs_1', 'New arrivals', 1, 1);
INSERT INTO roster_favorites (user_id, artwork_id, created_at) VALUES ('u_1', 'art_1', 1);
CREATE TABLE IF NOT EXISTS deleted_items (id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', deleted_at INTEGER NOT NULL DEFAULT 0, deleted_by TEXT, deleted_by_name TEXT);
INSERT INTO deleted_items (id, entity, entity_id, summary, deleted_at) VALUES ('del_rs', 'roster_section', 'rs_2', 'Showcase section "Old"', 1);
INSERT INTO deleted_items (id, entity, entity_id, summary, deleted_at) VALUES ('del_art', 'artwork', 'art_9', 'Artwork "Kept"', 1);`;

let worker;
let owner;

async function api(token, path, { method = 'GET', body } = {}) {
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await fetch(`${worker.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: withSessionToken(await res.json().catch(() => null), res) };
}

before(async () => {
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    worker = await startDevWorker({ seedLegacy: { sql: `${schema}\n${SHOWCASE_DATA}` } });
    assert.equal((await api(null, '/auth/setup', { method: 'POST', body: OWNER })).status, 200);
    owner = (await api(null, '/auth/login', { method: 'POST', body: { email: OWNER.email, password: OWNER.password } })).body.token;
});

after(() => { worker?.cleanup(); });

test('its routes are gone', async () => {
    assert.equal((await api(owner, '/roster')).status, 404);
    assert.equal((await api(owner, '/roster/favorites')).status, 404);
    assert.equal((await api(owner, '/auth/me')).body.permissions.roster, undefined, 'no Showcase permission any more');
});

test('its tables and archived sections are erased; everything else stays', async () => {
    assert.equal((await api(owner, '/artworks')).status, 200); // any request cleans the database
    await new Promise(r => setTimeout(r, 1500)); // the erase runs after the response
    await worker.stop();
    const tables = worker.query('VAYU_DB', "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'roster%'").map(r => r.name);
    assert.deepEqual(tables, []);
    const archived = worker.query('VAYU_DB', 'SELECT id FROM deleted_items ORDER BY id').map(r => r.id);
    assert.deepEqual(archived, ['del_art'], 'only the Showcase sections leave the archive');
});
