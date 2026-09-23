// The three site Workers (frontend/hosts/*): which address serves what, what
// reaches the API, and where old addresses are sent. Each Worker is bundled
// and run against a fake API and a fake set of files.
//
//   node --test frontend/tests/hosts.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'hosts-'));
const workers = {};

before(async () => {
    for (const site of ['app', 'admin', 'welcome']) {
        const file = join(out, `${site}.mjs`);
        await build({ entryPoints: [join(frontend, 'hosts', site, 'worker.ts')], bundle: true, format: 'esm', outfile: file, logLevel: 'silent' });
        workers[site] = (await import(pathToFileURL(file).href)).default;
    }
});
after(() => rmSync(out, { recursive: true, force: true }));

/** Runs one request through a site Worker; `files` are the paths its build has. */
async function visit(site, url, { files = ['/'], navigate = false, headers = {} } = {}) {
    const seen = { api: null, assets: null };
    const env = {
        API: { fetch: async (req) => { seen.api = req; return new Response('api'); } },
        ASSETS: {
            fetch: async (req) => {
                seen.assets = req;
                return files.includes(new URL(req.url).pathname) ? new Response('file') : new Response('nf', { status: 404 });
            },
        },
    };
    const h = new Headers(headers);
    if (navigate) h.set('Sec-Fetch-Mode', 'navigate');
    const res = await workers[site].fetch(new Request(url, { headers: h }), env);
    return { res, seen, location: res.headers.get('Location') };
}

describe('app.ateliersupport.com', () => {
    const APP = 'https://app.ateliersupport.com';

    test('hands every /api call to the API unchanged', async () => {
        for (const path of ['/api/data/artworks', '/api/v2/org/o1/items', '/api/realtime/ws?ticket=t']) {
            const { seen } = await visit('app', APP + path, { headers: { Authorization: 'Bearer x', 'cf-connecting-ip': '203.0.113.9' } });
            assert.equal(seen.api.url, APP + path);
            assert.equal(seen.api.headers.get('Authorization'), 'Bearer x');
            assert.equal(seen.api.headers.get('cf-connecting-ip'), '203.0.113.9');
        }
    });

    test('sends the control centre and website pages to their own addresses', async () => {
        assert.equal((await visit('app', `${APP}/admin`)).location, 'https://admin.ateliersupport.com/');
        assert.equal((await visit('app', `${APP}/welcome`)).location, 'https://ateliersupport.com/');
        assert.equal((await visit('app', `${APP}/signup?mode=signin`)).location, 'https://ateliersupport.com/signup?mode=signin');
    });

    test('serves its own files otherwise', async () => {
        const { res, seen } = await visit('app', `${APP}/`);
        assert.equal(await res.text(), 'file');
        assert.equal(seen.api, null);
    });
});

describe('admin.ateliersupport.com', () => {
    const ADMIN = 'https://admin.ateliersupport.com';

    test('reaches the platform API only', async () => {
        assert.ok((await visit('admin', `${ADMIN}/api/v2/admin/me`)).seen.api);
        assert.ok((await visit('admin', `${ADMIN}/api/v2/auth/get-session`)).seen.api);
        const legacy = await visit('admin', `${ADMIN}/api/data/artworks`);
        assert.equal(legacy.res.status, 404);
        assert.equal(legacy.seen.api, null);
    });

    test('moves the old /admin address to the root', async () => {
        assert.equal((await visit('admin', `${ADMIN}/admin`)).location, `${ADMIN}/`);
        assert.equal((await visit('admin', `${ADMIN}/admin.html`)).location, `${ADMIN}/`);
    });
});

describe('ateliersupport.com', () => {
    const SITE = 'https://ateliersupport.com';
    const files = ['/', '/signup', '/legal', '/sw.js'];

    test('www goes to the bare address, permanently', async () => {
        const { res, location } = await visit('welcome', 'https://www.ateliersupport.com/signup?plan=p', { files });
        assert.equal(res.status, 301);
        assert.equal(location, `${SITE}/signup?plan=p`);
    });

    test('serves the landing page at the root and moves /welcome there', async () => {
        assert.equal(await (await visit('welcome', `${SITE}/`, { files, navigate: true })).res.text(), 'file');
        assert.equal((await visit('welcome', `${SITE}/welcome`, { files })).location, `${SITE}/`);
    });

    test('reaches the API', async () => {
        assert.ok((await visit('welcome', `${SITE}/api/v2/public/plans`, { files })).seen.api);
        // The app's original API, while copies of the app may still be open here.
        assert.ok((await visit('welcome', `${SITE}/api/data/artworks`, { files })).seen.api);
    });

    test('sends old app addresses to the app', async () => {
        assert.equal((await visit('welcome', `${SITE}/artworks?id=7`, { files, navigate: true })).location, 'https://app.ateliersupport.com/artworks?id=7');
        assert.equal((await visit('welcome', `${SITE}/admin`, { files })).location, 'https://admin.ateliersupport.com/');
    });

    test('a missing file that is not a page visit stays a 404', async () => {
        const { res, location } = await visit('welcome', `${SITE}/assets/gone.js`, { files });
        assert.equal(res.status, 404);
        assert.equal(location, null);
    });
});
