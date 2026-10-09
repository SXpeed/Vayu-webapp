import React from 'react';
import { HandCoins, Image as ImageIcon, IndianRupee, PackageX, ReceiptText, Tag, TrendingUp } from 'lucide-react';
import { Pill } from '../../components/ui';
import { StatStrip, type Stat } from '../../components/StatStrip';
import { getThumbUrl } from '../../services/storageService';
import type { PaymentMode, Sale, SalesSummary, TagTotal } from '../../salesRules';
import { itemsText, rupees } from '../../components/SalesSummary';

// The Sales screen's list, figures and tag filter. The editor and the page
// itself stay in views/SalesView.

export const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const chip = 'inline-flex items-center gap-1 rounded-full neu-inset px-2 py-0.5 text-[10.5px] leading-4 text-[var(--neu-text)]';

/** A sale's tags as small chips. */
export const TagChips: React.FC<{ tags: string[]; className?: string }> = ({ tags, className = 'mt-1 flex flex-wrap gap-1' }) => {
    if (!tags.length) return null;
    return <span className={className}>{tags.map(t => <span key={t} className={chip}><Tag size={9} aria-hidden="true" />{t}</span>)}</span>;
};

/** The item's photo, or what stands in for it: a piece since deleted, or one never in the inventory. */
export const ItemThumb: React.FC<{ sale: Pick<Sale, 'artworkId' | 'inInventory' | 'imageUrl'>; size?: string }> = ({ sale, size = 'w-11 h-11' }) => {
    let inner: React.ReactNode;
    if (sale.imageUrl) inner = <img src={getThumbUrl(sale.imageUrl)} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain p-0.5" />;
    else if (sale.artworkId && !sale.inInventory) inner = <PackageX size={16} strokeWidth={1.5} aria-hidden="true" />;
    else inner = sale.artworkId ? <ImageIcon size={16} strokeWidth={1.25} aria-hidden="true" /> : <ReceiptText size={16} strokeWidth={1.5} aria-hidden="true" />;
    return <span className={`neu-inset tile-backdrop shrink-0 ${size} rounded-xl overflow-hidden flex items-center justify-center text-[var(--neu-text-dim)]`}>{inner}</span>;
};

/** "Removed from inventory" / "Not in inventory", under the item's title. */
export const ItemNote: React.FC<{ sale: Pick<Sale, 'artworkId' | 'inInventory'> }> = ({ sale }) => {
    if (sale.artworkId && !sale.inInventory) return <span className="block text-[11.5px] sr-open-text">Removed from inventory</span>;
    if (!sale.artworkId) return <span className="block text-[11.5px] text-[var(--neu-text-dim)]">Not in inventory</span>;
    return null;
};

/** "Not in inventory" as a short note for the list's meta line, or null. */
function itemNoteText(sale: Pick<Sale, 'artworkId' | 'inInventory'>): string | null {
    if (sale.artworkId && !sale.inInventory) return 'Removed from inventory';
    return sale.artworkId ? null : 'Not in inventory';
}

/** Under an item's title: its sale number, where it came from, and its tags. */
const MetaLine: React.FC<{ sale: Sale; number?: boolean }> = ({ sale, number = true }) => {
    const note = itemNoteText(sale);
    const removed = !!sale.artworkId && !sale.inInventory;
    return (
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-[var(--neu-text-dim)]">
            {number && <span className="tabular-nums">{sale.saleNumber}</span>}
            {number && note && <span aria-hidden="true">·</span>}
            {note && <span className={removed ? 'sr-open-text' : ''}>{note}</span>}
            <TagChips tags={sale.tags} className="inline-flex flex-wrap gap-1" />
        </span>
    );
};

interface DayGroup { date: string; sales: Sale[]; total: number }

/** The sales in their order, a group per day. */
function groupByDay(sales: Sale[]): DayGroup[] {
    const groups: DayGroup[] = [];
    for (const s of sales) {
        const last = groups.at(-1);
        if (last?.date === s.saleDate) {
            last.sales.push(s);
            last.total += s.amount;
        } else {
            groups.push({ date: s.saleDate, sales: [s], total: s.amount });
        }
    }
    return groups;
}

/** "Tue, 29 Sept", with the year when it isn't this one. */
function groupLabel(iso: string, today: string): string {
    const d = new Date(`${iso}T00:00:00Z`);
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' };
    if (iso.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
    const text = d.toLocaleDateString('en-IN', opts);
    return iso === today ? `Today · ${text}` : text;
}

const salesText = (n: number): string => `${n} sale${n === 1 ? '' : 's'}`;

/** A day's heading: the date, and its count and takings. */
const DayHeading: React.FC<{ group: DayGroup; today: string }> = ({ group, today }) => (
    <>
        <span className="text-[var(--neu-text)]">{groupLabel(group.date, today)}</span>
        <span className="tabular-nums">{salesText(group.sales.length)} · <span className="text-[var(--neu-text)]">{rupees(group.total)}</span></span>
    </>
);

/** One sale on a phone: item, buyer and mode, and the amount. */
const PhoneRow: React.FC<{ sale: Sale; canRecord: boolean; onOpen: (s: Sale) => void }> = ({ sale: s, canRecord, onOpen }) => (
    <li>
        <button type="button" disabled={!canRecord} onClick={() => onOpen(s)}
            className="w-full px-3 py-2.5 flex items-center gap-3 text-left active-scale disabled:cursor-default">
            <ItemThumb sale={s} />
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[14px] text-[var(--neu-text)]">{s.itemTitle}</span>
                <span className="block truncate text-[12px] text-[var(--neu-text-dim)]">{s.buyerName} · {s.paymentMode}</span>
                {(s.tags.length > 0 || !s.artworkId || !s.inInventory) && <MetaLine sale={s} number={false} />}
            </span>
            <span className="shrink-0 text-right">
                <span className="block font-semibold tabular-nums text-[var(--neu-gold)]">{rupees(s.amount)}</span>
                <span className="block text-[10.5px] tabular-nums text-[var(--neu-text-dim)]">{s.saleNumber}</span>
            </span>
        </button>
    </li>
);

/** One sale in the table. The title is a button too, for the keyboard. */
const TableRow: React.FC<{ sale: Sale; canRecord: boolean; onOpen: (s: Sale) => void }> = ({ sale: s, canRecord, onOpen }) => (
    <tr onClick={canRecord ? () => onOpen(s) : undefined}
        className={`border-t border-[var(--neu-line)] ${canRecord ? 'cursor-pointer hover:bg-black/[0.025] dark:hover:bg-white/[0.03]' : ''}`}>
        <td className="pl-4 pr-2 py-2.5">
            <span className="flex items-center gap-3 min-w-0">
                <ItemThumb sale={s} size="w-10 h-10" />
                <span className="min-w-0">
                    {canRecord
                        ? <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(s); }} className="block max-w-full truncate font-medium text-left hover:underline">{s.itemTitle}</button>
                        : <span className="block truncate font-medium">{s.itemTitle}</span>}
                    <MetaLine sale={s} />
                </span>
            </span>
        </td>
        <td className="px-2 py-2.5">
            <span className="block truncate">{s.buyerName}</span>
            {s.buyerPhone && <span className="block truncate text-[11.5px] text-[var(--neu-text-dim)]">{s.buyerPhone}</span>}
        </td>
        <td className="px-2 py-2.5">
            <span className="block whitespace-nowrap">{s.paymentMode}</span>
            {s.referenceNo && <span className="block truncate text-[11.5px] text-[var(--neu-text-dim)]">{s.referenceNo}</span>}
        </td>
        <td className="pl-2 pr-4 py-2.5 text-right font-semibold tabular-nums text-[var(--neu-gold)] whitespace-nowrap">{rupees(s.amount)}</td>
    </tr>
);

/** The sales shown, a group per day: cards on a phone, a table elsewhere. Opening one needs "Record". */
export const SalesList: React.FC<{ sales: Sale[]; phone: boolean; today: string; canRecord: boolean; onOpen: (s: Sale) => void }> = ({ sales, phone, today, canRecord, onOpen }) => {
    if (!sales.length) return null;
    const groups = groupByDay(sales);
    if (phone) {
        return (
            <div className="space-y-4">
                {groups.map(g => (
                    <section key={g.date} aria-label={groupLabel(g.date, today)}>
                        <h3 className="mb-1.5 px-1 flex items-baseline justify-between gap-3 text-[12px] font-semibold text-[var(--neu-text-dim)]"><DayHeading group={g} today={today} /></h3>
                        <ul className="neu-card overflow-hidden divide-y divide-[var(--neu-line)]">
                            {g.sales.map(s => <PhoneRow key={s.id} sale={s} canRecord={canRecord} onOpen={onOpen} />)}
                        </ul>
                    </section>
                ))}
            </div>
        );
    }
    return (
        <div className="neu-card overflow-hidden">
            <table className="w-full table-fixed text-[13px] text-[var(--neu-text)]">
                <colgroup>
                    <col />
                    <col className="w-[24%]" />
                    <col className="w-[18%]" />
                    <col className="w-[8.5rem]" />
                </colgroup>
                <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-widest text-[var(--neu-text-dim)]">
                        <th scope="col" className="pl-4 pr-2 py-3 font-semibold">Item</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Buyer</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Payment</th>
                        <th scope="col" className="pl-2 pr-4 py-3 font-semibold text-right">Amount</th>
                    </tr>
                </thead>
                {groups.map(g => (
                    <tbody key={g.date}>
                        <tr className="border-t border-[var(--neu-line)] bg-black/[0.025] dark:bg-white/[0.035]">
                            <th scope="rowgroup" colSpan={4} className="px-4 py-2 text-left text-[12px] font-semibold text-[var(--neu-text-dim)]">
                                <span className="flex items-baseline justify-between gap-3"><DayHeading group={g} today={today} /></span>
                            </th>
                        </tr>
                        {g.sales.map(s => <TableRow key={s.id} sale={s} canRecord={canRecord} onOpen={onOpen} />)}
                    </tbody>
                ))}
            </table>
        </div>
    );
};

const MODE_COLOR: Record<PaymentMode, string> = {
    Cash: 'bg-emerald-500',
    UPI: 'bg-violet-500',
    Card: 'bg-sky-500',
    'Bank transfer': 'bg-amber-500',
    Cheque: 'bg-rose-400',
    Other: 'bg-slate-400',
};

/** How the takings split across payment modes: one bar of colours and a key, largest first. */
const ModeSplit: React.FC<{ summary: SalesSummary }> = ({ summary }) => {
    const rows = (Object.entries(summary.byMode) as [PaymentMode, { count: number; amount: number }][])
        .filter(([, m]) => m.count > 0)
        .sort((a, b) => b[1].amount - a[1].amount);
    const total = summary.totalAmount;
    return (
        <div className="min-w-0 col-span-2 sm:col-span-3 lg:col-span-1">
            <span className="flex items-center h-4 text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">By payment mode</span>
            {rows.length === 0 ? <p className="mt-1.5 text-[12px] text-[var(--neu-text-dim)]">No sales match.</p> : (
                <>
                    <span className="mt-2 flex h-2 gap-0.5 rounded-full overflow-hidden neu-inset" aria-hidden="true">
                        {rows.map(([mode, m]) => (
                            <span key={mode} className={`${MODE_COLOR[mode]} h-full`} style={{ width: `${total > 0 ? Math.max((m.amount / total) * 100, 1.5) : 100 / rows.length}%` }} />
                        ))}
                    </span>
                    <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-x-5 gap-y-1 text-[12px]" aria-label="By payment mode">
                        {rows.map(([mode, m]) => (
                            <li key={mode} className="flex items-center gap-2 min-w-0">
                                <i className={`w-2 h-2 rounded-full shrink-0 ${MODE_COLOR[mode]}`} aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate text-[var(--neu-text)]">{mode} <span className="text-[var(--neu-text-dim)]">· {m.count}</span></span>
                                <span className="shrink-0 tabular-nums text-[var(--neu-text)]">{rupees(m.amount)}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
};

/** When filters narrow the figures, says so, with the whole range's total beside. */
function filterNote(activeTag: string | null, all: SalesSummary, shown: SalesSummary): string {
    const which = activeTag === null ? '' : ` tagged “${activeTag || 'Untagged'}”`;
    const rest = all.count === shown.count ? '' : ` All sales in these dates: ${itemsText(all.count)} · ${rupees(all.totalAmount)}.`;
    return `Figures are for the sales shown${which}.${rest}`;
}

const averageText = (s: SalesSummary): string => (s.count ? rupees(Math.round(s.totalAmount / s.count)) : '—');

/** The headline figures: three side by side, or on a phone the takings with the rest under them. */
function salesStats(summary: SalesSummary, phone: boolean): Stat[] {
    const received: Stat = { label: 'Received', Icon: IndianRupee, value: rupees(summary.totalAmount), className: 'col-span-2 sm:col-span-1' };
    if (phone) return [{ ...received, sub: summary.count ? `${itemsText(summary.count)} · average ${averageText(summary)}` : itemsText(0) }];
    return [
        received,
        { label: 'Items sold', Icon: HandCoins, value: summary.count },
        { label: 'Average sale', Icon: TrendingUp, value: averageText(summary) },
    ];
}

/** Received, items sold, the average sale and the split by payment mode, for the sales shown. */
export const SalesFigures: React.FC<{ summary: SalesSummary; all: SalesSummary; filtered: boolean; activeTag: string | null; phone: boolean }> = ({ summary, all, filtered, activeTag, phone }) => (
    <StatStrip
        label="Figures"
        cols="grid-cols-2 sm:grid-cols-3 lg:grid-cols-[repeat(3,minmax(0,0.75fr))_minmax(0,1.5fr)]"
        stats={salesStats(summary, phone)}
        footer={filtered ? filterNote(activeTag, all, summary) : undefined}
    >
        <ModeSplit summary={summary} />
    </StatStrip>
);

/** One button per tag among the sales shown, with its count and takings, to see only that tag's. */
export const TagFilterBar: React.FC<{ byTag: TagTotal[]; allCount: number; activeTag: string | null; onAll: () => void; onPick: (tag: string) => void }> = ({ byTag, allCount, activeTag, onAll, onPick }) => (
    <fieldset className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1 md:flex-wrap md:overflow-visible" aria-label="Filter by tag">
        <Pill active={activeTag === null} onClick={onAll} className="shrink-0">All sales <span className="opacity-70 tabular-nums">{allCount}</span></Pill>
        {byTag.map(r => (
            <Pill key={r.tag || '(untagged)'} active={activeTag !== null && sameTag(activeTag, r.tag)} onClick={() => onPick(r.tag)} className="shrink-0">
                {r.tag ? <Tag size={11} aria-hidden="true" /> : null}{r.tag || 'Untagged'}
                <span className="opacity-70 tabular-nums">{r.count} · {rupees(r.amount)}</span>
            </Pill>
        ))}
        {activeTag !== null && !byTag.some(r => sameTag(r.tag, activeTag)) && (
            <Pill active onClick={onAll} className="shrink-0">{activeTag || 'Untagged'} <span className="opacity-70">0</span></Pill>
        )}
    </fieldset>
);
