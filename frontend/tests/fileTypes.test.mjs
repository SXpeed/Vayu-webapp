// Upload type rules: what a file really is, and how it may be served.
//
//   node --test frontend/tests/fileTypes.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './helpers/load.mjs';

const t = await load('fileTypes.ts');

const bytes = (...b) => Uint8Array.from(b);
const text = s => new TextEncoder().encode(s);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const WEBP = Uint8Array.from([...text('RIFF'), 1, 2, 3, 4, ...text('WEBPVP8 ')]);
const HEIC = Uint8Array.from([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0]);
const PDF = text('%PDF-1.7\n%âãÏÓ');
const HTML = text('<!doctype html><script>alert(1)</script>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

test('the bytes, not the claim, decide the type', () => {
    assert.equal(t.sniff(PNG), 'image/png');
    assert.equal(t.sniff(JPEG), 'image/jpeg');
    assert.equal(t.sniff(WEBP), 'image/webp');
    assert.equal(t.sniff(HEIC), 'image/heic');
    assert.equal(t.sniff(PDF), 'application/pdf');
    assert.equal(t.sniff(Uint8Array.from([...text('junk\n'), ...PDF])), 'application/pdf');
    assert.equal(t.sniff(HTML), null);
    assert.equal(t.sniff(SVG), null);
});

test('a false image or PDF claim is stored as an opaque download', () => {
    assert.equal(t.storedContentType('image/png', HTML), 'application/octet-stream');
    assert.equal(t.storedContentType('application/pdf', HTML), 'application/octet-stream');
    assert.equal(t.storedContentType('text/plain', PNG), 'image/png');
    assert.equal(t.storedContentType('', JPEG), 'image/jpeg');
    assert.equal(t.storedContentType('text/html', HTML), 'text/html');
    assert.equal(t.storedContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document', text('PK')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(t.storedContentType('not a type', HTML), 'application/octet-stream');
});

test('only images, PDFs and plain text are shown; the rest downloads in a sandbox', () => {
    assert.deepEqual(t.delivery('image/png'), { contentType: 'image/png', disposition: 'inline' });
    assert.deepEqual(t.delivery('application/pdf'), { contentType: 'application/pdf', disposition: 'inline' });
    for (const risky of ['text/html', 'application/xhtml+xml', 'text/xml', 'application/javascript', undefined, '']) {
        const d = t.delivery(risky);
        assert.equal(d.contentType, 'application/octet-stream', String(risky));
        assert.equal(d.disposition, 'attachment');
        assert.match(d.csp, /sandbox/);
    }
    const svg = t.delivery('image/svg+xml');
    assert.equal(svg.disposition, 'inline');
    assert.match(svg.csp, /sandbox/);
    assert.match(svg.csp, /default-src 'none'/);
    assert.equal(t.delivery('text/plain').csp.includes('sandbox'), true);
});

test('names that reach storage keys and headers are cleaned', () => {
    assert.equal(t.safeExtension('photo.JPG'), 'jpg');
    assert.equal(t.safeExtension('notes'), '');
    assert.equal(t.safeExtension('evil.ph p'), '');
    assert.equal(t.safeExtension('a.verylongextension'), '');
    assert.equal(t.downloadName('uploads/u1/123-abc.pdf'), '123-abc.pdf');
    assert.equal(t.downloadName('uploads/u1/123-abc.jpg__thumb'), '123-abc.jpg');
    assert.equal(t.downloadName('uploads/u1/a"b;c.txt'), 'a_b_c.txt');
    assert.equal(t.isRasterImage(PNG), true);
    assert.equal(t.isRasterImage(PDF), false);
});
