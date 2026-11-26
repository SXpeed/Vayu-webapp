// The little Markdown the assistant writes (headings, lists, tables, code,
// **bold**, *italic*, `code`), read into plain data. The screen draws it as
// React elements, never as HTML, so an answer can't inject markup.
// shortcut: no links, images, nesting or quotes; use a Markdown library if answers start needing them.

export type Span = { k: 'text' | 'b' | 'i' | 'code'; s: string };
export type Block =
    | { k: 'p'; lines: Span[][] }
    | { k: 'h'; level: number; spans: Span[] }
    | { k: 'ul' | 'ol'; items: Span[][] }
    | { k: 'table'; head: Span[][]; rows: Span[][][] }
    | { k: 'code'; s: string };

/** **bold**, *italic*, `code`; anything else is text. */
export function spans(line: string): Span[] {
    const out: Span[] = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
    let at = 0;
    for (const m of line.matchAll(re)) {
        if (m.index > at) out.push({ k: 'text', s: line.slice(at, m.index) });
        if (m[1] !== undefined) out.push({ k: 'b', s: m[1] });
        else if (m[2] !== undefined) out.push({ k: 'code', s: m[2] });
        else out.push({ k: 'i', s: m[3] });
        at = m.index + m[0].length;
    }
    if (at < line.length) out.push({ k: 'text', s: line.slice(at) });
    return out;
}

const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => spans(c.trim()));
const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)]\s+/;
/** |---|:-:| under a table's head row. */
const isTableRule = (l = '') => l.includes('|') && l.includes('-') && /^[\s|:-]+$/.test(l);
const HEADING = /^(#{1,6})[ \t](.*)$/;

export function blocks(md: string): Block[] {
    const lines = md.replaceAll('\r', '').split('\n');
    const out: Block[] = [];
    let i = 0;
    const run = (test: (l: string) => boolean) => {
        const got: string[] = [];
        while (i < lines.length && test(lines[i])) got.push(lines[i++]);
        return got;
    };
    while (i < lines.length) {
        const line = lines[i];
        const heading = HEADING.exec(line);
        if (!line.trim()) i++;
        else if (line.trimStart().startsWith('```')) {
            i++;
            const code = run(l => !l.trimStart().startsWith('```'));
            i++; // the closing fence, if any
            out.push({ k: 'code', s: code.join('\n') });
        } else if (heading) {
            out.push({ k: 'h', level: heading[1].length, spans: spans(heading[2].trim()) });
            i++;
        } else if (line.includes('|') && isTableRule(lines[i + 1])) {
            const head = cells(line);
            i += 2;
            out.push({ k: 'table', head, rows: run(l => l.includes('|')).map(cells) });
        } else if (BULLET.test(line)) out.push({ k: 'ul', items: run(l => BULLET.test(l)).map(l => spans(l.replace(BULLET, ''))) });
        else if (NUMBER.test(line)) out.push({ k: 'ol', items: run(l => NUMBER.test(l)).map(l => spans(l.replace(NUMBER, ''))) });
        else out.push({ k: 'p', lines: run(l => !!l.trim() && !BULLET.test(l) && !NUMBER.test(l) && !HEADING.test(l) && !l.trimStart().startsWith('```')).map(spans) });
    }
    return out;
}
