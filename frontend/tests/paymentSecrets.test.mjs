// Payment credential encryption and key rotation (platform/secrets.ts,
// platform/secretRotation.ts).
//
//   node --test frontend/tests/paymentSecrets.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, webcrypto } from 'node:crypto';
import { load } from './helpers/load.mjs';
import { fakeD1 } from './helpers/fakeD1.mjs';

const secrets = await load('platform/secrets.ts');
const rotation = await load('platform/secretRotation.ts');

const newKey = () => randomBytes(32).toString('base64');
const K0 = newKey();
const K1 = newKey();
const ctx = (org, field = 'key_secret') => `${org}|razorpay|${field}`;
const actor = { userId: 'admin-1', ip: null };

/** A value in the first format (v1), as stored before key ids existed. */
async function v1Envelope(rawKey, context, plaintext) {
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(rawKey, 'base64'), 'AES-GCM', false, ['encrypt']);
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, key, new TextEncoder().encode(plaintext)));
    return `v1.${Buffer.from(iv).toString('base64')}.${Buffer.from(ct).toString('base64')}`;
}

/** Quietly, the structured failure lines a test expects. */
async function capturingErrors(fn) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try { return { result: await fn(), lines }; } finally { console.error = original; }
}

test('round trip: new values are v2 under the active key and decrypt back', async () => {
    const env = { PAYMENT_SECRETS_KEY: K0 };
    const enc = await secrets.encryptSecret(env, ctx('org-a'), 'rzp-secret-value-1234');
    assert.match(enc, /^v2\.k0\./);
    assert.equal(secrets.envelopeKid(enc), 'k0');
    assert.equal(await secrets.decryptSecret(env, ctx('org-a'), enc), 'rzp-secret-value-1234');
});

test('each value gets its own nonce', async () => {
    const env = { PAYMENT_SECRETS_KEY: K0 };
    const a = await secrets.encryptSecret(env, ctx('org-a'), 'same');
    const b = await secrets.encryptSecret(env, ctx('org-a'), 'same');
    assert.notEqual(a.split('.')[2], b.split('.')[2]);
});

test('another organization or another field cannot decrypt a copied value', async () => {
    const env = { PAYMENT_SECRETS_KEY: K0 };
    const enc = await secrets.encryptSecret(env, ctx('org-a'), 'org-a-secret');
    await assert.rejects(secrets.decryptSecret(env, ctx('org-b'), enc), e => e.reason === 'auth_failed');
    await assert.rejects(secrets.decryptSecret(env, ctx('org-a', 'webhook_secret'), enc), e => e.reason === 'auth_failed');
});

test('tampering is rejected: ciphertext, nonce and key id', async () => {
    const env = { PAYMENT_SECRETS_KEYS: JSON.stringify({ k1: K1 }), PAYMENT_SECRETS_KEY: K0 };
    const enc = await secrets.encryptSecret(env, ctx('org-a'), 'tamper-me');
    const [v, kid, iv, ct] = enc.split('.');
    const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
    await assert.rejects(secrets.decryptSecret(env, ctx('org-a'), [v, kid, iv, flip(ct)].join('.')), e => e.reason === 'auth_failed');
    await assert.rejects(secrets.decryptSecret(env, ctx('org-a'), [v, kid, flip(iv), ct].join('.')), e => e.reason === 'auth_failed');
    // Claiming another configured key id: the id is in the associated data, so it fails.
    await assert.rejects(secrets.decryptSecret(env, ctx('org-a'), [v, 'k1', iv, ct].join('.')), e => e.reason === 'auth_failed');
    await assert.rejects(secrets.decryptSecret(env, ctx('org-a'), 'v9.x.y'), e => e.reason === 'format');
});

test('old values (v1) still decrypt with the original key', async () => {
    const env = { PAYMENT_SECRETS_KEY: K0 };
    const old = await v1Envelope(K0, ctx('org-a'), 'legacy-secret');
    assert.equal(secrets.envelopeKid(old), 'k0');
    assert.equal(await secrets.decryptSecret(env, ctx('org-a'), old), 'legacy-secret');
    await assert.rejects(secrets.decryptSecret(env, ctx('org-b'), old), e => e.reason === 'auth_failed');
});

test('old and new keys work side by side; only the active key encrypts', async () => {
    const before = { PAYMENT_SECRETS_KEY: K0 };
    const after = { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_KEYS: JSON.stringify({ k1: K1 }), PAYMENT_SECRETS_ACTIVE_KID: 'k1' };
    const underK0 = await secrets.encryptSecret(before, ctx('org-a'), 'written-before');
    const underK1 = await secrets.encryptSecret(after, ctx('org-a'), 'written-after');
    assert.match(underK1, /^v2\.k1\./);
    assert.equal(await secrets.decryptSecret(after, ctx('org-a'), underK0), 'written-before');
    // A Worker that doesn't have k1 yet can't read k1 values: an error naming the key, not a guess.
    await assert.rejects(secrets.decryptSecret(before, ctx('org-a'), underK1), e => e.reason === 'unknown_key' && e.kid === 'k1');
});

test('misconfiguration is refused with a message that never contains key material', () => {
    const cases = [
        {},
        { PAYMENT_SECRETS_KEY: 'too-short' },
        { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_ACTIVE_KID: 'k7' },
        { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_KEYS: '{not json' },
        { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_KEYS: JSON.stringify({ k0: K1 }) },
        { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_KEYS: JSON.stringify({ k1: 'c2hvcnQ=' }) },
    ];
    for (const env of cases) {
        assert.equal(secrets.secretsConfigured(env), false, JSON.stringify(Object.keys(env)));
        assert.throws(() => secrets.keyRing(env), e => e instanceof secrets.SecretsUnavailable && !e.message.includes(K0) && !e.message.includes(K1));
    }
});

test('a decryption failure is reported as one sanitized line, and callers get null', async () => {
    const env = { PAYMENT_SECRETS_KEY: K0 };
    const enc = await secrets.encryptSecret(env, ctx('org-a'), 'super-secret-value');
    const { result, lines } = await capturingErrors(() => secrets.tryDecryptSecret(env, ctx('org-b'), enc, 'test'));
    assert.equal(result, null);
    assert.equal(lines.length, 1);
    const logged = JSON.parse(lines[0]);
    assert.deepEqual({ event: logged.event, org: logged.org, reason: logged.reason, kid: logged.kid }, { event: 'secret_decrypt_failed', org: 'org-b', reason: 'auth_failed', kid: 'k0' });
    assert.ok(!lines[0].includes('super-secret-value') && !lines[0].includes(enc));
});

// ── Rotation ────────────────────────────────────────────────────────────

async function seedIntegrations(db, env, count) {
    for (let i = 0; i < count; i++) {
        const org = `org-${String(i).padStart(3, '0')}`;
        await db.prepare("INSERT INTO organizations (id, slug, name, business_type, created_at, updated_at) VALUES (?, ?, ?, 'studio', 0, 0)").bind(org, org, org).run();
        // A mix of formats, as a real database would have: v1 from before, v2 under k0.
        const keySecret = i % 2 ? await v1Envelope(K0, ctx(org), `key-${org}`) : await secrets.encryptSecret(env, ctx(org), `key-${org}`);
        const webhook = await secrets.encryptSecret(env, ctx(org, 'webhook_secret'), `hook-${org}`);
        await db.prepare(`INSERT INTO org_payment_integrations (org_id, provider, mode, key_id, key_secret_enc, webhook_secret_enc, status, connected_at, updated_at)
            VALUES (?, 'razorpay', 'test', ?, ?, ?, 'verified', 0, 0)`).bind(org, `rzp_test_${String(i).padStart(8, '0')}`, keySecret, webhook).run();
    }
}

async function seedBilling(db, env) {
    const account = {
        mode: 'test', keyId: 'rzp_test_platform01', status: 'verified',
        keySecretEnc: await secrets.encryptSecret(env, 'platform|razorpay-billing|key_secret', 'platform-key'),
        webhookSecretEnc: await v1Envelope(K0, 'platform|razorpay-billing|webhook_secret', 'platform-hook'),
    };
    await db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('billing_razorpay', ?, 0)").bind(JSON.stringify(account)).run();
}

const rotated = { PAYMENT_SECRETS_KEY: K0, PAYMENT_SECRETS_KEYS: JSON.stringify({ k1: K1 }), PAYMENT_SECRETS_ACTIVE_KID: 'k1' };

test('rotation re-encrypts everything in batches, resumes after an interruption, and verifies', async () => {
    const db = fakeD1();
    await seedIntegrations(db, { PAYMENT_SECRETS_KEY: K0 }, 7);
    await seedBilling(db, { PAYMENT_SECRETS_KEY: K0 });

    const before = await rotation.keyUsage(rotated, db, true);
    assert.deepEqual(before.byKid, { k0: 16 });
    assert.deepEqual(before.unreadable, []);

    await rotation.startRotation(rotated, db, actor);
    let state = await rotation.runRotationBatch(rotated, db, actor, 3);
    assert.equal(state.running, true);
    assert.equal(state.cursor, 'org-002');
    // Interrupted here (a timeout, a deploy): nothing is lost, and the next run carries on.
    state = await rotation.runRotationBatch(rotated, db, null, 3);
    assert.equal(state.cursor, 'org-005');
    state = await rotation.runRotationBatch(rotated, db, null, 3);
    assert.equal(state.running, false);
    assert.ok(state.finishedAt);
    assert.equal(state.reencrypted, 16);
    assert.deepEqual(state.failures, []);

    const after = await rotation.keyUsage(rotated, db, true);
    assert.deepEqual(after.byKid, { k1: 16 });
    assert.deepEqual(after.unreadable, []);
    // Every secret reads back the same under the new key.
    const row = await db.prepare("SELECT key_secret_enc FROM org_payment_integrations WHERE org_id = 'org-003'").first();
    assert.equal(await secrets.decryptSecret(rotated, ctx('org-003'), row.key_secret_enc), 'key-org-003');

    // Running it again changes nothing (idempotent).
    await rotation.startRotation(rotated, db, actor);
    state = await rotation.runRotationBatch(rotated, db, actor, 50);
    assert.equal(state.reencrypted, 0);
    const audit = await db.prepare("SELECT count(*) AS n FROM platform_audit WHERE action LIKE 'secrets.rotation.%'").first();
    assert.equal(audit.n, 4);
});

test('a value that cannot be read is left untouched and reported, and the rest still rotate', async () => {
    const db = fakeD1();
    await seedIntegrations(db, { PAYMENT_SECRETS_KEY: K0 }, 3);
    // One row encrypted under a key this Worker doesn't have (lost, or not deployed yet).
    const foreign = await secrets.encryptSecret({ PAYMENT_SECRETS_KEY: newKey() }, ctx('org-001'), 'unknown');
    await db.prepare("UPDATE org_payment_integrations SET key_secret_enc = ? WHERE org_id = 'org-001'").bind(foreign).run();

    await rotation.startRotation(rotated, db, actor);
    const { result: state, lines } = await capturingErrors(() => rotation.runRotationBatch(rotated, db, actor, 10));
    assert.equal(state.running, false);
    assert.equal(state.failures.length, 1);
    assert.deepEqual(state.failures[0], { target: 'org-001', field: 'key_secret_enc', reason: 'auth_failed' });
    assert.ok(lines.some(l => l.includes('secret_decrypt_failed')) && !lines.some(l => l.includes('unknown')));
    const kept = await db.prepare("SELECT key_secret_enc FROM org_payment_integrations WHERE org_id = 'org-001'").first();
    assert.equal(kept.key_secret_enc, foreign, 'the unreadable value is kept as it was, not overwritten');
    const usage = await rotation.keyUsage(rotated, db, true);
    assert.equal(usage.byKid.k0, 1);
    assert.equal(usage.unreadable.length, 1);
});

test('a row changed during the rotation keeps the newer value (conditional update)', async () => {
    const db = fakeD1();
    await seedIntegrations(db, { PAYMENT_SECRETS_KEY: K0 }, 1);
    // Someone replaces the keys between the rotation's read and its write.
    const original = db.prepare.bind(db);
    let swapped = false;
    db.prepare = (sql) => {
        if (!swapped && sql.startsWith('UPDATE org_payment_integrations SET key_secret_enc')) {
            swapped = true;
            return { bind: (...args) => ({ run: async () => {
                const fresh = await secrets.encryptSecret(rotated, ctx('org-000'), 'replaced-by-admin');
                await original("UPDATE org_payment_integrations SET key_secret_enc = ? WHERE org_id = 'org-000'").bind(fresh).run();
                return original(sql).bind(...args).run();
            } }) };
        }
        return original(sql);
    };
    await rotation.startRotation(rotated, db, actor);
    const state = await rotation.runRotationBatch(rotated, db, actor, 10);
    assert.equal(state.skippedChanged, 1);
    db.prepare = original;
    const row = await db.prepare("SELECT key_secret_enc FROM org_payment_integrations WHERE org_id = 'org-000'").first();
    assert.equal(await secrets.decryptSecret(rotated, ctx('org-000'), row.key_secret_enc), 'replaced-by-admin');
});

test('changing the active key mid-rotation stops it instead of writing under an unexpected key', async () => {
    const db = fakeD1();
    await seedIntegrations(db, { PAYMENT_SECRETS_KEY: K0 }, 4);
    await rotation.startRotation(rotated, db, actor);
    await rotation.runRotationBatch(rotated, db, actor, 2);
    const k2 = newKey();
    const changed = { ...rotated, PAYMENT_SECRETS_KEYS: JSON.stringify({ k1: K1, k2 }), PAYMENT_SECRETS_ACTIVE_KID: 'k2' };
    const state = await rotation.runRotationBatch(changed, db, null, 2);
    assert.equal(state.running, false);
    assert.equal(state.failures.at(-1).reason, 'active_key_changed');
    const usage = await rotation.keyUsage(changed, db, true);
    assert.equal(usage.byKid.k2 ?? 0, 0);
    assert.deepEqual(usage.unreadable, []);
});

test('key usage names keys that still hold values but are no longer configured', async () => {
    const db = fakeD1();
    await seedIntegrations(db, rotated, 2);
    const withoutK1 = { PAYMENT_SECRETS_KEY: K0 };
    const usage = await rotation.keyUsage(withoutK1, db, true);
    assert.deepEqual(usage.missingKeys, ['k1']);
    // org-001's key secret is v1 under k0, still readable; the three k1 values are not.
    assert.equal(usage.unreadable.length, 3);
});

test('key usage and rotation work on a database from before migration 0010', async () => {
    const db = fakeD1({ before: '0010' });
    await seedIntegrations(db, { PAYMENT_SECRETS_KEY: K0 }, 2);
    assert.deepEqual((await rotation.keyUsage(rotated, db, true)).byKid, { k0: 4 });
    await rotation.startRotation(rotated, db, actor);
    const state = await rotation.runRotationBatch(rotated, db, actor, 10);
    assert.equal(state.reencrypted, 4);
    assert.deepEqual((await rotation.keyUsage(rotated, db, true)).byKid, { k1: 4 });
});
