// Inventory import from an Excel .xlsx: the first sheet's cells, plus the
// pictures in it, each matched to the spreadsheet row it sits on. Pictures
// "placed in cell" (Excel 365) belong to their cell; floating pictures go to the
// row under their top-left corner. No library: an .xlsx is a zip of XML parts.

const NOT_XLSX = 'This isn\'t an Excel .xlsx file. In Excel use File → Save As → "Excel Workbook (.xlsx)" (password-protected files can\'t be read).';

const PHOTO_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface XlsxSheet {
    /** Non-blank rows, header first, as text the way Excel stores it. */
    table: string[][];
    /** The Excel row number of each table row. */
    rowNumbers: number[];
    /** Photos by Excel row number, left to right. */
    pictures: Map<number, File[]>;
    /** Pictures in a format the app can't show (EMF, TIFF, …), left out. */
    unusable: number;
}

type Zip = { names: string[]; bytes: (name: string) => Promise<Uint8Array<ArrayBuffer> | null>; text: (name: string) => Promise<string> };

/** The zip's entries, inflated on demand. */
function openZip(buf: ArrayBuffer): Zip {
    const b = new Uint8Array(buf);
    const v = new DataView(buf);
    let end = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(NOT_XLSX);
    const entries = new Map<string, { method: number; at: number; size: number }>();
    let p = v.getUint32(end + 16, true);
    for (let n = v.getUint16(end + 10, true); n > 0; n--) {
        if (p + 46 > b.length || v.getUint32(p, true) !== 0x02014b50) throw new Error(NOT_XLSX);
        const nameLen = v.getUint16(p + 28, true);
        const local = v.getUint32(p + 42, true);
        const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
        const at = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        entries.set(name, { method: v.getUint16(p + 10, true), at, size: v.getUint32(p + 20, true) });
        p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    const bytes = async (name: string) => {
        const e = entries.get(name);
        if (!e) return null;
        const raw = b.subarray(e.at, e.at + e.size);
        if (e.method === 0) return raw;
        if (e.method !== 8) throw new Error(NOT_XLSX);
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    return { names: [...entries.keys()], bytes, text: async name => { const got = await bytes(name); return got ? new TextDecoder().decode(got) : ''; } };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function entity(m: string, e: string): string {
    if (!e.startsWith('#')) return ENTITIES[e] ?? m;
    const hex = e[1] === 'x' || e[1] === 'X';
    return String.fromCodePoint(Number.parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10));
}
const decode = (s: string) => s.replaceAll(/&(#x[\da-f]+|#\d+|\w+);/gi, entity);

/** ` r="A1" t="s"` → { r: 'A1', t: 's' }. Excel writes every attribute as name="value"; split on the quotes, no regex. */
function attrsOf(chunk: string): Record<string, string> {
    const bits = chunk.split('"');
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < bits.length; i += 2) {
        const name = bits[i].trim().replace(/=$/, '').trim();
        if (name) out[name] = decode(bits[i + 1]);
    }
    return out;
}

/** Elements by local name (any namespace prefix); fine for these machine-written parts, which never nest a tag inside itself. */
function tags(xml: string, name: string): { attrs: Record<string, string>; body: string }[] {
    const re = new RegExp(String.raw`<(?:[\w.-]+:)?${name}(\s[^>]*?)?(?:/>|>([\s\S]*?)</(?:[\w.-]+:)?${name}>)`, 'g');
    return [...xml.matchAll(re)].map(m => ({
        attrs: attrsOf(m[1] ?? ''),
        body: m[2] ?? '',
    }));
}
const textOf = (xml: string) => tags(xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, ''), 't').map(t => decode(t.body)).join('');

function resolvePath(fromPart: string, target: string): string {
    if (target.startsWith('/')) return target.slice(1);
    const parts = fromPart.split('/').slice(0, -1);
    for (const seg of target.split('/')) if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
    return parts.join('/');
}

/** A part's relationships: id → resolved part path. */
async function relsOf(zip: Zip, part: string): Promise<Map<string, string>> {
    const slash = part.lastIndexOf('/');
    const xml = await zip.text(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`);
    return new Map(tags(xml, 'Relationship').filter(r => r.attrs.TargetMode !== 'External').map(r => [r.attrs.Id, resolvePath(part, r.attrs.Target)]));
}

/** "AB12" → column 27 (0-based), row 12. */
function cellRef(ref: string): { col: number; row: number } | null {
    const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
    if (!m) return null;
    let col = 0;
    for (const ch of m[1].toUpperCase()) col = col * 26 + ch.codePointAt(0)! - 64;
    return { col: col - 1, row: Number(m[2]) };
}

/** Picture parts of "Place in Cell" images, by the cell's vm number (1-based). */
async function cellPictures(zip: Zip, workbookRels: Map<string, string>): Promise<(string | undefined)[]> {
    const find = (re: RegExp) => zip.names.find(n => re.test(n));
    const metadata = await zip.text([...workbookRels.values()].find(t => /metadata\.xml$/i.test(t)) ?? find(/^xl\/metadata\.xml$/i) ?? '');
    const richValues = find(/richData\/rdrichvalue\.xml$/i);
    const relPart = find(/richData\/richValueRel\.xml$/i);
    if (!metadata || !richValues || !relPart) return [];
    const section = (name: string, attr = '') => new RegExp(String.raw`<(?:\w+:)?${name}\b[^>]*${attr}[^>]*>([\s\S]*?)</(?:\w+:)?${name}>`).exec(metadata)?.[1] ?? '';
    const richIndexes = tags(section('futureMetadata', 'name="XLRICHVALUE"'), 'bk').map(bk => Number(tags(bk.body, 'rvb')[0]?.attrs.i));
    const structures = tags(await zip.text(find(/richData\/rdrichvaluestructure\.xml$/i) ?? ''), 's')
        .map(s => tags(s.body, 'k').findIndex(k => k.attrs.n === '_rvRel:LocalImageIdentifier'));
    const values = tags(await zip.text(richValues), 'rv').map(rv => {
        const key = structures[Number(rv.attrs.s)] ?? -1;
        return key < 0 ? Number.NaN : Number(tags(rv.body, 'v')[key]?.body);
    });
    const relIds = tags(await zip.text(relPart), 'rel').map(r => r.attrs['r:id']);
    const relTargets = await relsOf(zip, relPart);
    return tags(section('valueMetadata'), 'bk').map(bk => {
        const image = values[richIndexes[Number(tags(bk.body, 'rc')[0]?.attrs.v)]];
        return Number.isInteger(image) ? relTargets.get(relIds[image]) : undefined;
    });
}

type PicturePart = { row: number; col: number; part: string };

/** A cell's text the way Excel stores it: shared string, inline string, TRUE/FALSE, nothing for an error, else the value. */
function cellText(c: { attrs: Record<string, string>; body: string }, shared: string[]): string {
    const raw = decode(tags(c.body, 'v')[0]?.body ?? '');
    switch (c.attrs.t) {
        case 's': return shared[Number(raw)] ?? '';
        case 'inlineStr': return textOf(c.body);
        case 'b': return raw === '1' ? 'TRUE' : 'FALSE';
        case 'e': return '';
        default: return raw;
    }
}

/** The sheet's rows by Excel row number, and the "Place in Cell" pictures in them. */
function readRows(sheet: string, shared: string[], byCell: (string | undefined)[]): { rows: Map<number, string[]>; parts: PicturePart[] } {
    const parts: PicturePart[] = [];
    const rows = new Map<number, string[]>();
    let rowNumber = 0;
    for (const row of tags(sheet, 'row')) {
        rowNumber = Number(row.attrs.r) || rowNumber + 1;
        const cells: string[] = [];
        let col = -1;
        for (const c of tags(row.body, 'c')) {
            col = cellRef(c.attrs.r ?? '')?.col ?? col + 1;
            cells[col] = cellText(c, shared);
            const part = c.attrs.vm ? byCell[Number(c.attrs.vm) - 1] : undefined;
            if (part) parts.push({ row: rowNumber, col, part });
        }
        rows.set(rowNumber, Array.from(cells, c => c ?? ''));
    }
    return { rows, parts };
}

/** Floating pictures, each on the row under its top-left corner. */
async function floatingPictures(zip: Zip, sheet: string, sheetPart: string): Promise<PicturePart[]> {
    const sheetRels = await relsOf(zip, sheetPart);
    const drawings = await Promise.all(tags(sheet, 'drawing').map(async d => {
        const drawingPart = sheetRels.get(d.attrs['r:id']);
        if (!drawingPart) return [];
        const [drawingRels, drawing] = await Promise.all([relsOf(zip, drawingPart), zip.text(drawingPart)]);
        return ['twoCellAnchor', 'oneCellAnchor'].flatMap(kind => tags(drawing, kind)).flatMap(anchor => {
            const from = tags(anchor.body, 'from')[0]?.body ?? '';
            const row = Number(tags(from, 'row')[0]?.body) + 1;
            const col = Number(tags(from, 'col')[0]?.body);
            if (!Number.isFinite(row)) return [];
            return tags(anchor.body, 'blip').map(b => drawingRels.get(b.attrs['r:embed'])).filter((part): part is string => !!part).map(part => ({ row, col, part }));
        });
    }));
    return drawings.flat();
}

/** Photos by row, left to right; pictures the app can't show are counted, not kept. */
async function loadPictures(zip: Zip, parts: PicturePart[]): Promise<{ pictures: Map<number, File[]>; unusable: number }> {
    const sorted = [...parts].sort((a, b) => a.row - b.row || a.col - b.col);
    const files = await Promise.all(sorted.map(async ({ part }) => {
        const name = part.split('/').pop() ?? 'photo';
        const type = PHOTO_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
        const data = type ? await zip.bytes(part) : null;
        return type && data ? new File([data], name, { type }) : null;
    }));
    const pictures = new Map<number, File[]>();
    sorted.forEach(({ row }, i) => {
        const file = files[i];
        if (file) pictures.set(row, [...(pictures.get(row) ?? []), file]);
    });
    return { pictures, unusable: files.filter(f => !f).length };
}

export async function readXlsx(buf: ArrayBuffer): Promise<XlsxSheet> {
    const zip = openZip(buf);
    const workbookPart = 'xl/workbook.xml';
    const workbook = await zip.text(workbookPart);
    const workbookRels = await relsOf(zip, workbookPart);
    const sheetPart = workbookRels.get(tags(workbook, 'sheet')[0]?.attrs['r:id'] ?? '');
    if (!sheetPart) throw new Error(NOT_XLSX);
    const sharedPart = [...workbookRels.values()].find(t => /sharedStrings\.xml$/i.test(t));
    const shared = sharedPart ? tags(await zip.text(sharedPart), 'si').map(si => textOf(si.body)) : [];
    const sheet = await zip.text(sheetPart);

    const { rows, parts } = readRows(sheet, shared, await cellPictures(zip, workbookRels));
    const { pictures, unusable } = await loadPictures(zip, [...parts, ...await floatingPictures(zip, sheet, sheetPart)]);

    const kept = [...rows].filter(([, cells]) => cells.some(c => c.trim())).sort((a, b) => a[0] - b[0]);
    return { table: kept.map(([, cells]) => cells), rowNumbers: kept.map(([n]) => n), pictures, unusable };
}
