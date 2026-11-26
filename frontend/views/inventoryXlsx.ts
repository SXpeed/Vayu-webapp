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
const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(Number.parseInt(e.slice(e[1] === 'x' || e[1] === 'X' ? 2 : 1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : ENTITIES[e] ?? m);

/** Elements by local name (any namespace prefix); fine for these machine-written parts, which never nest a tag inside itself. */
function tags(xml: string, name: string): { attrs: Record<string, string>; body: string }[] {
    const re = new RegExp(String.raw`<(?:[\w.-]+:)?${name}(\s[^>]*?)?(?:/>|>([\s\S]*?)</(?:[\w.-]+:)?${name}>)`, 'g');
    return [...xml.matchAll(re)].map(m => ({
        attrs: Object.fromEntries([...(m[1] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(a => [a[1], decode(a[2] ?? a[3])])),
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
    for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
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
        return key < 0 ? NaN : Number(tags(rv.body, 'v')[key]?.body);
    });
    const relIds = tags(await zip.text(relPart), 'rel').map(r => r.attrs['r:id']);
    const relTargets = await relsOf(zip, relPart);
    return tags(section('valueMetadata'), 'bk').map(bk => {
        const image = values[richIndexes[Number(tags(bk.body, 'rc')[0]?.attrs.v)]];
        return Number.isInteger(image) ? relTargets.get(relIds[image]) : undefined;
    });
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

    const byCell = await cellPictures(zip, workbookRels);
    const pictureParts: { row: number; col: number; part: string }[] = [];
    const rows = new Map<number, string[]>();
    let rowNumber = 0;
    for (const row of tags(sheet, 'row')) {
        rowNumber = Number(row.attrs.r) || rowNumber + 1;
        const cells: string[] = [];
        let col = -1;
        for (const c of tags(row.body, 'c')) {
            col = cellRef(c.attrs.r ?? '')?.col ?? col + 1;
            const raw = decode(tags(c.body, 'v')[0]?.body ?? '');
            const t = c.attrs.t;
            cells[col] = t === 's' ? shared[Number(raw)] ?? ''
                : t === 'inlineStr' ? textOf(c.body)
                : t === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE')
                : t === 'e' ? '' : raw;
            const part = c.attrs.vm ? byCell[Number(c.attrs.vm) - 1] : undefined;
            if (part) pictureParts.push({ row: rowNumber, col, part });
        }
        rows.set(rowNumber, Array.from(cells, c => c ?? ''));
    }

    const sheetRels = await relsOf(zip, sheetPart);
    for (const d of tags(sheet, 'drawing')) {
        const drawingPart = sheetRels.get(d.attrs['r:id']);
        if (!drawingPart) continue;
        const drawingRels = await relsOf(zip, drawingPart);
        const drawing = await zip.text(drawingPart);
        for (const kind of ['twoCellAnchor', 'oneCellAnchor']) for (const anchor of tags(drawing, kind)) {
            const from = tags(anchor.body, 'from')[0]?.body ?? '';
            const row = Number(tags(from, 'row')[0]?.body) + 1;
            const col = Number(tags(from, 'col')[0]?.body);
            for (const blip of tags(anchor.body, 'blip')) {
                const part = drawingRels.get(blip.attrs['r:embed']);
                if (part && Number.isFinite(row)) pictureParts.push({ row, col, part });
            }
        }
    }

    const pictures = new Map<number, File[]>();
    let unusable = 0;
    for (const { row, part } of pictureParts.sort((a, b) => a.row - b.row || a.col - b.col)) {
        const name = part.split('/').pop() ?? 'photo';
        const type = PHOTO_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
        const data = type ? await zip.bytes(part) : null;
        if (!type || !data) { unusable++; continue; }
        pictures.set(row, [...(pictures.get(row) ?? []), new File([data], name, { type })]);
    }

    const kept = [...rows].filter(([, cells]) => cells.some(c => c.trim())).sort((a, b) => a[0] - b[0]);
    return { table: kept.map(([, cells]) => cells), rowNumbers: kept.map(([n]) => n), pictures, unusable };
}
