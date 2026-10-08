// What one organization leaves on a shared device (services/db.ts): signing
// out removes every organization's saved copy, and a sale's carried-over tags
// belong to the workspace they were typed in.
//
//   node --test frontend/tests/tenantStorage.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

// A browser's localStorage, before the modules read it.
const store = new Map();
globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
    key: i => [...store.keys()][i] ?? null,
    get length() { return store.size; },
    clear: () => store.clear(),
};

const { db, setWorkspace } = await load('tests/helpers/tenantStorageEntry.ts');

test('signing out removes every organization\'s saved copy, not just the open one', () => {
    store.clear();
    store.set('vayu_artworks@org-a', '[{"id":"a1"}]');
    store.set('vayu_contacts@org-b', '[{"id":"c1"}]');
    store.set('vayu_sync_mark@org-b', '{"cursor":4}');
    store.set('vayu_artworks', '[{"id":"legacy"}]');
    store.set('vayu.sales.lastTags@org-a', '["Diwali Fair"]');
    store.set('vayu_sales_pending@org-a', '[{"id":"s1"}]');
    store.set('vayu_theme', 'dark');

    db.clearSavedCopies();

    assert.deepEqual([...store.keys()].sort(), ['vayu_sales_pending@org-a', 'vayu_theme'],
        'only unsent sales (they exist nowhere else) and preferences stay');
});

test('a sale\'s carried-over tags stay in their own workspace', () => {
    store.clear();
    setWorkspace({ id: 'org-a', name: 'A', role: 'owner' });
    db.setLastSaleTags(['Diwali Fair']);
    setWorkspace({ id: 'org-b', name: 'B', role: 'staff' });
    assert.deepEqual(db.getLastSaleTags(), [], 'organization B starts with none of A\'s tags');
    db.setLastSaleTags(['Open Studio']);
    setWorkspace({ id: 'org-a', name: 'A', role: 'owner' });
    assert.deepEqual(db.getLastSaleTags(), ['Diwali Fair']);
    setWorkspace(null);
});
