// The assistant's Markdown, read into blocks (views/assistant/markdownBlocks.ts).
//
//   node --test frontend/tests/assistantMarkdown.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const m = await load('views/assistant/markdownBlocks.ts');

test('inline: bold, italic, code, and the rest as text', () => {
    assert.deepEqual(m.spans('Sales **₹1,20,000** from `INQ-7`, *mostly* prints'), [
        { k: 'text', s: 'Sales ' }, { k: 'b', s: '₹1,20,000' }, { k: 'text', s: ' from ' }, { k: 'code', s: 'INQ-7' },
        { k: 'text', s: ', ' }, { k: 'i', s: 'mostly' }, { k: 'text', s: ' prints' },
    ]);
    // Snake_case names and lone stars stay text.
    assert.deepEqual(m.spans('find_inquiries costs 2 * 3'), [{ k: 'text', s: 'find_inquiries costs 2 * 3' }]);
    // Markup arrives as text, never as HTML.
    assert.deepEqual(m.spans('<img src=x onerror=alert(1)>'), [{ k: 'text', s: '<img src=x onerror=alert(1)>' }]);
});

test('blocks: heading, lists, a table, code and paragraphs', () => {
    const b = m.blocks('## Today\nTwo check-ins.\nBoth on time.\n\n- Riya 9:58\n- Aman 10:02\n\n1. Call\n2. Send\n\n| Name | In |\n|---|:-:|\n| Riya | 9:58 |\n\n```\nraw *text*\n```');
    assert.deepEqual(b.map(x => x.k), ['h', 'p', 'ul', 'ol', 'table', 'code']);
    assert.equal(b[0].level, 2);
    assert.equal(b[1].lines.length, 2);
    assert.deepEqual(b[2].items.map(i => i[0].s), ['Riya 9:58', 'Aman 10:02']);
    assert.deepEqual(b[4].head.map(c => c[0].s), ['Name', 'In']);
    assert.deepEqual(b[4].rows, [[[{ k: 'text', s: 'Riya' }], [{ k: 'text', s: '9:58' }]]]);
    assert.equal(b[5].s, 'raw *text*');
});

test('an unfinished answer (still streaming) still reads', () => {
    assert.deepEqual(m.blocks('```\nhalf').map(x => x.k), ['code']);
    assert.deepEqual(m.blocks('Total **₹1,2').at(0).lines[0], [{ k: 'text', s: 'Total **₹1,2' }]);
    assert.deepEqual(m.blocks('| a | b |').map(x => x.k), ['p']);
});
