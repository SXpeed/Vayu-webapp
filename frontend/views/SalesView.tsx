import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, CloudOff, HandCoins, Image as ImageIcon, IndianRupee, Loader2, PackageX, Plus, ReceiptText, RotateCcw, Tag, Trash2, X } from 'lucide-react';
import { ArtworkPicker } from '../components/ArtworkPicker';
import { PhotoAttachments } from '../components/PhotoAttachments';
import { SearchBar } from '../components/SearchBar';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { Button, EmptyState, Field, Input, PageBody, PageHeader, PageRoot, Pill, PrimaryIconButton, Select, Textarea } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { realtimeService } from '../services/realtimeService';
import { salesService, type PendingSale, type SalesData } from '../services/salesService';
import { getThumbUrl } from '../services/storageService';
import {
    MAX_PHOTOS, MAX_TAG_LENGTH, MAX_TAGS, PAYMENT_MODES, cleanTags, monthRange, saleFieldErrors, shiftMonth, summarize, summarizeByTag, todayIso,
    type PaymentMode, type Sale, type SaleInput, type SalesSummary, type TagTotal,
} from '../salesRules';
import { addDays, mondayOf } from '../staffRosterRules';
import type { Artwork, Contact } from '../types';
import { Drawer, Msg } from './staffRoster/Panels';
import { ModeBreakdown, TagBreakdown, itemsText, rupees, saleDayLabel as dayLabel } from '../components/SalesSummary';

interface SalesViewProps {
    artworks: Artwork[];
    contacts: Contact[];
}

const REFERENCE_HINT: Record<PaymentMode, string> = {
    Cash: 'Receipt number (optional)',
    Card: 'Approval code or last 4 digits',
    UPI: 'UPI transaction ID',
    'Bank transfer': 'UTR number',
    Cheque: 'Cheque number and bank',
    Other: 'Reference (optional)',
};

const monthLabel = (first: string): string =>
    new Date(`${first}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const yearOf = (iso: string): string => iso.slice(0, 4);

type RangeKind = 'week' | 'month' | 'custom';
interface Range { kind: RangeKind; from: string; to: string }

const MAX_CUSTOM_DAYS = 366;
const RANGE_TABS: [RangeKind, string][] = [['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']];

/** The week (Monday to Sunday) or month around a day. */
function rangeAround(kind: 'week' | 'month', day: string): Range {
    if (kind === 'week') {
        const from = mondayOf(day);
        return { kind, from, to: addDays(from, 6) };
    }
    const [from, to] = monthRange(day);
    return { kind, from, to };
}

function rangeLabel(r: Range): string {
    if (r.kind === 'month') return monthLabel(r.from);
    const sameYear = yearOf(r.from) === yearOf(r.to);
    return `${dayLabel(r.from)}${sameYear ? '' : ' ' + yearOf(r.from)} – ${dayLabel(r.to)} ${yearOf(r.to)}`;
}

const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/** A tag filter: every sale, or one tag ('' = untagged sales). */
type TagFilter = { kind: 'all' } | { kind: 'tag'; tag: string };
const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const hasTag = (s: Pick<Sale, 'tags'>, tag: string): boolean => (tag === '' ? s.tags.length === 0 : s.tags.some(t => sameTag(t, tag)));

const chip = 'inline-flex items-center gap-1 rounded-full neu-inset px-2 py-0.5 text-[10.5px] text-[var(--neu-text)]';

/** A sale's tags as small chips. */
const TagChips: React.FC<{ tags: string[] }> = ({ tags }) => {
    if (!tags.length) return null;
    return <span className="mt-1 flex flex-wrap gap-1">{tags.map(t => <span key={t} className={chip}><Tag size={9} aria-hidden="true" />{t}</span>)}</span>;
};

/** The item's photo, or what stands in for it: a piece since deleted, or one never in the inventory. */
const ItemThumb: React.FC<{ sale: Pick<Sale, 'artworkId' | 'inInventory' | 'imageUrl'>; size?: string }> = ({ sale, size = 'w-11 h-11' }) => {
    let inner: React.ReactNode;
    if (sale.imageUrl) inner = <img src={getThumbUrl(sale.imageUrl)} alt="" loading="lazy" decoding="async" className="w-full h-full object-contain p-0.5" />;
    else if (sale.artworkId && !sale.inInventory) inner = <PackageX size={16} strokeWidth={1.5} aria-hidden="true" />;
    else inner = sale.artworkId ? <ImageIcon size={16} strokeWidth={1.25} aria-hidden="true" /> : <ReceiptText size={16} strokeWidth={1.5} aria-hidden="true" />;
    return <span className={`neu-inset tile-backdrop shrink-0 ${size} rounded-xl overflow-hidden flex items-center justify-center text-[var(--neu-text-dim)]`}>{inner}</span>;
};

/** "Removed from inventory" / "Not in inventory", under the item's title. */
const ItemNote: React.FC<{ sale: Pick<Sale, 'artworkId' | 'inInventory'> }> = ({ sale }) => {
    if (sale.artworkId && !sale.inInventory) return <span className="block text-[10.5px] uppercase tracking-wider sr-open-text">Removed from inventory</span>;
    if (!sale.artworkId) return <span className="block text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)]">Not in inventory</span>;
    return null;
};

/** Sales recorded on this device that haven't reached the server yet. */
const PendingSection: React.FC<{ pending: PendingSale[]; artworks: Artwork[]; canRecord: boolean; onRetry: (p: PendingSale) => void; onDiscard: (p: PendingSale) => void }> = ({ pending, artworks, canRecord, onRetry, onDiscard }) => {
    if (!pending.length) return null;
    return (
        <section className="neu-card p-3.5 space-y-2.5" aria-label="Waiting to upload">
            <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--neu-text-dim)]"><CloudOff size={13} /> Waiting to upload</h2>
            {pending.map(p => (
                <div key={p.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                    <ItemThumb sale={{ artworkId: p.input.artworkId, inInventory: true, imageUrl: artworks.find(a => a.id === p.input.artworkId)?.imageUrls[0] ?? p.input.photoUrls?.[0] ?? null }} size="w-9 h-9" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{p.input.itemTitle || artworks.find(a => a.id === p.input.artworkId)?.title || 'Inventory piece'}</span>
                        <span className="block text-[11.5px] text-[var(--neu-text-dim)]">{dayLabel(p.input.saleDate)} · {p.input.buyerName} · {p.input.paymentMode} · {rupees(p.input.amount)}</span>
                        <TagChips tags={p.input.tags ?? []} />
                        {p.error && <span className="block text-[11.5px] sr-bad-text">Not saved: {p.error}</span>}
                    </span>
                    {p.error && canRecord && <Button onClick={() => onRetry(p)} icon={<RotateCcw size={13} />}>Try again</Button>}
                    {canRecord && <Button variant="danger" onClick={() => onDiscard(p)} icon={<Trash2 size={13} />}>Discard</Button>}
                </div>
            ))}
            <p className="text-[11.5px] text-[var(--neu-text-dim)]">These get their sale numbers when they reach the server. They aren’t in the totals yet.</p>
        </section>
    );
};

/** The sales shown: cards on a phone, a table elsewhere. Tapping one opens it (with "Record"). */
const SalesList: React.FC<{ sales: Sale[]; phone: boolean; canRecord: boolean; onOpen: (s: Sale) => void }> = ({ sales, phone, canRecord, onOpen }) => {
    if (!sales.length) return null;
    if (phone) {
        return (
            <ul className="space-y-2.5">
                {sales.map(s => (
                    <li key={s.id}>
                        <button type="button" disabled={!canRecord} onClick={() => onOpen(s)}
                            className="neu-card w-full p-3 flex items-center gap-3 text-left active-scale disabled:cursor-default">
                            <ItemThumb sale={s} />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-[14px] text-[var(--neu-text)]">{s.itemTitle}</span>
                                <ItemNote sale={s} />
                                <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{dayLabel(s.saleDate)} · {s.buyerName}</span>
                                <TagChips tags={s.tags} />
                            </span>
                            <span className="text-right shrink-0">
                                <span className="block font-semibold tabular-nums text-[var(--neu-gold)]">{rupees(s.amount)}</span>
                                <span className="block text-[11px] text-[var(--neu-text-dim)]">{s.paymentMode}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        );
    }
    return (
        <div className="neu-card overflow-x-auto">
            <table className="w-full text-[13px]">
                <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-widest text-[var(--neu-text-dim)]">
                        <th scope="col" className="px-4 py-3 font-semibold">Date</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Item</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Buyer</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Mode</th>
                        <th scope="col" className="px-2 py-3 font-semibold">Reference</th>
                        <th scope="col" className="px-4 py-3 font-semibold text-right">Amount</th>
                    </tr>
                </thead>
                <tbody>
                    {sales.map(s => (
                        <tr key={s.id} onClick={canRecord ? () => onOpen(s) : undefined}
                            className={`border-t border-[var(--neu-line)] ${canRecord ? 'cursor-pointer hover:bg-black/[0.025] dark:hover:bg-white/[0.03]' : ''}`}>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                                {dayLabel(s.saleDate)}
                                <span className="block text-[10.5px] text-[var(--neu-text-dim)]">{s.saleNumber}</span>
                            </td>
                            <td className="px-2 py-2.5">
                                <span className="flex items-center gap-2.5 min-w-[12rem]">
                                    <ItemThumb sale={s} size="w-9 h-9" />
                                    <span className="min-w-0">
                                        {canRecord
                                            ? <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(s); }} className="block truncate max-w-[16rem] font-medium text-left hover:underline">{s.itemTitle}</button>
                                            : <span className="block truncate max-w-[16rem] font-medium">{s.itemTitle}</span>}
                                        <ItemNote sale={s} />
                                        <TagChips tags={s.tags} />
                                    </span>
                                </span>
                            </td>
                            <td className="px-2 py-2.5">
                                <span className="block truncate max-w-[12rem]">{s.buyerName}</span>
                                {s.buyerPhone && <span className="block text-[11px] text-[var(--neu-text-dim)]">{s.buyerPhone}</span>}
                            </td>
                            <td className="px-2 py-2.5 whitespace-nowrap">{s.paymentMode}</td>
                            <td className="px-2 py-2.5 text-[var(--neu-text-dim)] truncate max-w-[10rem]">{s.referenceNo || '—'}</td>
                            <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-[var(--neu-gold)] whitespace-nowrap">{rupees(s.amount)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>

    );
};

/** Week / Month / Custom, and moving through them. */
const RangeBar: React.FC<{
    range: Range; today: string; current: boolean; draft: { from: string; to: string }; problem: string | null;
    onKind: (k: RangeKind) => void; onMove: (by: number) => void; onCustom: (from: string, to: string) => void; onReset: () => void;
}> = ({ range, today, current, draft, problem, onKind, onMove, onCustom, onReset }) => (
    <>
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 p-1 rounded-full neu-inset shrink-0" role="tablist" aria-label="Dates">
                {RANGE_TABS.map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={range.kind === k} onClick={() => onKind(k)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${range.kind === k ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                        {label}
                    </button>
                ))}
            </div>
            {range.kind === 'custom' ? (
                <div className="flex items-center gap-1.5 flex-1 min-w-[15rem]">
                    <label className="sr-only" htmlFor="sales-from">From</label>
                    <Input id="sales-from" type="date" value={draft.from} max={today} onChange={e => onCustom(e.target.value, draft.to)} className="!py-1.5 !text-[13px] flex-1 min-w-0" />
                    <span className="text-[var(--neu-text-dim)]" aria-hidden="true">–</span>
                    <label className="sr-only" htmlFor="sales-to">To</label>
                    <Input id="sales-to" type="date" value={draft.to} max={today} onChange={e => onCustom(draft.from, e.target.value)} className="!py-1.5 !text-[13px] flex-1 min-w-0" />
                </div>
            ) : (
                <div className="flex items-center gap-1.5 flex-1 min-w-[14rem]">
                    <button type="button" onClick={() => onMove(-1)} aria-label={range.kind === 'week' ? 'Previous week' : 'Previous month'} className="neu-icon-btn-sm active-scale"><ChevronLeft size={15} /></button>
                    <span className="flex-1 sm:flex-none sm:min-w-[11rem] text-center text-[13px] font-semibold" aria-live="polite">{rangeLabel(range)}</span>
                    <button type="button" onClick={() => onMove(1)} disabled={range.to >= today} aria-label={range.kind === 'week' ? 'Next week' : 'Next month'} className="neu-icon-btn-sm active-scale disabled:opacity-40"><ChevronRight size={15} /></button>
                    {!current && (
                        <button type="button" onClick={onReset} className="neu-pill shrink-0">
                            {range.kind === 'week' ? 'This week' : 'This month'}
                        </button>
                    )}
                </div>
            )}
        </div>
        {range.kind === 'custom' && problem && <p className="text-[12px] sr-bad-text" role="alert">{problem}</p>}
    </>
);

const OfflineNote: React.FC<{ savedAt: number | null; canRecord: boolean }> = ({ savedAt, canRecord }) => (
    <Msg kind="warn">
        <Msg kind="warn">
            You’re offline. {savedAt ? `Showing the copy saved on this device at ${new Date(savedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.` : 'Nothing for these dates is saved on this device yet.'}
            {canRecord ? ' Sales you record now upload when you’re back online.' : ''}
        </Msg>
    </Msg>
);

/** One button per tag among the sales shown, to see only that tag's. */
const TagFilterBar: React.FC<{ byTag: TagTotal[]; activeTag: string | null; onAll: () => void; onPick: (tag: string) => void }> = ({ byTag, activeTag, onAll, onPick }) => (
    <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1" role="group" aria-label="Filter by tag">
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1" role="group" aria-label="Filter by tag">
            <Pill active={activeTag === null} onClick={onAll} className="shrink-0">All sales</Pill>
            {byTag.map(r => (
                <Pill key={r.tag || '(untagged)'} active={activeTag !== null && sameTag(activeTag, r.tag)} onClick={() => onPick(r.tag)} className="shrink-0">
                    {r.tag ? <Tag size={11} aria-hidden="true" /> : null}{r.tag || 'Untagged'} · {r.count}
                </Pill>
            ))}
            {activeTag !== null && !byTag.some(r => sameTag(r.tag, activeTag)) && (
                <Pill active onClick={onAll} className="shrink-0">{activeTag || 'Untagged'} · 0</Pill>
            )}
        </div>
    </div>
);

/** Items sold and received, and the split by payment mode and (when used) by tag. */
const SummaryGrid: React.FC<{ summary: SalesSummary; anyTagged: boolean; byTag: TagTotal[]; matchingTotal: number; activeTag: string | null; onPick: (tag: string) => void }> = ({ summary, anyTagged, byTag, matchingTotal, activeTag, onPick }) => (
    <div className={`grid grid-cols-1 gap-3 lg:gap-4 ${anyTagged ? 'sm:grid-cols-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]' : 'sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]'}`}>
        <div className="grid grid-cols-2 sm:grid-cols-1 gap-3 lg:gap-4">
            <div className="neu-card p-3 lg:p-4">
                <div className="flex items-center gap-2 mb-1.5"><HandCoins size={14} className="text-gold-500" /><span className="text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">Items sold</span></div>
                <p className="text-xl lg:text-2xl font-serif tabular-nums text-gray-900 dark:text-white">{summary.count}</p>
            </div>
            <div className="neu-card p-3 lg:p-4">
                <div className="flex items-center gap-2 mb-1.5"><IndianRupee size={14} className="text-gold-500" /><span className="text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">Received</span></div>
                <p className="text-xl lg:text-2xl font-serif tabular-nums text-gray-900 dark:text-white">{rupees(summary.totalAmount)}</p>
            </div>
        </div>
        <div className="neu-card p-3.5 lg:p-4">
            <h2 className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">By payment mode</h2>
            {summary.count ? <ModeBreakdown summary={summary} /> : <p className="text-[12px] text-[var(--neu-text-dim)]">No sales match.</p>}
        </div>
        {anyTagged && (
            <div className="neu-card p-3.5 lg:p-4 sm:col-span-2 xl:col-span-1">
                <h2 className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">By tag</h2>
                <TagBreakdown rows={byTag} total={matchingTotal}
                    active={activeTag === null ? undefined : byTag.find(r => sameTag(r.tag, activeTag))?.tag}
                    onPick={onPick} />
                <p className="mt-2.5 text-[11px] text-[var(--neu-text-dim)]">Tap a tag to see only its sales. A sale with two tags counts under both.</p>
            </div>
        )}
    </div>
);

/** When filters narrow the figures, says so, with the whole range's total beside. */
const FilterNote: React.FC<{ activeTag: string | null; all: SalesSummary; shown: SalesSummary }> = ({ activeTag, all, shown }) => (
    <p className="-mt-2 text-[11.5px] text-[var(--neu-text-dim)]">
        <p className="-mt-2 text-[11.5px] text-[var(--neu-text-dim)]">
            Figures above are for the sales shown{activeTag === null ? '' : ` tagged “${activeTag || 'Untagged'}”`}.
            {all.count === shown.count ? '' : ` All sales in these dates: ${itemsText(all.count)} · ${rupees(all.totalAmount)}.`}
        </p>
    </p>
);

/** An inventory piece already sold by this sale: shown, not changeable. */
const LinkedItem: React.FC<{ sale: Sale }> = ({ sale }) => (
    <div className="neu-inset rounded-2xl p-3 flex items-center gap-3">
        <ItemThumb sale={sale} />
        <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-[14px]">{sale.itemTitle}</span>
            <ItemNote sale={sale} />
            <span className="block text-[11.5px] text-[var(--neu-text-dim)]">Listed at {rupees(sale.itemPrice)}</span>
        </span>
    </div>
);

/** An item that isn't in the inventory: what it was, its price and photos. */
const FreeTextItem: React.FC<{
    title: string; priceText: string; photoUrls: string[];
    onTitle: (v: string) => void; onPrice: (v: string) => void; onAddPhotos: (urls: string[]) => void; onRemovePhoto: (url: string) => void;
    onUploading: (busy: boolean) => void; onChoose?: () => void;
}> = ({ title, priceText, photoUrls, onTitle, onPrice, onAddPhotos, onRemovePhoto, onUploading, onChoose }) => (
    <div className="space-y-3">
        <Field label="What was sold" htmlFor="sale-item">
            <Input id="sale-item" value={title} onChange={e => onTitle(e.target.value)} placeholder="e.g. Framed print, gift card" maxLength={200} data-autofocus />
        </Field>
        <Field label="Its price (optional)" htmlFor="sale-item-price">
            <Input id="sale-item-price" type="number" inputMode="decimal" min={0} step="0.01" value={priceText} onChange={e => onPrice(e.target.value)} />
        </Field>
        <div>
            <span className="neu-label">Photos (optional)</span>
            <PhotoAttachments
                urls={photoUrls}
                onAdd={onAddPhotos}
                onRemove={onRemovePhoto}
                onUploadingChange={onUploading}
            />
            <p className="mt-1 text-[11px] text-[var(--neu-text-dim)]">Up to {MAX_PHOTOS}. Photos need a connection to upload.</p>
        </div>
        {onChoose && (
            <button type="button" onClick={onChoose} className="text-[12px] font-semibold text-gold-700 dark:text-gold-300 underline underline-offset-2">Choose from the inventory instead</button>
        )}
    </div>
);

/** Choosing the piece sold among the available ones. */
const PieceChooser: React.FC<{ available: Artwork[]; picked: Artwork | null; pickedId: string | null; onPick: (id: string) => void; onNotListed: () => void }> = ({ available, picked, pickedId, onPick, onNotListed }) => (
    <div className="space-y-2">
        {picked && <p className="text-[12.5px]">Selected: <strong className="font-medium">{picked.title}</strong> · listed at {rupees(picked.price)}</p>}
        <ArtworkPicker
            artworks={available}
            selected={new Set(pickedId ? [pickedId] : [])}
            onToggle={onPick}
            statusFilters={false}
            scroll
            detail={a => [a.customId, rupees(a.price)].filter(Boolean).join(' · ')}
            searchPlaceholder="Search available pieces…"
        />
        <button type="button" onClick={onNotListed} className="text-[12px] font-semibold text-gold-700 dark:text-gold-300 underline underline-offset-2">Item not in the list?</button>
    </div>
);

/** A sale against the payment-mode filter and the search words. */
function matchesFilters(s: Sale, mode: 'all' | PaymentMode, q: string): boolean {
    if (mode !== 'all' && s.paymentMode !== mode) return false;
    return !q || [s.buyerName, s.buyerPhone, s.itemTitle, s.saleNumber, s.referenceNo, ...s.tags].some(v => v.toLowerCase().includes(q));
}

/** "Kala Ghoda Fair: 12 items · ₹40,000 · 1 waiting to upload" */
function subtitleFor(summary: SalesSummary | null, activeTag: string | null, pendingCount: number): string {
    let text = 'Store sales by week, month or any dates';
    if (summary) {
        text = `${itemsText(summary.count)} · ${rupees(summary.totalAmount)}`;
        if (activeTag !== null) text = `${activeTag || 'Untagged'}: ${text}`;
    }
    return pendingCount ? `${text} · ${pendingCount} waiting to upload` : text;
}

/** What is wrong with custom dates, or null when they can be shown (or aren't both chosen yet). */
function customRangeProblem(from: string, to: string): string | null {
    if (!from || !to) return null;
    if (to < from) return 'The end date is before the start date.';
    return daysBetween(from, to) > MAX_CUSTOM_DAYS ? 'Choose at most a year at a time.' : null;
}

/** The page's main content: the load failing, loading, nothing in the dates, nothing matching, or the sales. */
const SalesBody: React.FC<{
    error: string | null; data: SalesData | null; shown: Sale[]; rangeText: string; canRecord: boolean;
    onRetryLoad: () => void; onShowAll: () => void; children: React.ReactNode;
}> = ({ error, data, shown, rangeText, canRecord, onRetryLoad, onShowAll, children }) => {
    if (!data) {
        if (error) return <EmptyState icon={<HandCoins size={22} strokeWidth={1.5} />} title="The sales didn’t load" message={error} action={<Button onClick={onRetryLoad}>Try again</Button>} />;
        return <div className="py-20 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    }
    if (data.pending.length) return <>{children}</>;
    if (!data.sales.length) {
        return (
            <EmptyState
                icon={<HandCoins size={22} strokeWidth={1.5} />}
                title={`No sales in ${rangeText}`}
                message={canRecord ? 'Record a sale with the + button above.' : 'Sales recorded by the accounts team show here.'}
            />
        );
    }
    if (!shown.length) return <EmptyState icon={<HandCoins size={22} strokeWidth={1.5} />} title="No sales match" message="Try another tag, payment mode or search." action={<Button onClick={onShowAll}>Show all</Button>} />;
    return <>{children}</>;
};

type Editor = { sale: Sale | null } | null;

/**
 * The sales ledger: store sales paid offline, month by month. Everyone with
 * the Sales permission sees it; "Record" adds, changes and deletes sales.
 * Recording works offline too: the sale waits on this device and gets its
 * number when it reaches the server.
 */
export const SalesView: React.FC<SalesViewProps> = ({ artworks, contacts }) => {
    const { can } = useAppChrome();
    const canRecord = can('sales', 'edit');
    const isPhone = useMediaQuery('(max-width: 767px)');
    const [range, setRange] = useState<Range>(() => rangeAround('month', todayIso()));
    const [data, setData] = useState<SalesData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'all' | PaymentMode>('all');
    const [tagFilter, setTagFilter] = useState<TagFilter>({ kind: 'all' });
    const [query, setQuery] = useState('');
    const [editor, setEditor] = useState<Editor>(null);
    const [customProblem, setCustomProblem] = useState<string | null>(null);
    // The custom dates as typed; the range changes only once they make sense.
    const [customDraft, setCustomDraft] = useState({ from: '', to: '' });

    const { from, to } = range;
    const loadedAt = useRef(0);
    const showing = useRef(`${from}|${to}`);
    showing.current = `${from}|${to}`;
    const load = useCallback(async () => {
        try {
            const next = await salesService.load(from, to);
            // A slow answer for dates already left behind mustn't replace the ones on screen.
            if (showing.current !== `${from}|${to}`) return;
            setData(next);
            setError(null);
            loadedAt.current = Date.now();
        } catch (e) {
            if (showing.current !== `${from}|${to}`) return;
            const err = e as Error & { code?: string };
            setError(err.code === 'module_off' ? 'Sales aren’t part of this workspace’s plan.' : err.message || 'Could not load the sales');
        }
    }, [from, to]);

    useEffect(() => { setData(null); void load(); }, [load]);
    useEffect(() => {
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'sales') && document.visibilityState === 'visible') void load();
        });
        const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > 30_000) void load(); };
        const onOnline = () => { void load(); };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('online', onOnline);
        return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', onOnline); };
    }, [load]);

    const q = query.trim().toLowerCase();
    // Mode and search first; the tag breakdown shows every tag among these.
    const matching = useMemo(() => (data?.sales ?? []).filter(s => matchesFilters(s, mode, q)), [data, mode, q]);
    const shown = useMemo(() => (tagFilter.kind === 'all' ? matching : matching.filter(s => hasTag(s, tagFilter.tag))), [matching, tagFilter]);
    const byTag = useMemo(() => summarizeByTag(matching), [matching]);
    const anyTagged = byTag.some(r => r.tag !== '');
    // The figures follow the filters, so choosing an event's tag gives that event's takings.
    const summary = useMemo(() => (data ? summarize(shown) : null), [data, shown]);
    const filtered = mode !== 'all' || !!q || tagFilter.kind !== 'all';
    const activeTag = tagFilter.kind === 'tag' ? tagFilter.tag : null;

    const today = todayIso();
    const pendingCount = data?.pending.length ?? 0;
    const subtitle = subtitleFor(summary, activeTag, pendingCount);

    const move = (by: number) => setRange(r => (r.kind === 'week'
        ? rangeAround('week', addDays(r.from, by * 7))
        : rangeAround('month', shiftMonth(r.from, by))));
    const pickKind = (kind: RangeKind) => {
        setCustomProblem(null);
        if (kind === range.kind) return;
        if (kind === 'custom') {
            // Custom starts from the dates on screen, to adjust from there.
            const next: Range = { kind, from: range.from, to: range.to > today ? today : range.to };
            setCustomDraft({ from: next.from, to: next.to });
            setRange(next);
            return;
        }
        setRange(rangeAround(kind, today));
    };
    const setCustom = (nextFrom: string, nextTo: string) => {
        setCustomDraft({ from: nextFrom, to: nextTo });
        const problem = customRangeProblem(nextFrom, nextTo);
        setCustomProblem(problem);
        if (!problem && nextFrom && nextTo) setRange({ kind: 'custom', from: nextFrom, to: nextTo });
    };
    const current = range.kind !== 'custom' && range.from === rangeAround(range.kind, today).from;
    const pickTag = (tag: string) => setTagFilter(f => (f.kind === 'tag' && sameTag(f.tag, tag) ? { kind: 'all' } : { kind: 'tag', tag }));
    const showAll = () => { setTagFilter({ kind: 'all' }); setMode('all'); setQuery(''); };
    const resetRange = () => setRange(rangeAround(range.kind === 'week' ? 'week' : 'month', today));

    const discard = (p: PendingSale) => {
        salesService.discardPending(p.id);
        toast.success('Removed from this device');
        void load();
    };
    const retry = async (p: PendingSale) => {
        await salesService.retryPending(p.id).catch(() => undefined);
        void load();
    };

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Sales"
                subtitle={subtitle}
                actions={canRecord ? <PrimaryIconButton onClick={() => setEditor({ sale: null })} label="Record sale" icon={<Plus size={16} />} /> : undefined}
            >
                <RangeBar range={range} today={today} current={current} draft={customDraft} problem={customProblem}
                    onKind={pickKind} onMove={move} onCustom={setCustom} onReset={resetRange} />
                <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor="sales-mode">Payment mode</label>
                    <Select id="sales-mode" value={mode} onChange={e => setMode(e.target.value as 'all' | PaymentMode)} className="!w-auto !rounded-full !py-2 shrink-0">
                        <option value="all">All modes</option>
                        {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </Select>
                    <SearchBar value={query} onChange={setQuery} placeholder="Search buyer, item, tag or reference" className="flex-1 min-w-0" />
                </div>
            </PageHeader>

            <PageBody space="lg">
                {data?.offline && <OfflineNote savedAt={data.savedAt} canRecord={canRecord} />}

                {anyTagged && <TagFilterBar byTag={byTag} activeTag={activeTag} onAll={() => setTagFilter({ kind: 'all' })} onPick={pickTag} />}

                {summary && (data?.sales.length ?? 0) > 0 && (
                    <SummaryGrid summary={summary} anyTagged={anyTagged} byTag={byTag} matchingTotal={summarize(matching).totalAmount} activeTag={activeTag} onPick={pickTag} />
                )}
                {filtered && summary && data && data.sales.length > 0 && <FilterNote activeTag={activeTag} all={data.summary} shown={summary} />}

                <SalesBody error={error} data={data} shown={shown} rangeText={rangeLabel(range)} canRecord={canRecord} onRetryLoad={() => { void load(); }} onShowAll={showAll}>
                    <PendingSection pending={data?.pending ?? []} artworks={artworks} canRecord={canRecord} onRetry={p => { void retry(p); }} onDiscard={discard} />
                    <SalesList sales={shown} phone={isPhone} canRecord={canRecord} onOpen={s => setEditor({ sale: s })} />
                </SalesBody>
            </PageBody>

            {editor && (
                <SaleEditor
                    key={editor.sale?.id ?? 'new'}
                    sale={editor.sale}
                    artworks={artworks}
                    contacts={contacts}
                    allTags={data?.allTags ?? []}
                    reserved={new Set(data?.pending.map(p => p.input.artworkId).filter((id): id is string => !!id))}
                    onClose={() => setEditor(null)}
                    onSaved={() => { setEditor(null); void load(); }}
                />
            )}
        </PageRoot>
    );
};

const inputOf = (s: Sale): SaleInput => ({
    artworkId: s.artworkId, itemTitle: s.itemTitle, itemPrice: s.itemPrice, contactId: s.contactId, buyerName: s.buyerName,
    buyerPhone: s.buyerPhone, saleDate: s.saleDate, amount: s.amount, paymentMode: s.paymentMode, referenceNo: s.referenceNo, notes: s.notes,
    tags: s.tags, photoUrls: s.photoUrls,
});

const EMPTY: SaleInput = {
    artworkId: null, itemTitle: '', itemPrice: 0, contactId: null, buyerName: '', buyerPhone: '',
    saleDate: '', amount: 0, paymentMode: 'Cash', referenceNo: '', notes: '', tags: [], photoUrls: [],
};

/** The tags of the last sale recorded on this device: at an event, every sale carries the event's tag. */
const LAST_TAGS_KEY = 'vayu.sales.lastTags';
const lastTags = (): string[] => {
    try { return cleanTags(JSON.parse(localStorage.getItem(LAST_TAGS_KEY) ?? '[]')); } catch { return []; }
};
const rememberTags = (tags: string[]) => {
    try { localStorage.setItem(LAST_TAGS_KEY, JSON.stringify(tags)); } catch { /* private mode */ }
};

/** Chips for the sale's tags, a field to add one, and the tags already in use to tap. */
const TagEditor: React.FC<{ tags: string[]; allTags: string[]; onChange: (tags: string[]) => void; carried: boolean }> = ({ tags, allTags, onChange, carried }) => {
    const [draft, setDraft] = useState('');
    const add = (text: string) => {
        const next = cleanTags([...tags, ...text.split(',')]);
        if (next.length !== tags.length) onChange(next);
        setDraft('');
    };
    const suggestions = allTags.filter(t => !tags.some(x => sameTag(x, t))).slice(0, 8);
    const full = tags.length >= MAX_TAGS;
    return (
        <div>
            <label className="neu-label" htmlFor="sale-tag">Tags (optional)</label>
            {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                    {tags.map(t => (
                        <span key={t} className="inline-flex items-center gap-1 rounded-full neu-inset pl-2.5 pr-1 py-1 text-[12px] text-[var(--neu-text)]">
                            <Tag size={11} aria-hidden="true" />{t}
                            <button type="button" onClick={() => onChange(tags.filter(x => x !== t))} aria-label={`Remove tag ${t}`}
                                className="w-5 h-5 rounded-full flex items-center justify-center text-[var(--neu-text-dim)] hover:text-[var(--neu-text)]"><X size={12} /></button>
                        </span>
                    ))}
                </div>
            )}
            <div className="flex gap-2">
                <Input id="sale-tag" value={draft} disabled={full} maxLength={MAX_TAG_LENGTH + 20} list={allTags.length ? 'sale-tag-list' : undefined} autoComplete="off"
                    placeholder={full ? `Up to ${MAX_TAGS} tags` : 'e.g. an event: Kala Ghoda Fair 2026'}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if ((e.key === 'Enter' || e.key === ',') && draft.trim()) { e.preventDefault(); add(draft); } }}
                    onBlur={() => { if (draft.trim()) add(draft); }} />
                <Button onClick={() => add(draft)} disabled={!draft.trim() || full}>Add</Button>
            </div>
            {allTags.length > 0 && <datalist id="sale-tag-list">{allTags.map(t => <option key={t} value={t} />)}</datalist>}
            {suggestions.length > 0 && !full && (
                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Tags in use">
                    {suggestions.map(t => <Pill key={t} onClick={() => onChange(cleanTags([...tags, t]))} className="!py-1 !text-[11.5px]">+ {t}</Pill>)}
                </div>
            )}
            <p className="mt-1.5 text-[11px] text-[var(--neu-text-dim)]">
                {carried ? 'Kept from your last sale, for the next sale at the same event. Remove it if this one is different.' : 'Group sales by event or anything else, then see each tag’s takings.'}
            </p>
        </div>
    );
};

/** Numbers typed into a field: '' while empty, so the field can be cleared. */
const numberText = (n: number): string => (n ? String(n) : '');

/** The form's starting point: the sale being changed, or a new one for today with the last sale's tags. */
function firstDraft(sale: Sale | null, carriedTags: string[]): SaleInput {
    return sale ? inputOf(sale) : { ...EMPTY, saleDate: todayIso(), tags: carriedTags };
}

/** What is sent: the typed numbers read, and only the fields that belong to the kind of item. */
function buildInput(s: SaleInput, freeText: boolean, priceText: string, amountText: string): SaleInput {
    return {
        ...s,
        artworkId: freeText ? null : s.artworkId,
        itemTitle: freeText ? s.itemTitle : '',
        itemPrice: freeText ? (Number(priceText) || 0) : s.itemPrice,
        amount: amountText.trim() ? Number(amountText) : 0,
        // Photos belong to items that aren't in the inventory; a piece shows its own.
        photoUrls: freeText ? s.photoUrls : [],
    };
}

/** Contacts by name (lower case), the first of each name. */
function contactIndex(contacts: Contact[]): Map<string, Contact> {
    const seen = new Map<string, Contact>();
    for (const c of contacts) {
        const key = c.name?.toLowerCase();
        if (key && !seen.has(key)) seen.set(key, c);
    }
    return seen;
}

/** The buyer's name as typed; a contact's name also links the contact and fills an empty phone. */
function withBuyer(s: SaleInput, name: string, contacts: Map<string, Contact>): Partial<SaleInput> {
    const contact = contacts.get(name.trim().toLowerCase());
    if (!contact) return { buyerName: name, contactId: null };
    return { buyerName: name, contactId: contact.id, buyerPhone: s.buyerPhone || contact.phone || '' };
}

/** Saves the sale and says how it went: recorded, saved, or kept on the device until back online. */
async function saveSale(sale: Sale | null, input: SaleInput): Promise<{ message: string; long?: boolean }> {
    if (sale) {
        await salesService.update(sale.id, input);
        return { message: 'Sale saved' };
    }
    const result = await salesService.record(input);
    rememberTags(input.tags);
    if ('pending' in result) return { message: 'Saved on this device. It uploads, and gets its number, when you’re back online.', long: true };
    return { message: `Sale ${result.sale.saleNumber} recorded` };
}

const piecesBack = (sale: Sale | null): boolean => !!sale?.artworkId && sale.inInventory;

const BuyerFields: React.FC<{ s: SaleInput; contacts: Map<string, Contact>; onBuyer: (name: string) => void; onPhone: (phone: string) => void }> = ({ s, contacts, onBuyer, onPhone }) => (
    <>
        <Field label="Buyer" htmlFor="sale-buyer" hint={s.contactId ? 'From your contacts' : undefined}>
            <Input id="sale-buyer" value={s.buyerName} onChange={e => onBuyer(e.target.value)} list={contacts.size ? 'sale-contacts' : undefined} autoComplete="off" maxLength={120} />
            {contacts.size > 0 && (
                <datalist id="sale-contacts">
                    {[...contacts.values()].map(c => <option key={c.id} value={c.name}>{c.phone}</option>)}
                </datalist>
            )}
        </Field>
        <Field label="Buyer’s phone (optional)" htmlFor="sale-phone">
            <Input id="sale-phone" type="tel" inputMode="tel" value={s.buyerPhone} onChange={e => onPhone(e.target.value)} maxLength={40} />
        </Field>
    </>
);

const PaymentFields: React.FC<{ s: SaleInput; amountText: string; onAmount: (v: string) => void; set: (patch: Partial<SaleInput>) => void }> = ({ s, amountText, onAmount, set }) => (
    <>
        <div className="grid grid-cols-2 gap-3">
            <Field label="Day of sale" htmlFor="sale-date">
                <Input id="sale-date" type="date" max={todayIso()} value={s.saleDate} onChange={e => set({ saleDate: e.target.value })} />
            </Field>
            <Field label="Amount received" htmlFor="sale-amount">
                <Input id="sale-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amountText} onChange={e => onAmount(e.target.value)} />
            </Field>
        </div>
        <div>
            <span className="neu-label" id="sale-mode-label">Paid by</span>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="sale-mode-label">
                {PAYMENT_MODES.map(m => <Pill key={m} active={s.paymentMode === m} onClick={() => set({ paymentMode: m })}>{m}</Pill>)}
            </div>
        </div>
        <Field label="Reference" htmlFor="sale-ref">
            <Input id="sale-ref" value={s.referenceNo} onChange={e => set({ referenceNo: e.target.value })} placeholder={REFERENCE_HINT[s.paymentMode]} maxLength={80} />
        </Field>
    </>
);

const EditorFooter: React.FC<{ isNew: boolean; busy: boolean; uploading: boolean; onDelete: () => void; onSave: () => void }> = ({ isNew, busy, uploading, onDelete, onSave }) => {
    let label = isNew ? 'Record sale' : 'Save';
    if (uploading) label = 'Uploading photos…';
    const waiting = busy || uploading;
    return (
        <>
            {!isNew && <Button variant="danger" onClick={onDelete} disabled={busy} icon={<Trash2 size={14} />}>Delete</Button>}
            <Button variant="primary" onClick={onSave} disabled={waiting} className="ml-auto" icon={waiting ? <Loader2 size={14} className="animate-spin" /> : undefined}>
                {label}
            </Button>
        </>
    );
};

/** When and by whom an existing sale was recorded. */
const RecordedNote: React.FC<{ sale: Sale }> = ({ sale }) => (
    <p className="text-[11.5px] text-[var(--neu-text-dim)]">
        Recorded {new Date(sale.recordedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{sale.createdByName ? ' by ' + sale.createdByName : ''}.
    </p>
);

/** Record a sale, or change one. Recording needs "Record"; the server checks again. */
const SaleEditor: React.FC<{
    sale: Sale | null;
    artworks: Artwork[];
    contacts: Contact[];
    /** Every tag in use, for suggestions. */
    allTags: string[];
    /** Pieces in sales still waiting to upload: not offered again. */
    reserved: ReadonlySet<string>;
    onClose: () => void;
    onSaved: () => void;
}> = ({ sale, artworks, contacts, allTags, reserved, onClose, onSaved }) => {
    const isNew = !sale;
    const [carriedTags] = useState(() => (sale ? [] : lastTags()));
    const [s, setS] = useState<SaleInput>(() => firstDraft(sale, carriedTags));
    const [uploading, setUploading] = useState(false);
    const [amountText, setAmountText] = useState(numberText(sale?.amount ?? 0));
    const [priceText, setPriceText] = useState(numberText(sale && !sale.artworkId ? sale.itemPrice : 0));
    const available = useMemo(() => artworks.filter(a => a.status === 'Available' && !reserved.has(a.id)), [artworks, reserved]);
    const [freeText, setFreeText] = useState(() => (sale ? !sale.artworkId : available.length === 0));
    const [tried, setTried] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const amountTouched = useRef(!!sale);
    const contactsByName = useMemo(() => contactIndex(contacts), [contacts]);

    const set = (patch: Partial<SaleInput>) => setS(prev => ({ ...prev, ...patch }));
    const picked = artworks.find(a => a.id === s.artworkId) ?? null;
    const input = buildInput(s, freeText, priceText, amountText);
    const errors = saleFieldErrors(input);

    const pick = (id: string) => {
        if (s.artworkId === id) { set({ artworkId: null }); return; }
        const art = artworks.find(a => a.id === id);
        set({ artworkId: id, itemTitle: '', itemPrice: art?.price ?? 0 });
        if (art && !amountTouched.current) setAmountText(numberText(art.price));
    };
    const addPhotos = (urls: string[]) => setS(prev => {
        const next = [...prev.photoUrls, ...urls];
        if (next.length > MAX_PHOTOS) toast.error(`Up to ${MAX_PHOTOS} photos: the extra ones weren’t added.`);
        return { ...prev, photoUrls: next.slice(0, MAX_PHOTOS) };
    });
    const removePhoto = (url: string) => setS(prev => ({ ...prev, photoUrls: prev.photoUrls.filter(u => u !== url) }));

    const save = async () => {
        setTried(true);
        if (errors.length || busy) return;
        if (uploading) { toast.error('Wait for the photos to finish uploading.'); return; }
        setBusy(true);
        try {
            const { message, long } = await saveSale(sale, input);
            toast.success(message, long ? { duration: 5000 } : undefined);
            onSaved();
        } catch (e) {
            toast.error((e as Error).message || 'Could not save the sale');
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!sale) return;
        setConfirmDelete(false);
        setBusy(true);
        try {
            await salesService.remove(sale.id);
            toast.success(piecesBack(sale) ? 'Sale deleted. The piece is available again.' : 'Sale deleted');
            onSaved();
        } catch (e) {
            toast.error((e as Error).message || 'Could not delete the sale');
            setBusy(false);
        }
    };

    let item: React.ReactNode;
    if (sale?.artworkId) {
        item = <LinkedItem sale={sale} />;
    } else if (freeText) {
        item = (
            <FreeTextItem title={s.itemTitle} priceText={priceText} photoUrls={s.photoUrls}
                onTitle={v => set({ itemTitle: v })} onPrice={setPriceText} onAddPhotos={addPhotos} onRemovePhoto={removePhoto}
                onUploading={setUploading} onChoose={isNew && available.length > 0 ? () => setFreeText(false) : undefined} />
        );
    } else {
        item = <PieceChooser available={available} picked={picked} pickedId={s.artworkId} onPick={pick} onNotListed={() => { setFreeText(true); set({ artworkId: null }); }} />;
    }
    const carried = isNew && carriedTags.length > 0 && carriedTags.every(t => s.tags.includes(t));

    return (
        <Drawer
            title={sale ? `Sale ${sale.saleNumber}` : 'Record sale'}
            onClose={onClose}
            footer={<EditorFooter isNew={isNew} busy={busy} uploading={uploading} onDelete={() => setConfirmDelete(true)} onSave={() => { void save(); }} />}
        >
            <section aria-label="Item" className="space-y-2">
                <h3 className="neu-label">Item sold</h3>
                {item}
                {sale?.artworkId && <p className="text-[11.5px] text-[var(--neu-text-dim)]">To change the piece, delete this sale (the piece goes back on sale) and record it again.</p>}
            </section>

            <BuyerFields s={s} contacts={contactsByName} onBuyer={name => set(withBuyer(s, name, contactsByName))} onPhone={buyerPhone => set({ buyerPhone })} />
            <PaymentFields s={s} amountText={amountText} onAmount={v => { amountTouched.current = true; setAmountText(v); }} set={set} />
            <TagEditor tags={s.tags} allTags={allTags} onChange={tags => set({ tags })} carried={carried} />

            <Field label="Notes (optional)" htmlFor="sale-notes">
                <Textarea id="sale-notes" rows={2} value={s.notes} onChange={e => set({ notes: e.target.value })} maxLength={1000} />
            </Field>

            {tried && errors.length > 0 && <Msg kind="error">{errors[0]}</Msg>}
            {sale && <RecordedNote sale={sale} />}

            <TypeDeleteDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                title="Delete this sale?"
                itemName={`${sale?.saleNumber ?? ''} · ${sale?.itemTitle ?? ''}`}
                message={piecesBack(sale) ? 'The piece goes back to Available in the inventory. The sale is archived and its number isn’t reused.' : 'The sale is archived and its number isn’t reused.'}
                onConfirm={() => { void remove(); }}
            />
        </Drawer>
    );
};
