// Inventory import from Excel (views/inventoryXlsx.ts): cells and pictures out
// of a hand-built .xlsx, each picture on the row it sits on.
//
//   node --test frontend/tests/inventoryXlsx.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { load } from './helpers/load.mjs';

const { readXlsx } = await load('views/inventoryXlsx.ts');
const { readInventoryTable, planImport } = await load('views/inventoryCsv.ts');

/** A zip of the given parts; deflated when `deflate` names the part, as Excel does for most. */
function zip(parts, deflate = []) {
    const locals = [], central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(parts)) {
        const raw = Buffer.from(content);
        const method = deflate.includes(name) ? 8 : 0;
        const data = method ? deflateRawSync(raw) : raw;
        const n = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(method, 10);
        dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
        locals.push(local, n, data);
        central.push(dir, n);
        offset += 30 + n.length + data.length;
    }
    const dirBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
    end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
    const all = Buffer.concat([...locals, dirBuf, end]);
    return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const rel = (id, target) => `<Relationship Id="${id}" Type="x" Target="${target}"/>`;
const rels = (...r) => `<?xml version="1.0"?><Relationships xmlns="r">${r.join('')}</Relationships>`;
const PNG = '\x89PNG fake', JPG = '\xff\xd8\xff fake';

const book = zip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId9"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels(rel('rId1', 'worksheets/sheet1.xml'), rel('rId2', 'sharedStrings.xml'), rel('rId3', 'metadata.xml'), rel('rId9', 'worksheets/sheet2.xml')),
    'xl/sharedStrings.xml': '<sst><si><t>Inventory ID</t></si><si><t>Title</t></si><si><t>Price</t></si><si><r><t>Monsoon </t></r><r><t>&amp; Rain</t></r><rPh><t>x</t></rPh></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns:r="r"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
        <row r="2"><c r="A2" t="str"><v>A-1</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>120000</v></c></row>
        <row r="4"><c r="A4"/></row>
        <row r="5"><c r="A5" t="str"><v>A-2</v></c><c r="B5" t="inlineStr"><is><t>Dusk</t></is></c><c r="C5"><v>5000</v></c><c r="D5" t="e" vm="1"><v>#VALUE!</v></c></row>
    </sheetData><drawing r:id="rId1"/></worksheet>`,
    'xl/worksheets/_rels/sheet1.xml.rels': rels(rel('rId1', '../drawings/drawing1.xml')),
    'xl/drawings/drawing1.xml': `<xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:r="r">
        <xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId2"/></xdr:pic></xdr:twoCellAnchor>
        <xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:twoCellAnchor>
        <xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>0</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId1"/></xdr:pic></xdr:oneCellAnchor>
        <xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:pic><a:blip r:embed="rId3"/></xdr:pic></xdr:oneCellAnchor>
    </xdr:wsDr>`,
    'xl/drawings/_rels/drawing1.xml.rels': rels(rel('rId1', '../media/image1.png'), rel('rId2', '../media/image3.jpeg'), rel('rId3', '../media/image4.emf')),
    'xl/metadata.xml': `<metadata xmlns:xlrd="d"><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata>
        <valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>`,
    'xl/richData/rdrichvaluestructure.xml': '<rvStructures><s t="_localImage"><k n="CalcOrigin" t="i"/><k n="_rvRel:LocalImageIdentifier" t="i"/></s></rvStructures>',
    'xl/richData/rdrichvalue.xml': '<rvData><rv s="0"><v>5</v><v>0</v></rv></rvData>',
    'xl/richData/richValueRel.xml': '<richValueRels xmlns:r="r"><rel r:id="rId1"/></richValueRels>',
    'xl/richData/_rels/richValueRel.xml.rels': rels(rel('rId1', '../media/image2.jpg')),
    'xl/media/image1.png': PNG, 'xl/media/image2.jpg': JPG, 'xl/media/image3.jpeg': JPG, 'xl/media/image4.emf': 'emf',
}, ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/media/image2.jpg']);

test('cells come out as text, from the first sheet, blank rows dropped, with their Excel row numbers', async () => {
    const sheet = await readXlsx(book);
    assert.deepEqual(sheet.table, [['Inventory ID', 'Title', 'Price'], ['A-1', 'Monsoon & Rain', '120000'], ['A-2', 'Dusk', '5000', '']]);
    assert.deepEqual(sheet.rowNumbers, [1, 2, 5]);
});

test('pictures land on their row, left to right: floating by top-left corner, "Place in Cell" by cell', async () => {
    const sheet = await readXlsx(book);
    assert.deepEqual([...sheet.pictures.keys()].sort(), [1, 2, 5]);
    assert.deepEqual(sheet.pictures.get(2).map(f => [f.name, f.type]), [['image1.png', 'image/png'], ['image3.jpeg', 'image/jpeg']]);
    assert.deepEqual(sheet.pictures.get(5).map(f => f.name), ['image2.jpg']);
    assert.equal(Buffer.from(await sheet.pictures.get(5)[0].arrayBuffer()).toString(), JPG); // inflated, not raw deflate
    assert.equal(sheet.unusable, 1); // the EMF
});

test('rows read through the same rules as CSV, and each artwork knows its row', async () => {
    const sheet = await readXlsx(book);
    const { artworks, skipped, rows } = readInventoryTable(sheet.table, sheet.rowNumbers);
    assert.deepEqual(artworks.map(a => [a.customId, a.title, a.price]), [['A-1', 'Monsoon & Rain', 120000], ['A-2', 'Dusk', 5000]]);
    assert.deepEqual(skipped, []);
    assert.deepEqual(rows, [2, 5]);
});

test('a file that is not an .xlsx is refused in plain words', async () => {
    await assert.rejects(readXlsx(new TextEncoder().encode('Title,Price\nA,1').buffer), /isn't an Excel \.xlsx/);
});

test('photos go on new artworks and on existing ones with none, never doubling', () => {
    const base = { customId: '', title: 'T', artist: '', artworkYear: '', medium: '', dimensions: '', price: 1, plusGst: false, status: 'Available', location: '', descriptionTitle: '', description: '', edition: undefined, quantity: 1 };
    const bare = { ...base, id: 'a', customId: 'A-1', imageUrls: [], createdAt: 1 };
    const pictured = { ...base, id: 'b', customId: 'A-2', imageUrls: ['/api/files/x'], createdAt: 1 };
    const fields = ({ id, imageUrls, createdAt, ...f }) => f;
    const rows = [fields(bare), fields(pictured), { ...base, customId: 'A-3' }];
    const plan = planImport([bare, pictured], rows, [1, 1, 2]);
    assert.deepEqual(plan.updates.map(u => u.id), ['a']);    // unchanged row, but brings its first photo
    assert.deepEqual(plan.takesPhotos, [true]);
    assert.deepEqual(plan.addFrom, [2]);
    assert.deepEqual(planImport([bare, pictured], rows).updates, []); // CSV: no photos, nothing changed
});
