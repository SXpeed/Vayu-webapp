// Sign-in requests must never hang, whichever request happened to build the
// shared Better Auth instance. On a real Worker (workerd), a request cannot
// wait on a promise that belongs to another request; production hung every
// other /api/v2/auth/get-session once a public request had built the instance
// (2026-09-23). The in-process harness cannot see this, so this runs the real
// Worker. Caveat: the local database answers so fast that the original bug
// does not reproduce here (this test passed before the fix too); it guards
// the request sequence. The production check is repeating
// `curl https://ateliersupport.com/api/v2/auth/get-session` several times.
//
//   node --test frontend/tests/authHang.integration.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startDevWorker } from './helpers/devWorker.mjs';

let worker;

before(async () => {
    // Starting up calls /api/v2/public/login-methods, which is what builds the
    // instance in production too (the landing and sign-up pages call it first).
    worker = await startDevWorker({ port: 8816, inspectorPort: 9246 });
});
after(async () => { await worker?.stop(); });

/** One call, failing (rather than waiting) if it does not answer in time. */
async function answered(path) {
    const res = await fetch(`${worker.origin}/api/v2${path}`, { signal: AbortSignal.timeout(8000) });
    await res.text();
    return res.status;
}

test('sign-in checks answer every time after a public request built the auth instance', async () => {
    for (let i = 0; i < 6; i++) {
        assert.equal(await answered('/public/plans'), 200, `public/plans #${i}`);
        assert.equal(await answered('/auth/get-session'), 200, `get-session #${i}`);
        assert.equal(await answered('/auth/ok'), 200, `auth/ok #${i}`);
    }
});

test('concurrent first requests all answer', async () => {
    const statuses = await Promise.all([
        answered('/public/branding'), answered('/auth/get-session'), answered('/public/plans'), answered('/auth/get-session'),
    ]);
    assert.deepEqual(statuses, [200, 200, 200, 200]);
});
