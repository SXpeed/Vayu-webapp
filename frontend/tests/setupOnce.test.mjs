// Table setup remembered across isolates (rows.ts runSetupOnce): a finished
// setup is recorded in KV, so a fresh isolate skips it, and editing the setup
// (or its data version) runs it again.
//
//   node --test frontend/tests/setupOnce.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Each call gives a separate module instance: a fresh isolate with empty memory.
let isolates = 0;
async function freshIsolate() {
    const out = await build({
        entryPoints: [fileURLToPath(new URL('../rows.ts', import.meta.url))],
        bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false, logLevel: 'silent',
        banner: { js: `// isolate ${++isolates}` },
    });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const kv = () => {
    const map = new Map();
    return { map, get: async key => map.get(key) ?? null, put: async (key, value) => { map.set(key, value); } };
};

test('a fresh isolate skips a setup another isolate finished', async () => {
    const store = kv();
    const db = {};
    let runs = 0;
    const setup = async () => { runs++; };

    const a = await freshIsolate();
    a.useSetupStore(store);
    await a.runSetupOnce(db, 'eventsTable', setup);
    await a.runSetupOnce(db, 'eventsTable', setup);
    assert.equal(runs, 1, 'once per isolate, as before');
    assert.equal(store.map.size, 1, 'the finished setup is recorded');

    const b = await freshIsolate();
    b.useSetupStore(store);
    await b.runSetupOnce(db, 'eventsTable', setup);
    assert.equal(runs, 1, 'a fresh isolate reads the record and skips the setup');
});

test('a changed setup or data version runs again', async () => {
    const store = kv();
    const db = {};
    let runs = 0;

    const a = await freshIsolate();
    a.useSetupStore(store);
    await a.runSetupOnce(db, 'columns:inquiries', async () => { runs++; }, '{"a":"TEXT"}');

    const b = await freshIsolate();
    b.useSetupStore(store);
    await b.runSetupOnce(db, 'columns:inquiries', async () => { runs++; }, '{"a":"TEXT","b":"TEXT"}');
    assert.equal(runs, 2, 'a new column in the data runs the setup again');

    const c = await freshIsolate();
    c.useSetupStore(store);
    await c.runSetupOnce(db, 'columns:inquiries', async () => { runs += 1; /* edited setup */ }, '{"a":"TEXT","b":"TEXT"}');
    assert.equal(runs, 3, 'edited setup code runs again');
});

test('a failed setup is not recorded, and KV errors fall back to running it', async () => {
    const store = kv();
    const db = {};
    const a = await freshIsolate();
    a.useSetupStore(store);
    await assert.rejects(a.runSetupOnce(db, 't', async () => { throw new Error('boom'); }));
    assert.equal(store.map.size, 0);

    let runs = 0;
    const broken = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } };
    const b = await freshIsolate();
    b.useSetupStore(broken);
    await b.runSetupOnce(db, 't2', async () => { runs++; });
    assert.equal(runs, 1);
});
