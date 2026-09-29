// The sales ledger's shared rules (salesRules.ts): tags, per-tag totals, photo links.
//
//   node --test frontend/tests/salesRules.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const r = await load('salesRules.ts');

test('totals per tag: a sale counts under each of its tags, untagged last', () => {
    const rows = r.summarizeByTag([
        { amount: 100, tags: ['Diwali Fair'] },
        { amount: 0.1, tags: ['Diwali Fair', 'Online'] },
        { amount: 0.2, tags: ['diwali fair'] },
        { amount: 50, tags: [] },
        { amount: 500, tags: ['Online'] },
    ]);
    assert.deepEqual(rows, [
        { tag: 'Online', count: 2, amount: 500.1 },
        { tag: 'Diwali Fair', count: 3, amount: 100.3 },
        { tag: '', count: 1, amount: 50 },
    ]);
    assert.deepEqual(r.summarizeByTag([]), []);
});

test('tags are tidied before they are stored', () => {
    assert.deepEqual(r.cleanTags([' Art  Mela ', 'ART MELA', null, '', 'x'.repeat(60)]), ['Art Mela', 'x'.repeat(40)]);
    assert.deepEqual(r.cleanTags('Diwali'), [], 'not a list');
});

test('photo links must be our own uploads', () => {
    assert.equal(r.isFileUrl('/api/files/uploads/a.jpg'), true);
    assert.equal(r.isFileUrl('/api/o/org-123/files/uploads/a.jpg'), true);
    assert.equal(r.isFileUrl('https://example.com/a.jpg'), false);
    assert.equal(r.isFileUrl('/api/files/a.jpg?x=1'), false);
    assert.equal(r.isFileUrl(42), false);
});
