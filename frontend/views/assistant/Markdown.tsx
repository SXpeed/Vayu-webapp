// An answer's Markdown drawn as React elements (markdownBlocks.ts reads it), so
// nothing in it is ever treated as HTML.
import React from 'react';
import { blocks, type Block, type Span } from './markdownBlocks';

const Spans: React.FC<{ spans: Span[] }> = ({ spans }) => (
    <>
        {spans.map((s, i) => {
            const key = `${i}-${s.k}`;
            if (s.k === 'b') return <strong key={key} className="font-semibold">{s.s}</strong>;
            if (s.k === 'i') return <em key={key}>{s.s}</em>;
            if (s.k === 'code') return <code key={key} className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[0.92em]">{s.s}</code>;
            return <React.Fragment key={key}>{s.s}</React.Fragment>;
        })}
    </>
);

const HEADING_CLS = ['text-[17px]', 'text-[16px]', 'text-[15px]'];

const BlockView: React.FC<{ b: Block }> = ({ b }) => {
    switch (b.k) {
        case 'h':
            return <p role="heading" aria-level={b.level} className={`font-semibold ${HEADING_CLS[b.level - 1] ?? 'text-[14px]'}`}><Spans spans={b.spans} /></p>;
        case 'ul':
        case 'ol': {
            const List = b.k;
            return <List className={`${b.k === 'ul' ? 'list-disc' : 'list-decimal'} pl-5 space-y-1`}>{b.items.map((it, i) => <li key={i}><Spans spans={it} /></li>)}</List>;
        }
        case 'table':
            return (
                <div className="overflow-x-auto -mx-1">
                    <table className="w-full text-[13px] border-collapse">
                        <thead><tr>{b.head.map((c, i) => <th key={i} scope="col" className="text-left font-semibold px-2 py-1.5 border-b border-black/10 dark:border-white/15"><Spans spans={c} /></th>)}</tr></thead>
                        <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-2 py-1.5 border-b border-black/5 dark:border-white/10 align-top"><Spans spans={c} /></td>)}</tr>)}</tbody>
                    </table>
                </div>
            );
        case 'code':
            return <pre className="overflow-x-auto rounded-lg bg-black/5 dark:bg-white/10 p-3 text-[12.5px]"><code>{b.s}</code></pre>;
        default:
            return <p>{b.lines.map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}<Spans spans={l} /></React.Fragment>)}</p>;
    }
};

export const Markdown: React.FC<{ text: string }> = ({ text }) => (
    <div className="space-y-2.5 text-[14px] leading-relaxed break-words">
        {blocks(text).map((b, i) => <BlockView key={i} b={b} />)}
    </div>
);
