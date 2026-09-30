// Scheduled jobs (platform/jobs.ts): each outcome is recorded, a failure is
// emailed to the provider at most once an hour per job, and System health
// says when the jobs last ran and which are failing.
//
//   node --test frontend/tests/jobs.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';
import { fakeD1 } from './helpers/fakeD1.mjs';

const jobs = await load('platform/jobs.ts');

async function setup(providerEmail = 'ops@example.com') {
    const db = fakeD1();
    if (providerEmail) {
        await db.prepare("INSERT INTO platform_settings (key, value, updated_at) VALUES ('notifications', ?, 0)").bind(JSON.stringify({ providerEmail })).run();
    }
    return db;
}
const alerts = async db => (await db.prepare("SELECT recipient, subject, body FROM notification_outbox WHERE kind = 'system_alert'").all()).results;

test('nothing recorded yet: health says so', async () => {
    const h = await jobs.jobsHealth(await setup());
    assert.equal(h.ok, false);
    assert.match(h.detail, /No scheduled run recorded yet/);
});

test('a run with jobs that worked is healthy', async () => {
    const db = await setup();
    await jobs.recordRun(db);
    await jobs.runJob(db, 'email', async () => {});
    await jobs.runJob(db, 'payment-reconciliation', async () => {});
    const h = await jobs.jobsHealth(db);
    assert.equal(h.ok, true, h.detail);
    assert.deepEqual(h.jobs.map(j => [j.name, j.ok]), [['email', true], ['payment-reconciliation', true]]);
    assert.equal((await alerts(db)).length, 0);
});

test('a failing job: recorded, shown, and emailed once an hour however often it fails; the others still run', async () => {
    const db = await setup();
    await jobs.recordRun(db);
    let ranAfter = false;
    await jobs.runJob(db, 'key-rotation', async () => { throw new Error('D1 unavailable: https://x.example/?token=abc123'); });
    await jobs.runJob(db, 'key-rotation', async () => { throw new Error('D1 unavailable again'); });
    await jobs.runJob(db, 'email', async () => { ranAfter = true; });
    assert.equal(ranAfter, true, 'a failure never stops the next job');

    const h = await jobs.jobsHealth(db);
    assert.equal(h.ok, false);
    assert.match(h.detail, /Failing: key-rotation/);
    const job = h.jobs.find(j => j.name === 'key-rotation');
    assert.ok(job.failingSince <= job.at, 'remembers when it started failing');
    assert.ok(!JSON.stringify(h).includes('abc123'), 'tokens in error text are hidden');

    const sent = await alerts(db);
    assert.equal(sent.length, 1, 'one alert this hour');
    assert.equal(sent[0].recipient, 'ops@example.com');
    assert.match(sent[0].subject, /key-rotation/);

    // Working again: healthy.
    await jobs.runJob(db, 'key-rotation', async () => {});
    assert.equal((await jobs.jobsHealth(db)).ok, true);
});

test('no provider address: still recorded and shown, nothing queued', async () => {
    const db = await setup(null);
    await jobs.recordRun(db);
    await jobs.runJob(db, 'email', async () => { throw new Error('boom'); });
    assert.equal((await jobs.jobsHealth(db)).ok, false);
    assert.equal((await alerts(db)).length, 0);
});

test('the cron stopping shows up', async () => {
    const db = await setup();
    await jobs.recordRun(db);
    const h = await jobs.jobsHealth(db, Date.now() + jobs.JOBS_STALE_MS + 60_000);
    assert.equal(h.ok, false);
    assert.match(h.detail, /cron trigger may be off/);
});
