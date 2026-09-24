import type { jsPDF } from 'jspdf';
import { Artwork, Invoice } from '../types';
import { getThumbUrl } from './storageService';

// A4 portrait, millimetres.
const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 14;
const RIGHT = PAGE_W - MARGIN;
const ROW_H = 30;
const IMAGE_BOX = 24;
const FOOTER_SPACE = 22;

const GOLD: [number, number, number] = [156, 96, 48];
const INK: [number, number, number] = [38, 32, 27];
const MUTED: [number, number, number] = [120, 112, 104];
const RULE: [number, number, number] = [225, 220, 214];

interface LoadedImage {
    dataUrl: string;
    width: number;
    height: number;
}

/** Built-in PDF fonts have no ₹ glyph, so amounts use "Rs.". */
export const formatAmount = (value: number): string =>
    `Rs. ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Loads an image as a white-backed JPEG no larger than maxPx; null if it can't be read. */
async function loadImage(url: string, maxPx: number): Promise<LoadedImage | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bitmap = await createImageBitmap(await res.blob());
        const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return { dataUrl: canvas.toDataURL('image/jpeg', 0.88), width: canvas.width, height: canvas.height };
    } catch {
        return null;
    }
}

/** Draws an image centred inside a square box, keeping its aspect ratio. */
function drawContained(doc: jsPDF, img: LoadedImage, x: number, y: number, box: number): void {
    const ratio = Math.min(box / img.width, box / img.height);
    const w = img.width * ratio;
    const h = img.height * ratio;
    doc.addImage(img.dataUrl, 'JPEG', x + (box - w) / 2, y + (box - h) / 2, w, h);
}

function drawHeader(doc: jsPDF, invoice: Invoice, logo: LoadedImage | null): number {
    if (logo) drawContained(doc, logo, MARGIN, MARGIN, 24);
    const brandX = logo ? MARGIN + 29 : MARGIN;
    doc.setFont('times', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...INK);
    doc.text('Vayu', brandX, MARGIN + 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('DESIGN FOR LIVING', brandX, MARGIN + 16.5);

    doc.setFont('times', 'bold');
    doc.setFontSize(17);
    doc.setTextColor(...GOLD);
    doc.text('PROFORMA INVOICE', RIGHT, MARGIN + 8, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(`No. ${invoice.invoiceNumber}`, RIGHT, MARGIN + 15, { align: 'right' });
    const dateText = new Date(invoice.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    doc.text(`Date: ${dateText}`, RIGHT, MARGIN + 20, { align: 'right' });

    const ruleY = MARGIN + 30;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.line(MARGIN, ruleY, RIGHT, ruleY);
    return ruleY + 8;
}

function drawBillTo(doc: jsPDF, invoice: Invoice, startY: number): number {
    let y = startY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('BILL TO', MARGIN, y);
    y += 6;
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...INK);
    doc.text(invoice.customerName, MARGIN, y);
    y += 5.5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    const contactLines = [invoice.customerPhone, invoice.customerEmail].filter((line): line is string => !!line?.trim());
    for (const line of contactLines) {
        doc.text(line, MARGIN, y);
        y += 5;
    }
    if (invoice.customerAddress?.trim()) {
        const wrapped: string[] = doc.splitTextToSize(invoice.customerAddress.trim(), 110);
        doc.text(wrapped, MARGIN, y);
        y += wrapped.length * 4.6;
    }
    return y + 6;
}

function drawTableHeader(doc: jsPDF, y: number): number {
    doc.setFillColor(246, 243, 238);
    doc.rect(MARGIN, y, RIGHT - MARGIN, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text('#', MARGIN + 2, y + 5.3);
    doc.text('ARTWORK', MARGIN + 10, y + 5.3);
    doc.text('AMOUNT', RIGHT - 2, y + 5.3, { align: 'right' });
    return y + 11;
}

/** Secondary lines under an item title, built from whatever artwork details exist. */
function itemDetailLines(art: Artwork | undefined): string[] {
    if (!art) return [];
    const byline = [art.artist, art.artworkYear].filter(Boolean).join(', ');
    const material = [art.medium, art.dimensions].filter(Boolean).join('  |  ');
    const reference = art.customId ? `Ref: ${art.customId}` : '';
    return [byline, material, reference].filter(Boolean);
}

function drawItemRow(doc: jsPDF, index: number, title: string, price: number, art: Artwork | undefined, image: LoadedImage | null, y: number): void {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(String(index + 1), MARGIN + 2, y + 5);

    const imageX = MARGIN + 10;
    if (image) {
        drawContained(doc, image, imageX, y, IMAGE_BOX);
    } else {
        doc.setFillColor(242, 240, 236);
        doc.rect(imageX, y, IMAGE_BOX, IMAGE_BOX, 'F');
    }

    const textX = imageX + IMAGE_BOX + 5;
    const textWidth = RIGHT - 45 - textX;
    doc.setFont('times', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...INK);
    const titleLines: string[] = doc.splitTextToSize(title, textWidth);
    doc.text(titleLines.slice(0, 2), textX, y + 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    let detailY = y + 5 + Math.min(titleLines.length, 2) * 4.6;
    for (const line of itemDetailLines(art)) {
        doc.text(doc.splitTextToSize(line, textWidth)[0], textX, detailY);
        detailY += 4.2;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(formatAmount(price), RIGHT - 2, y + 5, { align: 'right' });

    doc.setDrawColor(...RULE);
    doc.line(MARGIN, y + ROW_H - 3, RIGHT, y + ROW_H - 3);
}

function drawTotals(doc: jsPDF, invoice: Invoice, startY: number): void {
    const labelX = RIGHT - 70;
    let y = startY + 4;
    const row = (label: string, value: string) => {
        doc.text(label, labelX, y);
        doc.text(value, RIGHT - 2, y, { align: 'right' });
        y += 6;
    };
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK);
    row('Subtotal', formatAmount(invoice.subtotal));
    const taxPercent = Number((invoice.taxRate * 100).toFixed(2));
    row(`GST (${taxPercent}%)`, formatAmount(invoice.total - invoice.subtotal));

    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.4);
    doc.line(labelX, y - 2, RIGHT, y - 2);
    y += 4;
    doc.setFont('times', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...GOLD);
    doc.text('Total', labelX, y);
    doc.text(formatAmount(invoice.total), RIGHT - 2, y, { align: 'right' });
}

function drawFooters(doc: jsPDF): void {
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
        doc.setPage(page);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...MUTED);
        doc.text('This is a proforma invoice and not a tax invoice.', MARGIN, PAGE_H - 10);
        doc.setFont('helvetica', 'normal');
        doc.text(`Page ${page} of ${pages}`, RIGHT, PAGE_H - 10, { align: 'right' });
    }
}

export const proformaFileName = (invoice: Invoice): string => {
    const customer = invoice.customerName.trim().replaceAll(/[^\w-]+/g, '_');
    return `Proforma_${invoice.invoiceNumber}_${customer}.pdf`;
};

/** Builds the proforma invoice PDF, with a thumbnail of each artwork. */
export async function buildProformaPdf(invoice: Invoice, artworks: Artwork[]): Promise<Blob> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });

    const artById = new Map(artworks.map(a => [a.id, a]));
    const [logo, ...images] = await Promise.all([
        // The invoice's own letterhead logo, kept apart from the app icon.
        loadImage('/invoice-logo.png', 400),
        ...invoice.items.map((item) => {
            const url = artById.get(item.artworkId)?.imageUrls?.[0];
            return url ? loadImage(getThumbUrl(url), 600) : Promise.resolve(null);
        }),
    ]);

    let y = drawHeader(doc, invoice, logo);
    y = drawBillTo(doc, invoice, y);
    y = drawTableHeader(doc, y);

    invoice.items.forEach((item, index) => {
        if (y + ROW_H > PAGE_H - FOOTER_SPACE) {
            doc.addPage();
            y = drawTableHeader(doc, MARGIN);
        }
        drawItemRow(doc, index, item.title, item.price, artById.get(item.artworkId), images[index], y);
        y += ROW_H;
    });

    if (y + 30 > PAGE_H - FOOTER_SPACE) {
        doc.addPage();
        y = MARGIN;
    }
    drawTotals(doc, invoice, y);
    drawFooters(doc);
    return doc.output('blob');
}

/** Saves the PDF, or opens the phone's share sheet when `share` is set and supported. */
export async function exportProformaPdf(invoice: Invoice, artworks: Artwork[], share = false): Promise<'shared' | 'downloaded'> {
    const blob = await buildProformaPdf(invoice, artworks);
    const fileName = proformaFileName(invoice);
    if (share) {
        const file = new File([blob], fileName, { type: 'application/pdf' });
        if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: `Proforma Invoice ${invoice.invoiceNumber}` });
            return 'shared';
        }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
}
