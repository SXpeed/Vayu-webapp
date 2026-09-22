import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../services/refreshScheduler.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { createRefreshScheduler } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function harness(run, initialDelayMs = 0) {
    let time = 0;
    let enabled = true;
    let timer;
    const scheduler = createRefreshScheduler({
        run, intervalMs: 100, initialDelayMs,
        now: () => time, enabled: () => enabled,
        setTimer: (callback, delay) => { timer = { callback, at: time + delay }; return 1; },
        clearTimer: () => { timer = undefined; },
    });
    return { scheduler, setTime: value => { time = value; }, setEnabled: value => { enabled = value; }, timer: () => timer };
}

test('coalesces simultaneous focus, online and timer triggers', async () => {
    let calls = 0;
    let finish;
    const h = harness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const pending = h.scheduler.request();
    await h.scheduler.request();
    assert.equal(calls, 1);
    finish(); await pending;
    await h.scheduler.request();
    assert.equal(calls, 1);
    assert.equal(h.timer().at, 100);
});

test('hidden/offline pauses until eligible and overdue', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; });
    h.setEnabled(false);
    await h.scheduler.request();
    assert.equal(calls, 0);
    assert.equal(h.timer(), undefined);
    h.setEnabled(true);
    await h.scheduler.request();
    assert.equal(calls, 1);
});

test('failure backoff cannot be bypassed by focus events; success resets it', async () => {
    let calls = 0;
    const h = harness(async () => { if (++calls <= 2) throw new Error('offline'); });
    await h.scheduler.request();
    assert.equal(h.timer().at, 200);
    h.setTime(100); await h.scheduler.request();
    assert.equal(calls, 1);
    h.setTime(200); await h.scheduler.request();
    assert.equal(h.timer().at, 600);
    h.setTime(600); await h.scheduler.request();
    assert.equal(h.timer().at, 700);
});

test('cleanup during a request never schedules further work', async () => {
    let finish;
    const h = harness(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.scheduler.request();
    h.scheduler.stop();
    finish(); await pending;
    assert.equal(h.timer(), undefined);
});

test('initial delay prevents a duplicate bootstrap refresh', async () => {
    let calls = 0;
    const h = harness(async () => { calls++; }, 200);
    await h.scheduler.request();
    assert.equal(calls, 0);
    h.setTime(200); await h.scheduler.request();
    assert.equal(calls, 1);
});
