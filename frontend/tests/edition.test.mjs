// Artwork editions: what is stored (rows.ts) and how it reads (types.ts).
//
//   node --test frontend/tests/edition.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const { editionLabel } = await load('types.ts');
const { editionColumn, rowToArtwork } = await load('rows.ts');

test('the label reads this copy, then the whole edition', () => {
    assert.equal(editionLabel(undefined), '');
    assert.equal(editionLabel({ size: '10' }), 'Edition of 10');
    assert.equal(editionLabel({ size: '10', proofs: '2' }), 'Edition of 10 + 2 AP');
    assert.equal(editionLabel({ size: '10', proofs: '2', number: '3' }), '3/10 · Edition of 10 + 2 AP');
    assert.equal(editionLabel({ size: '10', proofs: '2', number: 'AP 1' }), 'AP 1 · Edition of 10 + 2 AP');
});

test('a unique work stores nothing; an edition stores trimmed strings only', () => {
    for (const v of [undefined, null, 'x', {}, { size: '  ' }, { size: 10 }]) assert.equal(editionColumn(v), '', JSON.stringify(v));
    const stored = editionColumn({ size: ' 10 ', proofs: 2, number: '3', extra: '<b>' });
    assert.deepEqual(JSON.parse(stored), { size: '10', proofs: '', number: '3' });
    const row = { image_urls: '[]', edition: stored };
    assert.deepEqual(rowToArtwork(row).edition, { size: '10', proofs: '', number: '3' });
    assert.equal(rowToArtwork({ image_urls: '[]', edition: '' }).edition, undefined);
});
