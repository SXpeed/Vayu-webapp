// A month of someone's expenses as an A4 PDF: a table with the total, then
// each receipt photo with what it was for. Built on the phone and shared
// through the share sheet (WhatsApp, email, …) or downloaded.

import type { Expense } from '../expenseRules';
import { formatPaise } from '../gstRules';
import { drawContained, loadImage } from './billingPdf';

const M = 15; // margin, mm
const W = 210 - 2 * M;
const rs = (p: number) => `Rs. ${formatPaise(p)}`; // jsPDF's built-in fonts have no ₹
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export const expenseFileName = (person: string, monthLabel: string): string =>
    `Expenses_${monthLabel}_${person}`.replaceAll(/[^\w-]+/g, '_') + '.pdf';

export async function buildExpensePdf(expenses: Expense[], who: { person: string; workspace: string; monthLabel: string }): Promise<Blob> {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const rows = [...expenses].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
    const total = rows.reduce((s, e) => s + e.amountPaise, 0);

    pdf.setFont('helvetica', 'bold').setFontSize(18).text('Expense report', M, M + 6);
    pdf.setFont('helvetica', 'normal').setFontSize(10).setTextColor(90);
    pdf.text([`${who.person} · ${who.workspace}`, `${who.monthLabel} · ${rows.length} ${rows.length === 1 ? 'expense' : 'expenses'}`], M, M + 13);
    pdf.setTextColor(0);

    // Date | Category | Note | Amount
    const col = { date: M, cat: M + 28, note: M + 62, amount: M + W };
    const noteW = col.amount - 34 - col.note;
    let y = M + 30;
    const header = () => {
        pdf.setFont('helvetica', 'bold').setFontSize(9);
        pdf.text('Date', col.date, y); pdf.text('Category', col.cat, y); pdf.text('Note', col.note, y); pdf.text('Amount', col.amount, y, { align: 'right' });
        pdf.setDrawColor(180).line(M, y + 2, M + W, y + 2);
        pdf.setFont('helvetica', 'normal');
        y += 7;
    };
    header();
    for (const e of rows) {
        const note: string[] = pdf.splitTextToSize(e.note || '–', noteW);
        const h = Math.max(1, note.length) * 4.2 + 2.5;
        if (y + h > 297 - M - 12) { pdf.addPage(); y = M + 6; header(); }
        pdf.text(day(e.date), col.date, y); pdf.text(e.category, col.cat, y); pdf.text(note, col.note, y);
        pdf.text(rs(e.amountPaise), col.amount, y, { align: 'right' });
        y += h;
    }
    pdf.setDrawColor(180).line(M, y - 1, M + W, y - 1);
    pdf.setFont('helvetica', 'bold').setFontSize(11);
    pdf.text('Total', col.note, y + 5); pdf.text(rs(total), col.amount, y + 5, { align: 'right' });

    // Receipts: two to a page, each with what it was for.
    const receipts = rows.flatMap(e => e.receipts.map(url => ({ e, url })));
    const images = await Promise.all(receipts.map(r => loadImage(r.url, 1400)));
    const boxH = (297 - 2 * M - 2 * 10) / 2;
    receipts.forEach(({ e }, i) => {
        if (i % 2 === 0) pdf.addPage();
        const top = M + (i % 2) * (boxH + 10);
        pdf.setFont('helvetica', 'bold').setFontSize(10).text(`${day(e.date)} · ${e.category} · ${rs(e.amountPaise)}`, M, top + 4);
        const img = images[i];
        if (img) drawContained(pdf, img, M, top + 7, W, boxH - 7);
        else pdf.setFont('helvetica', 'normal').setTextColor(150).text('This receipt photo could not be loaded.', M, top + 14).setTextColor(0);
    });
    return pdf.output('blob');
}
