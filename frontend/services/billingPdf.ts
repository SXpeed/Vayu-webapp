// One PDF builder for every billing document: a Tally-style bordered grid whose
// title, columns and blocks follow the kind (proforma, tax invoice / bill of
// supply, challan, credit/debit note) and the tax mode (CGST+SGST / IGST / none).

import type { jsPDF } from 'jspdf';
import type { Artwork } from '../types';
import { getThumbUrl } from './storageService';
import { amountInWords, formatPaise, sgstLabel, stateLabel, type TaxMode, type Totals } from '../gstRules';
import {
    docTotals, isBillOfSupply, KIND_LABEL, kindLabel, PURPOSE_LABEL, RETURNABLE, sellerOf, SUPPLY_LABEL, taxModeOf,
    type BillingDoc, type BillingSettings, type DocLine, type Seller,
} from '../invoicing';

const W = 210;
const H = 297;
const M = 10;
const R = W - M;
const CW = R - M;
const BOTTOM = H - 14;

type RGB = [number, number, number];
const INK: RGB = [28, 28, 28];
const MUTED: RGB = [105, 105, 105];
const LINE: RGB = [150, 150, 150];
const ACCENT: RGB = [156, 96, 48];
const FILL: RGB = [244, 241, 236];

interface Img { data: string; w: number; h: number }

interface Ctx {
    pdf: jsPDF;
    y: number;
    doc: BillingDoc;
    s: BillingSettings;
    seller: Seller;
    t: Totals;
    mode: TaxMode;
    title: string;
    copy: string;
    source?: BillingDoc;
    photos: (Img | null)[];
    logo: Img | null;
    sign: Img | null;
}

const dateText = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const rs = (p: number) => `Rs. ${formatPaise(p)}`;

const COPIES: Record<'invoice' | 'challan', [string, string, string]> = {
    invoice: ['ORIGINAL FOR RECIPIENT', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR SUPPLIER'],
    challan: ['ORIGINAL FOR CONSIGNEE', 'DUPLICATE FOR TRANSPORTER', 'TRIPLICATE FOR CONSIGNOR'],
};

/** The copy labels to print, from the print settings; proformas print once without a label. */
function copyLabels(doc: BillingDoc, s: BillingSettings): string[] {
    if (doc.kind === 'proforma') return [''];
    const names = COPIES[doc.kind === 'challan' ? 'challan' : 'invoice'];
    const { original, duplicate, triplicate } = s.print.copies;
    const picked = names.filter((_, i) => [original, duplicate, triplicate][i]);
    return picked.length ? picked : [names[0]];
}

async function loadImage(url: string, maxPx: number): Promise<Img | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bitmap = await createImageBitmap(await res.blob());
        const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const g = canvas.getContext('2d');
        if (!g) return null;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return { data: canvas.toDataURL('image/jpeg', 0.88), w: canvas.width, h: canvas.height };
    } catch {
        return null;
    }
}

function drawContained(pdf: jsPDF, img: Img, x: number, y: number, bw: number, bh: number): void {
    const k = Math.min(bw / img.w, bh / img.h);
    pdf.addImage(img.data, 'JPEG', x + (bw - img.w * k) / 2, y + (bh - img.h * k) / 2, img.w * k, img.h * k);
}

function font(pdf: jsPDF, size: number, style: 'normal' | 'bold' | 'italic' = 'normal', color: RGB = INK): void {
    pdf.setFont('helvetica', style);
    pdf.setFontSize(size);
    pdf.setTextColor(...color);
}

const wrap = (pdf: jsPDF, text: string, width: number): string[] => (text ? pdf.splitTextToSize(text, width) as string[] : []);

function watermark(c: Ctx): void {
    if (c.doc.status !== 'Cancelled' && c.doc.number) return;
    const { pdf } = c;
    pdf.saveGraphicsState();
    pdf.setGState(pdf.GState({ opacity: 0.1 }));
    font(pdf, 72, 'bold', c.doc.status === 'Cancelled' ? [200, 30, 30] : MUTED);
    pdf.text(c.doc.status === 'Cancelled' ? 'CANCELLED' : 'DRAFT', 38, 210, { angle: 35 });
    pdf.restoreGraphicsState();
}

function titleStrip(c: Ctx, continued = false): void {
    const { pdf } = c;
    font(pdf, 13, 'bold', ACCENT);
    pdf.text(c.title.toUpperCase() + (continued ? ' (CONTINUED)' : ''), W / 2, c.y + 5, { align: 'center' });
    if (c.copy) {
        font(pdf, 6.5, 'bold', MUTED);
        pdf.text(c.copy, R, c.y + 5, { align: 'right' });
    }
    c.y += 8;
    const notes: string[] = [];
    if (c.seller.registration === 'composition' && c.doc.kind !== 'challan') notes.push('Composition taxable person, not eligible to collect tax on supplies');
    if (c.doc.kind === 'tax' && c.doc.supplyType !== 'regular') {
        const where = c.doc.supplyType.startsWith('export') ? 'export' : 'SEZ unit or SEZ developer for authorised operations';
        notes.push(c.doc.supplyType.endsWith('lut')
            ? `Supply meant for ${where} under bond or LUT without payment of IGST`
            : `Supply meant for ${where} on payment of IGST`);
    }
    for (const n of notes) {
        font(pdf, 7.5, 'italic', MUTED);
        pdf.text(n, W / 2, c.y + 1, { align: 'center' });
        c.y += 4;
    }
}

function newPage(c: Ctx): void {
    c.pdf.addPage();
    c.y = M;
    watermark(c);
    titleStrip(c, true);
}

function ensure(c: Ctx, h: number): void {
    if (c.y + h > BOTTOM) newPage(c);
}

// ── Header: seller and document details ──────────────────────────────────

type Row = [string, string];
/** A row whose value may be missing; missing rows are left out. */
type MaybeRow = [string, string | number | false | null | undefined];

const present = (rows: MaybeRow[]): Row[] => rows.filter((r): r is Row => typeof r[1] === 'string' && r[1] !== '');

const SHORT: Record<BillingDoc['kind'], string> = { tax: 'Invoice', proforma: 'Proforma', challan: 'Challan', credit: 'Note', debit: 'Note' };

function kindRows(doc: BillingDoc, source: BillingDoc | undefined): MaybeRow[] {
    const note = doc.kind === 'credit' || doc.kind === 'debit';
    const returnable = !!doc.challanPurpose && RETURNABLE.has(doc.challanPurpose);
    return [
        ['Due date', doc.kind === 'tax' && !!doc.dueDate && dateText(doc.dueDate)],
        ['Valid until', doc.kind === 'proforma' && !!doc.validUntil && dateText(doc.validUntil)],
        ['Purpose', doc.kind === 'challan' && !!doc.challanPurpose && PURPOSE_LABEL[doc.challanPurpose]],
        ['Return by', doc.kind === 'challan' && returnable && !!doc.returnBy && dateText(doc.returnBy)],
        ['Against invoice', note && !!source && `${source.number}, ${dateText(source.date)}`],
        ['Reason', note && doc.noteReason],
    ];
}

function shippingRows(doc: BillingDoc): MaybeRow[] {
    const tr = doc.transport;
    const ex = doc.exportInfo;
    const abroad = doc.supplyType !== 'regular';
    return [
        ['Supply type', doc.kind === 'tax' && abroad && SUPPLY_LABEL[doc.supplyType]],
        ['Reference', doc.reference],
        ['E-way bill', doc.ewayBillNo],
        ['Transport', [tr.mode, tr.transporter].filter(Boolean).join(', ')],
        ['Vehicle No.', tr.vehicleNo],
        ['LR / Docket', tr.lrNo],
        ['Dispatched', tr.dispatchDate],
        ['LUT / Bond', abroad && ex.lutNo],
        ['Port code', abroad && ex.portCode],
        ['Shipping bill', abroad && [ex.shippingBillNo, ex.shippingBillDate].filter(Boolean).join(', ')],
        ['Currency', abroad && !!ex.currency && !!ex.exchangeRate && `${ex.currency} @ Rs. ${ex.exchangeRate}`],
    ];
}

function metaRows(c: Ctx): Row[] {
    const { doc } = c;
    const short = doc.kind === 'tax' && isBillOfSupply(c.seller.registration) ? 'Bill' : SHORT[doc.kind];
    const reverse = doc.kind !== 'proforma' && doc.kind !== 'challan';
    return present([
        [`${short} No.`, doc.number || 'DRAFT'],
        ['Date', dateText(doc.date)],
        ...kindRows(doc, c.source),
        ['Place of supply', stateLabel(doc.placeOfSupply) || '-'],
        ['Reverse charge', reverse && (doc.reverseCharge ? 'Yes' : 'No')],
        ...shippingRows(doc),
    ]);
}

function drawHeader(c: Ctx): void {
    const { pdf, seller } = c;
    const top = c.y;
    const mid = M + CW * 0.54;

    let x = M + 2;
    let ly = top + 4.5;
    if (c.logo) {
        drawContained(pdf, c.logo, x, top + 2, 18, 18);
        x += 21;
    }
    const lw = mid - x - 2;
    font(pdf, 10.5, 'bold');
    for (const l of wrap(pdf, seller.legalName || 'Your business name', lw)) { pdf.text(l, x, ly); ly += 4.4; }
    font(pdf, 7.5);
    const lines = [
        seller.tradeName && seller.tradeName !== seller.legalName ? seller.tradeName : '',
        ...wrap(pdf, seller.address, lw),
        seller.gstin ? `GSTIN: ${seller.gstin}` : '',
        seller.state ? `State: ${stateLabel(seller.state)}` : '',
        seller.pan ? `PAN: ${seller.pan}` : '',
        [seller.phone, seller.email].filter(Boolean).join('  |  '),
    ].filter(Boolean);
    for (const l of lines) { pdf.text(l, x, ly); ly += 3.6; }
    if (c.logo) ly = Math.max(ly, top + 22);

    let ry = top + 4.5;
    for (const [k, v] of metaRows(c)) {
        font(pdf, 7, 'normal', MUTED);
        pdf.text(k, mid + 2, ry);
        font(pdf, 7.5, 'bold');
        const vl = wrap(pdf, v, R - mid - 30);
        pdf.text(vl, mid + 27, ry);
        ry += 3.7 * Math.max(1, vl.length);
    }

    const h = Math.max(ly, ry) - top + 1;
    pdf.setDrawColor(...LINE);
    pdf.setLineWidth(0.25);
    pdf.rect(M, top, CW, h);
    pdf.line(mid, top, mid, top + h);
    c.y = top + h;

    if (c.doc.irn) {
        const irnLines = [`IRN: ${c.doc.irn}`, [c.doc.ackNo && `Ack No.: ${c.doc.ackNo}`, c.doc.ackDate && `Ack date: ${c.doc.ackDate}`].filter(Boolean).join('    ')].filter(Boolean);
        font(pdf, 7);
        irnLines.forEach((l, i) => pdf.text(l, M + 2, c.y + 3.6 + i * 3.4));
        const ih = irnLines.length * 3.4 + 1.8;
        pdf.rect(M, c.y, CW, ih);
        c.y += ih;
    }
}

interface PartyInfo {
    label: string;
    name: string;
    address: string;
    /** null leaves the GSTIN line out (ship-to); '' prints Unregistered. */
    gstin: string | null;
    state: string;
    phone: string;
}

function partyBlock(c: Ctx, x: number, w: number, info: PartyInfo): number {
    const { pdf } = c;
    let y = c.y + 4;
    font(pdf, 6.5, 'bold', MUTED);
    pdf.text(info.label.toUpperCase(), x, y);
    y += 4;
    font(pdf, 9, 'bold');
    pdf.text(info.name || '-', x, y);
    y += 4;
    font(pdf, 7.5);
    const hideGstin = info.gstin === null || (c.doc.kind === 'proforma' && !info.gstin);
    const lines = [
        ...wrap(pdf, info.address, w),
        hideGstin ? '' : `GSTIN: ${info.gstin || 'Unregistered'}`,
        info.state ? `State: ${stateLabel(info.state)}` : '',
        info.phone,
    ].filter(Boolean);
    for (const l of lines) { pdf.text(l, x, y); y += 3.6; }
    return y;
}

const joined = (parts: string[], sep: string) => parts.filter(Boolean).join(sep);

function drawParties(c: Ctx): void {
    const { pdf, doc } = c;
    const p = doc.party;
    const top = c.y;
    const mid = M + CW / 2;
    const challan = doc.kind === 'challan';
    const billTo: PartyInfo = {
        label: challan ? 'Consignee' : 'Bill to', name: p.name, address: joined([p.address, p.pincode], ' - '),
        gstin: p.gstin, state: p.state, phone: joined([p.phone, p.email], '  |  '),
    };
    const shipTo: PartyInfo = p.sameShipping
        ? { ...billTo, gstin: null, phone: '' }
        : { name: p.shipName || p.name, address: joined([p.shipAddress, p.shipPincode], ' - '), gstin: null, state: p.shipState, phone: '', label: '' };
    shipTo.label = challan ? 'Delivery at' : 'Ship to';
    const a = partyBlock(c, M + 2, mid - M - 4, billTo);
    const b = partyBlock(c, mid + 2, R - mid - 4, shipTo);
    const h = Math.max(a, b) - top;
    pdf.setDrawColor(...LINE);
    pdf.rect(M, top, CW, h);
    pdf.line(mid, top, mid, top + h);
    c.y = top + h;
}

// ── Items table ──────────────────────────────────────────────────────────

interface Col { key: string; label: string; w: number; align: 'left' | 'right' | 'center' }

/** Where a cell's text starts (or ends, or centres) for its column's alignment. */
function textX(col: Col, x: number): number {
    if (col.align === 'right') return x + col.w - 1.5;
    if (col.align === 'center') return x + col.w / 2;
    return x + 1.5;
}

const photosOn = (doc: BillingDoc, s: BillingSettings): boolean =>
    (doc.kind === 'proforma' && s.print.photosOnProforma) || (doc.kind === 'tax' && s.print.photosOnInvoice);

function columns(c: Ctx, photos: boolean): Col[] {
    const half = sgstLabel(c.doc.placeOfSupply);
    let cols: Col[];
    if (c.mode === 'intra') {
        cols = [
            { key: 'n', label: '#', w: 6, align: 'center' }, { key: 'desc', label: 'Description', w: 44, align: 'left' },
            { key: 'hsn', label: 'HSN/SAC', w: 14, align: 'center' }, { key: 'qty', label: 'Qty', w: 12, align: 'right' },
            { key: 'rate', label: 'Rate', w: 20, align: 'right' }, { key: 'disc', label: 'Disc', w: 10, align: 'right' },
            { key: 'taxable', label: 'Taxable', w: 22, align: 'right' }, { key: 'cgst', label: 'CGST', w: 20, align: 'right' },
            { key: 'sgst', label: half, w: 20, align: 'right' }, { key: 'total', label: 'Total', w: 22, align: 'right' },
        ];
    } else if (c.mode === 'none') {
        cols = [
            { key: 'n', label: '#', w: 6, align: 'center' }, { key: 'desc', label: 'Description', w: 76, align: 'left' },
            { key: 'hsn', label: 'HSN/SAC', w: 16, align: 'center' }, { key: 'qty', label: 'Qty', w: 16, align: 'right' },
            { key: 'rate', label: 'Rate', w: 26, align: 'right' }, { key: 'disc', label: 'Disc', w: 12, align: 'right' },
            { key: 'total', label: c.doc.kind === 'challan' ? 'Value' : 'Amount', w: 38, align: 'right' },
        ];
    } else {
        cols = [
            { key: 'n', label: '#', w: 6, align: 'center' }, { key: 'desc', label: 'Description', w: 54, align: 'left' },
            { key: 'hsn', label: 'HSN/SAC', w: 14, align: 'center' }, { key: 'qty', label: 'Qty', w: 12, align: 'right' },
            { key: 'rate', label: 'Rate', w: 22, align: 'right' }, { key: 'disc', label: 'Disc', w: 10, align: 'right' },
            { key: 'taxable', label: 'Taxable', w: 24, align: 'right' }, { key: 'igst', label: 'IGST', w: 24, align: 'right' },
            { key: 'total', label: 'Total', w: 24, align: 'right' },
        ];
    }
    if (photos) {
        cols.splice(1, 0, { key: 'img', label: '', w: 20, align: 'center' });
        cols[2].w -= 20;
    }
    return cols;
}

function tableHeader(c: Ctx, cols: Col[]): void {
    const { pdf } = c;
    pdf.setFillColor(...FILL);
    pdf.setDrawColor(...LINE);
    pdf.rect(M, c.y, CW, 6.5, 'FD');
    font(pdf, 7, 'bold', MUTED);
    let x = M;
    for (const col of cols) {
        pdf.text(col.label, textX(col, x), c.y + 4.3, { align: col.align });
        x += col.w;
    }
    c.y += 6.5;
}

function cellText(c: Ctx, l: DocLine, i: number, key: string): string[] {
    const lt = c.t.lines[i];
    const half = (amount: number) => [formatPaise(amount), `@${l.gstRate / 2}%`];
    switch (key) {
        case 'n': return [String(i + 1)];
        case 'hsn': return [l.hsn];
        case 'qty': return [String(l.qty), l.unit];
        case 'rate': return [formatPaise(l.ratePaise)];
        case 'disc': return [l.discountPct ? `${l.discountPct}%` : '-'];
        case 'taxable': return [formatPaise(lt.taxable)];
        case 'cgst': return half(lt.cgst);
        case 'sgst': return half(lt.sgst);
        case 'igst': return [formatPaise(lt.igst), `@${c.mode === 'zero' ? 0 : l.gstRate}%`];
        case 'total': return [formatPaise(lt.total)];
        default: return [];
    }
}

interface RowText { title: string[]; small: string[]; height: number }

function rowText(c: Ctx, l: DocLine, descWidth: number, photos: boolean): RowText {
    const { pdf } = c;
    font(pdf, 7.5, 'bold');
    const title = wrap(pdf, l.description, descWidth - 3);
    font(pdf, 6.5);
    const detail = wrap(pdf, l.detail, descWidth - 3).slice(0, 3);
    const returned = c.doc.kind === 'challan' && l.returnedQty ? [`Returned: ${l.returnedQty} of ${l.qty}`] : [];
    const small = [...detail, ...returned];
    const height = Math.max(7, 2.5 + title.length * 3.3 + small.length * 2.9 + 1.5, photos ? 20 : 0);
    return { title, small, height };
}

function drawCell(c: Ctx, col: Col, x: number, l: DocLine, i: number, text: RowText): void {
    const { pdf } = c;
    if (col.key === 'desc') {
        font(pdf, 7.5, 'bold');
        pdf.text(text.title, x + 1.5, c.y + 3.6);
        font(pdf, 6.5, 'normal', MUTED);
        pdf.text(text.small, x + 1.5, c.y + 3.6 + text.title.length * 3.3);
        return;
    }
    if (col.key === 'img') {
        const img = c.photos[i];
        if (img) drawContained(pdf, img, x + 1, c.y + 1, col.w - 2, text.height - 2);
        return;
    }
    const [main, sub] = cellText(c, l, i, col.key);
    const tx = textX(col, x);
    font(pdf, 7.5);
    pdf.text(main ?? '', tx, c.y + 3.6, { align: col.align });
    if (sub) {
        font(pdf, 6, 'normal', MUTED);
        pdf.text(sub, tx, c.y + 6.4, { align: col.align });
    }
}

function drawTotalsRow(c: Ctx, cols: Col[]): void {
    const { pdf, doc, t } = c;
    ensure(c, 7);
    pdf.setFillColor(...FILL);
    pdf.rect(M, c.y, CW, 6.5, 'FD');
    const sums: Record<string, string> = {
        desc: 'Total', qty: String(doc.lines.reduce((s, l) => s + l.qty, 0)), taxable: formatPaise(t.taxable),
        cgst: formatPaise(t.cgst), sgst: formatPaise(t.sgst), igst: formatPaise(t.igst), total: formatPaise(t.lines.reduce((s, l) => s + l.total, 0)),
    };
    font(pdf, 7.5, 'bold');
    let x = M;
    for (const col of cols) {
        const right = col.align === 'right';
        if (sums[col.key]) pdf.text(sums[col.key], right ? x + col.w - 1.5 : x + 1.5, c.y + 4.3, { align: right ? 'right' : 'left' });
        x += col.w;
    }
    c.y += 6.5;
}

function drawItems(c: Ctx): void {
    const { pdf, doc } = c;
    const photos = photosOn(doc, c.s);
    const cols = columns(c, photos);
    const descCol = cols.find(col => col.key === 'desc')!;
    ensure(c, 20);
    tableHeader(c, cols);

    doc.lines.forEach((l, i) => {
        const text = rowText(c, l, descCol.w, photos);
        if (c.y + text.height > BOTTOM) { newPage(c); tableHeader(c, cols); }
        let x = M;
        for (const col of cols) {
            drawCell(c, col, x, l, i, text);
            x += col.w;
        }
        pdf.setDrawColor(...LINE);
        pdf.rect(M, c.y, CW, text.height);
        x = M;
        for (const col of cols.slice(0, -1)) { x += col.w; pdf.line(x, c.y, x, c.y + text.height); }
        c.y += text.height;
    });
    drawTotalsRow(c, cols);
}

// ── Totals, words, HSN summary, bank, terms, signature ───────────────────

/** The totals column: label, amount, and whether it is the grand total. */
function summaryRows(c: Ctx): [string, string, boolean][] {
    const { t, doc } = c;
    const rows: [string, string, boolean][] = [];
    if (t.discount) rows.push(['Gross amount', rs(t.gross), false], ['Less: discount', `- ${rs(t.discount)}`, false]);
    if (c.mode !== 'none') rows.push(['Taxable value', rs(t.taxable), false]);
    if (c.mode === 'intra') rows.push(['CGST', rs(t.cgst), false], [sgstLabel(doc.placeOfSupply), rs(t.sgst), false]);
    if (c.mode === 'inter' || c.mode === 'zero') rows.push(['IGST', rs(t.igst), false]);
    if (t.roundOff) rows.push(['Round off', `${t.roundOff > 0 ? '+' : '-'} ${rs(Math.abs(t.roundOff))}`, false]);
    rows.push([doc.kind === 'challan' ? 'Total value' : 'Grand total', rs(t.total), true]);
    if (doc.kind === 'proforma' && doc.advancePaise) rows.push(['Advance requested', rs(doc.advancePaise), false]);
    return rows;
}

function drawSummary(c: Ctx): void {
    const { pdf, t, doc } = c;
    const rows = summaryRows(c);
    const words = wrap(pdf, amountInWords(t.total), CW * 0.55 - 4);
    const h = Math.max(rows.length * 4.6 + 3, 9 + words.length * 3.6);
    ensure(c, h);
    const top = c.y;
    const mid = M + CW * 0.58;

    font(pdf, 6.5, 'bold', MUTED);
    pdf.text(doc.kind === 'challan' ? 'VALUE IN WORDS' : 'AMOUNT IN WORDS', M + 2, top + 4);
    font(pdf, 8, 'bold');
    pdf.text(words, M + 2, top + 8.5);

    let y = top + 4.3;
    for (const [k, v, strong] of rows) {
        if (strong) {
            pdf.setDrawColor(...LINE);
            pdf.line(mid, y - 3.2, R, y - 3.2);
            font(pdf, 9, 'bold', ACCENT);
        } else {
            font(pdf, 7.5);
        }
        pdf.text(k, mid + 2, y);
        pdf.text(v, R - 2, y, { align: 'right' });
        y += 4.6;
    }
    pdf.setDrawColor(...LINE);
    pdf.rect(M, top, CW, h);
    pdf.line(mid, top, mid, top + h);
    c.y = top + h;
}

function drawHsnSummary(c: Ctx): void {
    if (!c.s.print.hsnSummary || c.mode === 'none' || c.doc.kind === 'proforma') return;
    const { pdf, t } = c;
    const intra = c.mode === 'intra';
    const head = intra
        ? ['HSN/SAC', 'Taxable', 'CGST %', 'CGST', `${sgstLabel(c.doc.placeOfSupply)} %`, sgstLabel(c.doc.placeOfSupply), 'Total tax']
        : ['HSN/SAC', 'Taxable', 'IGST %', 'IGST', 'Total tax'];
    const w = CW / head.length;
    ensure(c, 6 + (t.hsn.length + 1) * 5);
    pdf.setFillColor(...FILL);
    pdf.setDrawColor(...LINE);
    pdf.rect(M, c.y, CW, 5.5, 'FD');
    font(pdf, 6.5, 'bold', MUTED);
    head.forEach((hd, i) => pdf.text(hd, M + w * (i + 1) - 1.5, c.y + 3.8, { align: 'right' }));
    c.y += 5.5;
    const body = t.hsn.map(h => intra
        ? [h.hsn, formatPaise(h.taxable), `${h.rate / 2}%`, formatPaise(h.cgst), `${h.rate / 2}%`, formatPaise(h.sgst), formatPaise(h.cgst + h.sgst)]
        : [h.hsn, formatPaise(h.taxable), `${c.mode === 'zero' ? 0 : h.rate}%`, formatPaise(h.igst), formatPaise(h.igst)]);
    body.push(intra
        ? ['Total', formatPaise(t.taxable), '', formatPaise(t.cgst), '', formatPaise(t.sgst), formatPaise(t.tax)]
        : ['Total', formatPaise(t.taxable), '', formatPaise(t.igst), formatPaise(t.tax)]);
    body.forEach((row, r) => {
        font(pdf, 7, r === body.length - 1 ? 'bold' : 'normal');
        row.forEach((v, i) => pdf.text(v, M + w * (i + 1) - 1.5, c.y + 3.6, { align: 'right' }));
        pdf.rect(M, c.y, CW, 5);
        c.y += 5;
    });
}

const DECLARATION: Partial<Record<BillingDoc['kind'], string>> = {
    challan: 'Received the above goods in good order and condition.',
    tax: 'We declare that this document shows the actual price of the goods described and that all particulars are true and correct.',
    credit: 'We declare that this document shows the actual price of the goods described and that all particulars are true and correct.',
    debit: 'We declare that this document shows the actual price of the goods described and that all particulars are true and correct.',
};

function bankLines(c: Ctx): string[] {
    const bank = c.seller.bank;
    if (!bank || c.doc.kind === 'challan' || c.doc.kind === 'credit') return [];
    const bankName = joined([bank.bankName, bank.branch], ', ');
    return [
        bank.accountName && `A/c name: ${bank.accountName}`,
        bankName && `Bank: ${bankName}`,
        bank.accountNumber && `A/c No.: ${bank.accountNumber}`,
        bank.ifsc && `IFSC: ${bank.ifsc}`,
        c.s.showUpiQr && bank.upiId ? `UPI: ${bank.upiId}` : '',
    ].filter(Boolean);
}

/** Bank, notes, terms and the declaration, for the left half of the footer. */
function footerNotes(c: Ctx, width: number): { label: string; lines: string[] }[] {
    const { pdf, doc } = c;
    const declaration = DECLARATION[doc.kind] ?? '';
    return [
        { label: 'Bank details', lines: bankLines(c) },
        { label: 'Notes', lines: wrap(pdf, doc.notes, width) },
        { label: 'Terms & conditions', lines: wrap(pdf, doc.terms, width) },
        { label: 'Declaration', lines: wrap(pdf, declaration, width) },
    ].filter(b => b.lines.length > 0);
}

function drawFooterBlocks(c: Ctx): void {
    const { pdf, doc, seller } = c;
    const mid = M + CW * 0.58;
    const left = footerNotes(c, mid - M - 4);
    const leftH = left.reduce((h, b) => h + 4.5 + b.lines.length * 3.3, 2);
    const h = Math.max(leftH, 30);
    ensure(c, h);
    const top = c.y;
    let y = top + 4;
    for (const b of left) {
        font(pdf, 6.5, 'bold', MUTED);
        pdf.text(b.label.toUpperCase(), M + 2, y);
        font(pdf, 7);
        pdf.text(b.lines, M + 2, y + 3.6);
        y += 4.5 + b.lines.length * 3.3;
    }

    font(pdf, 7.5, 'bold');
    pdf.text(`For ${seller.legalName || 'the business'}`, R - 2, top + 4.5, { align: 'right' });
    if (c.sign) drawContained(pdf, c.sign, R - 42, top + 7, 40, h - 15);
    font(pdf, 7, 'normal', MUTED);
    const signatory = c.s.signatoryName ? `${c.s.signatoryName}, Authorised Signatory` : 'Authorised Signatory';
    pdf.text(signatory, R - 2, top + h - 2.5, { align: 'right' });
    if (doc.kind === 'challan') pdf.text('Receiver’s signature', mid + 2, top + h - 2.5);

    pdf.setDrawColor(...LINE);
    pdf.rect(M, top, CW, h);
    pdf.line(mid, top, mid, top + h);
    c.y = top + h;
}

function drawPageFooters(pdf: jsPDF, s: BillingSettings, doc: BillingDoc, from: number, to: number): void {
    const count = to - from + 1;
    for (let p = from; p <= to; p++) {
        pdf.setPage(p);
        font(pdf, 6.5, 'italic', MUTED);
        const left = doc.kind === 'proforma' ? 'This is a proforma invoice and not a tax invoice.' : 'This is a computer-generated document.';
        pdf.text([left, s.print.footer].filter(Boolean).join('  '), M, H - 7);
        if (s.jurisdiction) pdf.text(s.jurisdiction, W / 2, H - 7, { align: 'center' });
        font(pdf, 6.5, 'normal', MUTED);
        pdf.text(`Page ${p - from + 1} of ${count}`, R, H - 7, { align: 'right' });
    }
}

async function dataImage(pdf: jsPDF, dataUrl: string): Promise<Img | null> {
    if (!dataUrl) return null;
    try {
        const p = pdf.getImageProperties(dataUrl);
        return p.fileType === 'JPEG' ? { data: dataUrl, w: p.width, h: p.height } : await loadImage(dataUrl, 600);
    } catch {
        return null;
    }
}

export async function buildDocPdf(doc: BillingDoc, s: BillingSettings, artworks: readonly Artwork[], source?: BillingDoc): Promise<Blob> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const seller = sellerOf(doc, s);
    const withPhotos = photosOn(doc, s);
    const byId = new Map(artworks.map(a => [a.id, a]));
    const [logo, sign, ...photos] = await Promise.all([
        dataImage(pdf, s.logoImage),
        dataImage(pdf, s.signatureImage),
        ...doc.lines.map(l => {
            const url = withPhotos ? byId.get(l.artworkId)?.imageUrls?.[0] ?? l.photoUrls?.[0] : undefined;
            return url ? loadImage(getThumbUrl(url), 500) : Promise.resolve(null);
        }),
    ]);
    const base = {
        pdf, y: M, doc, s, seller, t: docTotals(doc, s), mode: taxModeOf(doc, seller),
        title: kindLabel(doc.kind, seller.registration), source, photos, logo, sign,
    };

    copyLabels(doc, s).forEach((copy, i) => {
        if (i > 0) pdf.addPage();
        const from = pdf.getNumberOfPages();
        const c: Ctx = { ...base, copy, y: M };
        watermark(c);
        titleStrip(c);
        drawHeader(c);
        drawParties(c);
        drawItems(c);
        drawSummary(c);
        drawHsnSummary(c);
        drawFooterBlocks(c);
        drawPageFooters(pdf, s, doc, from, pdf.getNumberOfPages());
    });
    return pdf.output('blob');
}

export const docFileName = (doc: BillingDoc): string => {
    const who = doc.party.name.trim().replaceAll(/[^\w-]+/g, '_') || 'Customer';
    const no = (doc.number || 'Draft').replaceAll('/', '-');
    return `${KIND_LABEL[doc.kind].replaceAll(' ', '')}_${no}_${who}.pdf`;
};

/** Download, share (phone share sheet, e.g. WhatsApp) or print the PDF. */
export async function exportDocPdf(doc: BillingDoc, s: BillingSettings, artworks: readonly Artwork[], how: 'download' | 'share' | 'print', source?: BillingDoc): Promise<'shared' | 'downloaded' | 'printed'> {
    const blob = await buildDocPdf(doc, s, artworks, source);
    const name = docFileName(doc);
    if (how === 'share') {
        const file = new File([blob], name, { type: 'application/pdf' });
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: `${KIND_LABEL[doc.kind]} ${doc.number}` });
            return 'shared';
        }
    }
    const url = URL.createObjectURL(blob);
    if (how === 'print') {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
        frame.src = url;
        frame.onload = () => frame.contentWindow?.print();
        document.body.append(frame);
        setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000);
        return 'printed';
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
}
