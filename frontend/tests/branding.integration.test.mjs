// Platform branding: the name, tagline and logo set from the control panel.
//
//   node --test frontend/tests/branding.integration.test.mjs
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { hashPassword } from 'better-auth/crypto';
import { startPlatform } from './helpers/platform.mjs';

const PASSWORD = 'correct horse battery';

let h;
let admin;
let r2;

/** A real PNG of the given size (signature + IHDR + one IDAT + IEND). */
function png(width, height) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crcTable = [...Array(256).keys()].map(n => {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            return c >>> 0;
        });
        let crc = 0xffffffff;
        for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([len, body, crcBuf]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    const raw = Buffer.alloc((width * 3 + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

before(async () => {
    // A tiny stand-in for R2: the platform code only put()s and get()s.
    const store = new Map();
    r2 = {
        put: async (key, value, opts) => { store.set(key, { body: Buffer.from(value), httpMetadata: opts?.httpMetadata }); },
        get: async (key) => store.get(key) ?? null,
        _store: store,
    };
    h = await startPlatform({ ADMIN_REQUIRE_2FA: 'off', VAYU_R2: r2 });
    await h.createUser('admin-1', 'admin@example.com', await hashPassword(PASSWORD));
    await h.db.prepare("INSERT INTO provider_admins (user_id, role, status, created_at) VALUES ('admin-1', 'owner', 'active', ?)").bind(Date.now()).run();
    admin = h.browser();
    assert.equal((await admin.call('/auth/sign-in/email', { method: 'POST', body: { email: 'admin@example.com', password: PASSWORD } })).status, 200);
});

after(async () => { await h?.stop(); });

const upload = (body, type) => admin.call('/admin/settings/branding/logo', {
    method: 'POST', headers: { 'Content-Type': type }, body,
});

test('the name and tagline can be changed, and anyone can read them', async () => {
    let res = await admin.call('/public/branding');
    assert.equal(res.body.appName, 'ateliersupport', 'the built-in name until it is changed');
    assert.equal(res.body.logoUrl, null);

    res = await admin.call('/admin/settings/branding', { method: 'PATCH', body: { appName: 'Atelier Support', tagline: 'Software for galleries', accentColor: '#b8860b' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.appName, 'Atelier Support');

    const pub = await admin.call('/public/branding');
    assert.equal(pub.body.appName, 'Atelier Support');
    assert.equal(pub.body.tagline, 'Software for galleries');
    assert.equal(pub.body.accentColor, '#b8860b');

    const audit = await h.db.prepare("SELECT 1 FROM platform_audit WHERE action = 'branding.update'").first();
    assert.ok(audit, 'the change is audited');
});

test('a bad name or colour is refused', async () => {
    assert.equal((await admin.call('/admin/settings/branding', { method: 'PATCH', body: { appName: 'x' } })).body.code, 'invalid');
    assert.equal((await admin.call('/admin/settings/branding', { method: 'PATCH', body: { accentColor: 'red' } })).body.code, 'invalid');
    assert.equal((await admin.call('/public/branding')).body.appName, 'Atelier Support', 'nothing changed');
});

test('only a real image is accepted as a logo', async () => {
    // Not an image at all, despite the declared type.
    let res = await upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not a readable/);

    // SVG is refused outright.
    res = await upload(Buffer.from('<svg></svg>'), 'image/svg+xml');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PNG, JPEG or WebP/);

    // A real PNG that claims to be a JPEG.
    res = await upload(png(128, 128), 'image/jpeg');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /is a image\/png/);

    // Too small, and too large.
    assert.equal((await upload(png(32, 32), 'image/png')).status, 400);
    assert.equal((await upload(png(4096, 64), 'image/png')).status, 400);
    assert.equal((await admin.call('/public/branding')).body.logoUrl, null, 'nothing was stored');
});

test('a real logo is stored and served with a versioned address', async () => {
    const res = await upload(png(256, 256), 'image/png');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.logoVersion, 1);
    assert.match(res.body.logoKey, /^platform\/branding\/logo-[0-9a-f-]+\.png$/);

    const pub = await admin.call('/public/branding');
    assert.equal(pub.body.logoUrl, '/api/v2/public/branding/logo?v=1');

    const file = await h.platform.handlePlatformRequest(
        new Request('https://admin.test/api/v2/public/branding/logo?v=1'), { ...h.env, VAYU_R2: r2 },
    );
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('Content-Type'), 'image/png');
    assert.match(file.headers.get('Cache-Control'), /immutable/);

    // A second upload gets a new address, so caches fetch it.
    const again = await upload(png(300, 300), 'image/png');
    assert.equal(again.body.logoVersion, 2);
    assert.notEqual(again.body.logoKey, res.body.logoKey);
    assert.equal((await admin.call('/public/branding')).body.logoUrl, '/api/v2/public/branding/logo?v=2');
});

test('branding is provider-admin only', async () => {
    const stranger = h.browser();
    assert.equal((await stranger.call('/admin/settings/branding')).status, 401);
    assert.equal((await stranger.call('/admin/settings/branding', { method: 'PATCH', body: { appName: 'Hijacked' } })).status, 401);
    assert.equal((await admin.call('/public/branding')).body.appName, 'Atelier Support');
});

test('an organization can have its own logo, set by a provider admin', async () => {
    await h.createUser('owner-1', 'owner@example.com', await hashPassword(PASSWORD));
    let res = await admin.call('/admin/orgs', { method: 'POST', body: { name: 'Logo Studio', businessType: 'studio', ownerEmail: 'owner@example.com' } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const orgId = res.body.id;
    const owner = h.browser();
    assert.equal((await owner.call('/auth/sign-in/email', { method: 'POST', body: { email: 'owner@example.com', password: PASSWORD } })).status, 200);

    assert.equal((await admin.call(`/admin/orgs/${orgId}`)).body.logoUrl, null, 'none until one is set');
    assert.equal((await owner.call('/me/orgs')).body.organizations[0].logoUrl, null);

    // The same checks as the platform logo.
    res = await admin.call(`/admin/orgs/${orgId}/logo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('<svg></svg>') });
    assert.equal(res.status, 400);

    res = await admin.call(`/admin/orgs/${orgId}/logo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(200, 200) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const url = `/api/v2/public/orgs/${orgId}/logo?v=1`;
    assert.equal(res.body.logoUrl, url);
    assert.equal((await admin.call(`/admin/orgs/${orgId}`)).body.logoUrl, url);
    assert.equal((await owner.call('/me/orgs')).body.organizations[0].logoUrl, url, 'its members see it in their workspace list');
    assert.ok(await h.db.prepare("SELECT 1 FROM platform_audit WHERE action = 'org.logo.upload'").first(), 'audited');

    const file = await h.platform.handlePlatformRequest(new Request(`https://app.test${url}`), { ...h.env, VAYU_R2: r2 });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('Content-Type'), 'image/png');

    // The platform logo is untouched by an organization's.
    assert.equal((await admin.call('/public/branding')).body.logoUrl, '/api/v2/public/branding/logo?v=2');

    // Removing it goes back to none; a later upload gets a fresh address.
    res = await admin.call(`/admin/orgs/${orgId}/logo`, { method: 'DELETE' });
    assert.equal(res.body.logoUrl, null);
    assert.equal((await h.platform.handlePlatformRequest(new Request(`https://app.test${url}`), { ...h.env, VAYU_R2: r2 })).status, 404);
    res = await admin.call(`/admin/orgs/${orgId}/logo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png(200, 200) });
    assert.equal(res.body.logoUrl, `/api/v2/public/orgs/${orgId}/logo?v=2`);

    // Only provider admins can change it — not even the organization's owner.
    assert.equal((await owner.call(`/admin/orgs/${orgId}/logo`, { method: 'DELETE' })).status, 403);
    assert.equal((await h.browser().call(`/admin/orgs/${orgId}/logo`, { method: 'DELETE' })).status, 401);
    assert.equal((await admin.call('/admin/orgs/no-such-org/logo', { method: 'DELETE' })).status, 404);
});
