// Sending a meeting on: as text (share sheet, WhatsApp, email) or as a
// printed page the browser saves as PDF. Printing, not jsPDF: the browser's
// own fonts draw Hindi and every other script a translation can be in.

import { APP_NAME } from '../../brand';
import { typeLabel, type Meeting } from '../../meetingRules';
import { currentWorkspace } from '../../services/workspace';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

const itemLine = (a: Meeting['actionItems'][number]) => {
    const who = a.owner ? `${a.owner}: ` : '';
    const due = a.due ? ` (by ${a.due})` : '';
    return `- ${who}${a.text}${due}`;
};

/** The summary and action items as plain text. */
export function meetingText(m: Meeting): string {
    const lines = [m.title, `${typeLabel(m.type)} meeting · ${when(m.heldAt)}`];
    if (m.attendees.length) lines.push(`Present: ${m.attendees.map(a => a.name).join(', ')}`);
    lines.push('', m.summary || m.transcript.slice(0, 3000));
    if (m.actionItems.length) lines.push('', 'Action items:', ...m.actionItems.map(itemLine));
    return lines.join('\n').trim();
}

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const mailtoUrl = (to: string[], subject: string, text: string) =>
    `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const section = (title: string, body: string) => (body.trim() ? `<h2>${esc(title)}</h2><div class="pre">${esc(body)}</div>` : '');

/** A print-ready page of the meeting; false when the browser blocked the new window. */
export function printMeeting(m: Meeting): boolean {
    const ws = currentWorkspace();
    const brand = ws?.name ?? APP_NAME;
    const logo = ws?.logoUrl ? `<img src="${esc(ws.logoUrl)}" alt="" class="logo">` : '';
    const items = m.actionItems.map(a => '<li>' + (a.done ? '☑ ' : '☐ ') + esc(itemLine(a).slice(2)) + '</li>').join('');
    const present = m.attendees.length ? ' · Present: ' + esc(m.attendees.map(a => a.name).join(', ')) : '';
    const itemsHtml = items ? '<h2>Action items</h2><ul>' + items + '</ul>' : '';
    const translation = m.translation ? section('Translation (' + m.translationLang + ')', m.translation) : '';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title>
<style>
  @page { margin: 18mm; }
  body { font: 11pt/1.55 system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans Devanagari", sans-serif; color: #1c1917; }
  header { display: flex; align-items: center; gap: 12px; border-bottom: 2px solid #b08d57; padding-bottom: 10px; margin-bottom: 18px; }
  .logo { height: 36px; } .brand { font-size: 10pt; color: #78716c; text-transform: uppercase; letter-spacing: .08em; }
  h1 { font: 600 20pt/1.2 Georgia, serif; margin: 0 0 4px; } .meta { color: #57534e; margin: 0 0 16px; }
  h2 { font: 600 13pt Georgia, serif; margin: 20px 0 6px; color: #7c5e2f; } .pre { white-space: pre-wrap; }
  ul { padding-left: 0; list-style: none; } li { margin: 3px 0; }
</style></head><body>
<header>${logo}<span class="brand">${esc(brand)}</span></header>
<h1>${esc(m.title)}</h1>
<p class="meta">${esc(typeLabel(m.type))} meeting · ${esc(when(m.heldAt))}${present}</p>
${section('Summary', m.summary)}
${itemsHtml}
${translation}
${section('Transcript', m.transcript)}
<script>addEventListener('load', () => setTimeout(() => print(), 300));</script>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) return false;
    w.document.open();
    w.document.write(html); // NOSONAR: our own escaped page in a window we just opened
    w.document.close();
    return true;
}
