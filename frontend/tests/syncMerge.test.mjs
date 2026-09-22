import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { mergeChanges, groupByEntity, byDesc, byAsc, conversationOrder } = await load('services/syncMerge.ts');

const put = (seq, id, record, entity = 'artwork') => ({ seq, entity, id, op: 'put', record });
const del = (seq, id, entity = 'artwork') => ({ seq, entity, id, op: 'delete' });

test('put replaces by id and adds new rows; delete removes', () => {
    const list = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const merged = mergeChanges(list, [put(1, 'a', { id: 'a', v: 2 }), put(2, 'c', { id: 'c', v: 1 }), del(3, 'b')]);
    assert.deepEqual(merged, [{ id: 'a', v: 2 }, { id: 'c', v: 1 }]);
    assert.deepEqual(list, [{ id: 'a', v: 1 }, { id: 'b', v: 1 }], 'input is not mutated');
});

test('returns the same array when nothing changed (no re-render)', () => {
    const list = [{ id: 'a', v: 1 }];
    assert.equal(mergeChanges(list, []), list);
    assert.equal(mergeChanges(list, [put(1, 'a', { id: 'a', v: 1 })]), list);
    assert.equal(mergeChanges(list, [del(2, 'missing')]), list);
});

test('later changes to the same id win (seq order)', () => {
    const merged = mergeChanges([], [put(1, 'a', { id: 'a', v: 1 }), del(2, 'a'), put(3, 'a', { id: 'a', v: 3 })]);
    assert.deepEqual(merged, [{ id: 'a', v: 3 }]);
    assert.deepEqual(mergeChanges([{ id: 'a' }], [put(1, 'a', { id: 'a', v: 2 }), del(2, 'a')]), []);
});

test('client-only rows (failed messages) survive a merge', () => {
    const failed = { id: 'local', status: 'failed', timestamp: 5 };
    const merged = mergeChanges([failed], [put(1, 'm1', { id: 'm1', status: 'sent', timestamp: 1 }, 'message')], byAsc('timestamp'));
    assert.deepEqual(merged.map(m => m.id), ['m1', 'local']);
});

test('a put without a record is ignored rather than inserting undefined', () => {
    const list = [{ id: 'a' }];
    assert.equal(mergeChanges(list, [{ seq: 1, entity: 'artwork', id: 'b', op: 'put' }]), list);
});

test('comparators keep the server list order', () => {
    const merged = mergeChanges([{ id: 'a', createdAt: 1 }], [put(1, 'b', { id: 'b', createdAt: 5 })], byDesc('createdAt'));
    assert.deepEqual(merged.map(x => x.id), ['b', 'a']);
    const convs = [
        { id: 'x', isPinned: false, lastMessageTime: 9 },
        { id: 'y', isPinned: true, lastMessageTime: 1 },
        { id: 'z', lastMessageTime: 5 },
    ].sort(conversationOrder);
    assert.deepEqual(convs.map(c => c.id), ['y', 'x', 'z']);
});

test('groupByEntity keeps seq order within each entity', () => {
    const groups = groupByEntity([put(1, 'a', {}), put(2, 'm', {}, 'message'), del(3, 'a')]);
    assert.deepEqual([...groups.keys()], ['artwork', 'message']);
    assert.deepEqual(groups.get('artwork').map(c => c.seq), [1, 3]);
});
