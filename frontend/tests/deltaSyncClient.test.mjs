import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { createDeltaSync, memoryCursor } = await load('services/deltaSyncClient.ts');

/** A scripted /api/sync: `pages` maps a cursor (or 'boundary') to a response. */
function harness(pages, extra = {}) {
    const log = [];
    const applied = [];
    let current = true;
    const cursor = memoryCursor();
    const engine = createDeltaSync({
        fetchPage: async c => {
            log.push(c === null ? 'boundary' : `page:${c}`);
            const key = c === null ? 'boundary' : c;
            const answer = typeof pages[key] === 'function' ? pages[key]() : pages[key];
            if (answer instanceof Error) throw answer;
            return answer === undefined ? { cursor: c, hasMore: false, changes: [] } : answer;
        },
        ...cursor,
        fullLoad: async () => { log.push('full'); },
        applyChanges: async changes => { applied.push(...changes.map(ch => ch.seq)); },
        isCurrent: () => current,
        ...extra,
    }, extra.now);
    return { engine, log, applied, cursor, signOut: () => { current = false; } };
}

const change = seq => ({ seq, entity: 'artwork', id: `a${seq}`, op: 'put', record: { id: `a${seq}` } });

test('first run: boundary, then full copy, then changes after the boundary', async () => {
    const h = harness({
        boundary: { mode: 'boundary', cursor: 10 },
        10: { mode: 'incremental', cursor: 12, hasMore: false, changes: [change(11), change(12)] },
    });
    assert.equal(await h.engine.run(), 'synced');
    assert.deepEqual(h.log, ['boundary', 'full', 'page:10']);
    assert.deepEqual(h.applied, [11, 12]);
    assert.equal(h.cursor.loadCursor(), 12);
});

test('later runs are incremental only and follow hasMore', async () => {
    const h = harness({
        boundary: { cursor: 0 },
        0: { cursor: 2, hasMore: true, changes: [change(1), change(2)] },
        2: { cursor: 3, hasMore: false, changes: [change(3)] },
    });
    await h.engine.run();
    assert.deepEqual(h.log, ['boundary', 'full', 'page:0', 'page:2']);
    h.log.length = 0;
    await h.engine.run();
    assert.deepEqual(h.log, ['page:3'], 'an empty log (cursor 0) is a valid cursor, not "no cursor"');
});

test('the cursor only advances after its page was applied', async () => {
    let fail = true;
    const h = harness({
        boundary: { cursor: 5 },
        5: { cursor: 6, hasMore: false, changes: [change(6)] },
    }, {
        applyChanges: async () => { if (fail) throw new Error('storage full'); },
    });
    await assert.rejects(h.engine.run());
    assert.equal(h.cursor.loadCursor(), 5, 'page 6 must be re-read');
    fail = false;
    assert.equal(await h.engine.run(), 'synced');
    assert.equal(h.cursor.loadCursor(), 6);
});

test('a failed full copy leaves no cursor behind', async () => {
    const h = harness({ boundary: { cursor: 5 } }, { fullLoad: async () => { throw new Error('offline'); } });
    await assert.rejects(h.engine.run());
    assert.equal(h.cursor.loadCursor(), null);
});

test('resyncRequired: take a fresh full copy from the new boundary', async () => {
    const h = harness({
        boundary: { cursor: 50 },
        7: { resyncRequired: true, cursor: 50 },
        50: { cursor: 51, hasMore: false, changes: [change(51)] },
    });
    h.cursor.saveCursor(7);
    assert.equal(await h.engine.run(), 'synced');
    assert.deepEqual(h.log, ['page:7', 'boundary', 'full', 'page:50']);
    assert.equal(h.cursor.loadCursor(), 51);
});

test('resyncRequired twice in one run fails instead of looping', async () => {
    const h = harness({ boundary: { cursor: 1 }, 1: { resyncRequired: true, cursor: 1 } });
    h.cursor.saveCursor(1);
    await assert.rejects(h.engine.run(), /twice/);
    assert.equal(h.cursor.loadCursor(), null);
});

test('requests during a run coalesce into exactly one more pass', async () => {
    let release;
    let calls = 0;
    const h = harness({
        boundary: { cursor: 1 },
        1: () => { calls++; return calls === 1 ? new Promise(r => { release = () => r({ cursor: 1, hasMore: false, changes: [] }); }) : { cursor: 1, hasMore: false, changes: [] }; },
    });
    h.cursor.saveCursor(1);
    const first = h.engine.run();
    const second = h.engine.run();
    const third = h.engine.run();
    await new Promise(r => setTimeout(r, 0));
    release();
    await Promise.all([first, second, third]);
    assert.equal(calls, 2, 'one pass for the run in flight, one catch-up pass');
});

test('responses for a signed-out identity are dropped', async () => {
    const h = harness({ boundary: { cursor: 3 } }, {});
    h.cursor.saveCursor(3);
    const pending = h.engine.run();
    h.signOut();
    assert.equal(await pending, 'stale');
    assert.deepEqual(h.applied, []);
});

test('404 (switched off) falls back, and is re-checked after 30 minutes', async () => {
    let time = 0;
    let enabled = false;
    const h = harness({
        boundary: () => (enabled ? { cursor: 0 } : null),
    }, { now: () => time });
    assert.equal(await h.engine.run(), 'unavailable');
    assert.equal(h.engine.available, false);
    enabled = true;
    time = 10 * 60_000;
    assert.equal(await h.engine.run(), 'unavailable', 'no request while cooling down');
    assert.equal(h.log.length, 1);
    time = 31 * 60_000;
    assert.equal(await h.engine.run(), 'synced');
    assert.equal(h.engine.available, true);
});
