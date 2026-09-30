// Bot protection (Cloudflare Turnstile) on the public forms that send email,
// against the real Worker, with a stand-in for Cloudflare's siteverify
// service: sign-up and "Forgot password?" need a good answer; signing in
// doesn't. Off entirely until both keys are set (platformAuth tests).
//
//   node --test frontend/tests/turnstile.integration.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

const ADMIN = { email: 'admin@example.com', password: 'provider-admin-password' };
const SECRET = 'test-turnstile-secret';
const GOOD = 'a-good-answer';

let worker;
let siteverify;
const checked = [];

before(async () => {
    // Cloudflare's siteverify, as far as these tests need it.
    siteverify = createServer((req, res) => {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            const { secret, response } = JSON.parse(body);
            checked.push({ secret, response });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(secret === SECRET && response === GOOD ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
        });
    }).listen(0, '127.0.0.1');
    await new Promise(r => siteverify.once('listening', r));
    worker = await startDevWorker({
        vars: {
            TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: SECRET,
            TURNSTILE_VERIFY_URL: `http://127.0.0.1:${siteverify.address().port}/siteverify`,
        },
    });
    const admin = worker.browser();
    assert.equal((await admin.signIn(ADMIN.email, ADMIN.password)).status, 200);
    assert.equal((await admin.call('/admin/settings/login-methods', {
        method: 'PUT', body: { emailPassword: { signIn: true, signUp: true }, google: { signIn: false, signUp: false } },
    })).status, 200);
});

after(async () => { await worker?.stop(); worker?.cleanup(); siteverify?.close(); });

const signUp = (headers = {}) => worker.browser().call('/auth/sign-up/email', {
    method: 'POST', headers, body: { name: 'New Person', email: `new-${checked.length}-${Date.now()}@example.com`, password: 'a long enough password' },
});

test('the sign-in settings carry the site key, so the forms show the check', async () => {
    const res = await worker.browser().call('/public/login-methods');
    assert.equal(res.body.turnstileSiteKey, 'test-site-key');
});

test('creating an account needs a good answer', async () => {
    assert.equal((await signUp()).status, 400, 'no answer');
    assert.equal((await signUp({ 'x-captcha-response': 'a-bad-answer' })).status, 403, 'wrong answer');
    const ok = await signUp({ 'x-captcha-response': GOOD });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(checked.at(-1).secret, SECRET, 'checked with the secret key, server side');
});

test('"Forgot password?" needs a good answer too', async () => {
    const ask = (headers) => worker.browser().call('/auth/request-password-reset', { method: 'POST', headers, body: { email: 'someone@example.com', redirectTo: '/' } });
    assert.equal((await ask({})).status, 400);
    assert.equal((await ask({ 'x-captcha-response': GOOD })).status, 200);
});

test('signing in is left alone (already rate limited)', async () => {
    const before = checked.length;
    const res = await worker.browser().signIn(ADMIN.email, ADMIN.password);
    assert.equal(res.status, 200);
    assert.equal(checked.length, before);
});
