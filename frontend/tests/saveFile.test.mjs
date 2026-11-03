// Getting files out of the app: share sheet in the installed iPhone app, a new
// tab where the browser shows PDFs, a download everywhere else. Never a link
// that replaces the app with the file.
//
//   node --test frontend/tests/saveFile.test.mjs
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { load } from './helpers/load.mjs';

const { saveBlob, openBlob } = await load('services/saveFile.ts');

let shared, clicked, opened, nav, popup;
const err = name => Object.assign(new Error(name), { name });

beforeEach(() => {
    shared = []; clicked = []; opened = []; popup = {};
    nav = { standalone: false, pdfViewerEnabled: true, canShare: () => true, share: async ({ files }) => { shared.push(files[0].name); } };
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    globalThis.document = { createElement: () => ({ click() { clicked.push(this.download); }, remove() {} }), body: { append() {} } };
    globalThis.open = url => { opened.push(url); return popup; };
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
});

mock.timers.enable({ apis: ['setTimeout'] }); // the 60s revoke timers would hold the run open

const pdf = new Blob(['%PDF'], { type: 'application/pdf' });

test('a computer with a PDF viewer opens the PDF in a new tab', async () => {
    assert.equal(await openBlob(pdf, 'a.pdf'), 'opened');
    assert.deepEqual([opened.length, clicked, shared], [1, [], []]);
});

test('a blocked tab falls back to a download under the file name', async () => {
    popup = null;
    assert.equal(await openBlob(pdf, 'a.pdf'), 'downloaded');
    assert.deepEqual(clicked, ['a.pdf']);
});

test('a phone with no PDF viewer downloads instead of opening a blank tab', async () => {
    nav.pdfViewerEnabled = false;
    assert.equal(await openBlob(pdf, 'a.pdf'), 'downloaded');
    assert.deepEqual([opened, clicked], [[], ['a.pdf']]);
});

test('the installed iPhone app uses the share sheet, never a tab or a link', async () => {
    nav.standalone = true;
    assert.equal(await openBlob(pdf, 'a.pdf'), 'shared');
    assert.equal(await saveBlob(pdf, 'b.pdf'), 'shared');
    assert.deepEqual([opened, clicked, shared], [[], [], ['a.pdf', 'b.pdf']]);
});

test('iPhone: a share sheet refused after a slow build asks for a tap instead of failing', async () => {
    nav.standalone = true;
    nav.share = async () => { throw err('NotAllowedError'); };
    assert.equal(await saveBlob(pdf, 'a.pdf'), 'shared');
    assert.deepEqual(clicked, []); // no link: that would replace the app
});

test('iPhone: closing the share sheet reaches the caller as AbortError', async () => {
    nav.standalone = true;
    nav.share = async () => { throw err('AbortError'); };
    await assert.rejects(saveBlob(pdf, 'a.pdf'), { name: 'AbortError' });
});
