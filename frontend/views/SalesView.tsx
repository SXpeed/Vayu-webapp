import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, CloudOff, HandCoins, Image as ImageIcon, IndianRupee, Loader2, PackageX, Plus, ReceiptText, RotateCcw, Trash2 } from 'lucide-react';
import { ArtworkPicker } from '../components/ArtworkPicker';
import { SearchBar } from '../components/SearchBar';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { Button, EmptyState, Field, Input, PageBody, PageHeader, PageRoot, Pill, PrimaryIconButton, Select, Textarea } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { realtimeService } from '../services/realtimeService';
import { salesService, type PendingSale, type SalesData } from '../services/salesService';
import { getThumbUrl } from '../services/storageService';
import {
    PAYMENT_MODES, monthRange, saleFieldErrors, shiftMonth, todayIso,
    type PaymentMode, type Sale, type SaleInput,
} from '../salesRules';
import type { Artwork, Contact } from '../types';
import { Drawer, Msg } from './staffRoster/Panels';
import { ModeBreakdown, itemsText, rupees, saleDayLabel as dayLabel } from '../components/SalesSummary';

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
    const [month, setMonth] = useState(() => monthRange(todayIso())[0]);
    const [data, setData] = useState<SalesData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'all' | PaymentMode>('all');
    const [query, setQuery] = useState('');
    const [editor, setEditor] = useState<Editor>(null);

    const [from, to] = monthRange(month);
    const loadedAt = useRef(0);
    const showing = useRef(from);
    showing.current = from;
    const load = useCallback(async () => {
        try {
            const next = await salesService.load(from, to);
            // A slow answer for a month already left behind mustn't replace the one on screen.
            if (showing.current !== from) return;
            setData(next);
            setError(null);
            loadedAt.current = Date.now();
        } catch (e) {
            if (showing.current !== from) return;
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
    const shown = useMemo(() => (data?.sales ?? []).filter(s =>
        (mode === 'all' || s.paymentMode === mode)
        && (!q || [s.buyerName, s.buyerPhone, s.itemTitle, s.saleNumber, s.referenceNo].some(v => v.toLowerCase().includes(q))),
    ), [data, mode, q]);

    const thisMonth = monthRange(todayIso())[0];
    const summary = data?.summary;
    const pendingCount = data?.pending.length ?? 0;
    let subtitle = summary ? `${itemsText(summary.count)} · ${rupees(summary.totalAmount)}` : 'Store sales, month by month';
    if (pendingCount) subtitle += ` · ${pendingCount} waiting to upload`;

    const discard = (p: PendingSale) => {
        salesService.discardPending(p.id);
        toast.success('Removed from this device');
        void load();
    };
    const retry = async (p: PendingSale) => {
        await salesService.retryPending(p.id).catch(() => undefined);
        void load();
    };

    let body: React.ReactNode;
    if (error && !data) {
        body = <EmptyState icon={<HandCoins size={22} strokeWidth={1.5} />} title="The sales didn’t load" message={error} action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (!data) {
        body = <div className="py-20 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    } else if (!data.sales.length && !data.pending.length) {
        body = (
            <EmptyState
                icon={<HandCoins size={22} strokeWidth={1.5} />}
                title={`No sales in ${monthLabel(month)}`}
                message={canRecord ? 'Record a sale with the + button above.' : 'Sales recorded by the accounts team show here.'}
            />
        );
    } else if (!shown.length && !data.pending.length) {
        body = <EmptyState icon={<HandCoins size={22} strokeWidth={1.5} />} title="No sales match" message="Try another payment mode or search." />;
    } else {
        body = (
            <>
                {data.pending.length > 0 && (
                    <section className="neu-card p-3.5 space-y-2.5" aria-label="Waiting to upload">
                        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-[var(--neu-text-dim)]"><CloudOff size={13} /> Waiting to upload</h2>
                        {data.pending.map(p => (
                            <div key={p.id} className="flex flex-wrap items-center gap-3 text-[13px]">
                                <ItemThumb sale={{ artworkId: p.input.artworkId, inInventory: true, imageUrl: artworks.find(a => a.id === p.input.artworkId)?.imageUrls[0] ?? null }} size="w-9 h-9" />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-medium">{p.input.itemTitle || artworks.find(a => a.id === p.input.artworkId)?.title || 'Inventory piece'}</span>
                                    <span className="block text-[11.5px] text-[var(--neu-text-dim)]">{dayLabel(p.input.saleDate)} · {p.input.buyerName} · {p.input.paymentMode} · {rupees(p.input.amount)}</span>
                                    {p.error && <span className="block text-[11.5px] sr-bad-text">Not saved: {p.error}</span>}
                                </span>
                                {p.error && canRecord && <Button onClick={() => { void retry(p); }} icon={<RotateCcw size={13} />}>Try again</Button>}
                                {canRecord && <Button variant="danger" onClick={() => discard(p)} icon={<Trash2 size={13} />}>Discard</Button>}
                            </div>
                        ))}
                        <p className="text-[11.5px] text-[var(--neu-text-dim)]">These get their sale numbers when they reach the server. They aren’t in the totals yet.</p>
                    </section>
                )}
                {shown.length > 0 && (isPhone ? (
                    <ul className="space-y-2.5">
                        {shown.map(s => (
                            <li key={s.id}>
                                <button type="button" disabled={!canRecord} onClick={() => setEditor({ sale: s })}
                                    className="neu-card w-full p-3 flex items-center gap-3 text-left active-scale disabled:cursor-default">
                                    <ItemThumb sale={s} />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium text-[14px] text-[var(--neu-text)]">{s.itemTitle}</span>
                                        <ItemNote sale={s} />
                                        <span className="block text-[11.5px] text-[var(--neu-text-dim)] truncate">{dayLabel(s.saleDate)} · {s.buyerName}</span>
                                    </span>
                                    <span className="text-right shrink-0">
                                        <span className="block font-semibold tabular-nums text-[var(--neu-gold)]">{rupees(s.amount)}</span>
                                        <span className="block text-[11px] text-[var(--neu-text-dim)]">{s.paymentMode}</span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
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
                                {shown.map(s => (
                                    <tr key={s.id} onClick={canRecord ? () => setEditor({ sale: s }) : undefined}
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
                                                        ? <button type="button" onClick={(e) => { e.stopPropagation(); setEditor({ sale: s }); }} className="block truncate max-w-[16rem] font-medium text-left hover:underline">{s.itemTitle}</button>
                                                        : <span className="block truncate max-w-[16rem] font-medium">{s.itemTitle}</span>}
                                                    <ItemNote sale={s} />
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
                ))}
            </>
        );
    }

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Sales"
                subtitle={subtitle}
                actions={canRecord ? <PrimaryIconButton onClick={() => setEditor({ sale: null })} label="Record sale" icon={<Plus size={16} />} /> : undefined}
            >
                <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Previous month" className="neu-icon-btn-sm active-scale"><ChevronLeft size={15} /></button>
                    <span className="flex-1 sm:flex-none sm:min-w-[10.5rem] text-center text-[13px] font-semibold" aria-live="polite">{monthLabel(month)}</span>
                    <button type="button" onClick={() => setMonth(m => shiftMonth(m, 1))} disabled={month >= thisMonth} aria-label="Next month" className="neu-icon-btn-sm active-scale disabled:opacity-40"><ChevronRight size={15} /></button>
                    {month !== thisMonth && <button type="button" onClick={() => setMonth(thisMonth)} className="neu-pill shrink-0">This month</button>}
                </div>
                <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor="sales-mode">Payment mode</label>
                    <Select id="sales-mode" value={mode} onChange={e => setMode(e.target.value as 'all' | PaymentMode)} className="!w-auto !rounded-full !py-2 shrink-0">
                        <option value="all">All modes</option>
                        {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                    </Select>
                    <SearchBar value={query} onChange={setQuery} placeholder="Search buyer, item or reference" className="flex-1 min-w-0" />
                </div>
            </PageHeader>

            <PageBody space="lg">
                {data?.offline && (
                    <Msg kind="warn">
                        You’re offline. {data.savedAt ? `Showing the copy saved on this device at ${new Date(data.savedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.` : 'Nothing for this month is saved on this device yet.'}
                        {canRecord ? ' Sales you record now upload when you’re back online.' : ''}
                    </Msg>
                )}

                {summary && (data?.sales.length ?? 0) > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 lg:gap-4">
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
                            <ModeBreakdown summary={summary} />
                        </div>
                    </div>
                )}

                {body}
            </PageBody>

            {editor && (
                <SaleEditor
                    key={editor.sale?.id ?? 'new'}
                    sale={editor.sale}
                    artworks={artworks}
                    contacts={contacts}
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
});

const EMPTY: SaleInput = {
    artworkId: null, itemTitle: '', itemPrice: 0, contactId: null, buyerName: '', buyerPhone: '',
    saleDate: '', amount: 0, paymentMode: 'Cash', referenceNo: '', notes: '',
};

/** Numbers typed into a field: '' while empty, so the field can be cleared. */
const numberText = (n: number): string => (n ? String(n) : '');

/** Record a sale, or change one. Recording needs "Record"; the server checks again. */
const SaleEditor: React.FC<{
    sale: Sale | null;
    artworks: Artwork[];
    contacts: Contact[];
    /** Pieces in sales still waiting to upload: not offered again. */
    reserved: ReadonlySet<string>;
    onClose: () => void;
    onSaved: () => void;
}> = ({ sale, artworks, contacts, reserved, onClose, onSaved }) => {
    const isNew = !sale;
    const [s, setS] = useState<SaleInput>(() => (sale ? inputOf(sale) : { ...EMPTY, saleDate: todayIso() }));
    const [amountText, setAmountText] = useState(numberText(sale?.amount ?? 0));
    const [priceText, setPriceText] = useState(numberText(sale && !sale.artworkId ? sale.itemPrice : 0));
    const available = useMemo(() => artworks.filter(a => a.status === 'Available' && !reserved.has(a.id)), [artworks, reserved]);
    const [freeText, setFreeText] = useState(() => (sale ? !sale.artworkId : available.length === 0));
    const [tried, setTried] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const amountTouched = useRef(!!sale);

    const set = (patch: Partial<SaleInput>) => setS(prev => ({ ...prev, ...patch }));
    const picked = s.artworkId ? artworks.find(a => a.id === s.artworkId) ?? null : null;

    const pick = (id: string) => {
        if (s.artworkId === id) { set({ artworkId: null }); return; }
        const art = artworks.find(a => a.id === id);
        set({ artworkId: id, itemTitle: '', itemPrice: art?.price ?? 0 });
        if (art && !amountTouched.current) setAmountText(numberText(art.price));
    };

    const contactNames = useMemo(() => {
        const seen = new Map<string, Contact>();
        for (const c of contacts) if (c.name && !seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c);
        return seen;
    }, [contacts]);
    const setBuyer = (name: string) => {
        const contact = contactNames.get(name.trim().toLowerCase());
        if (contact) set({ buyerName: name, contactId: contact.id, buyerPhone: s.buyerPhone || contact.phone || '' });
        else set({ buyerName: name, contactId: null });
    };

    const input: SaleInput = {
        ...s,
        artworkId: freeText ? null : s.artworkId,
        itemTitle: freeText ? s.itemTitle : '',
        itemPrice: freeText ? (Number(priceText) || 0) : s.itemPrice,
        amount: amountText.trim() ? Number(amountText) : 0,
    };
    const errors = saleFieldErrors(input);

    const save = async () => {
        setTried(true);
        if (errors.length || busy) return;
        setBusy(true);
        try {
            if (sale) {
                await salesService.update(sale.id, input);
                toast.success('Sale saved');
            } else {
                const result = await salesService.record(input);
                if ('pending' in result) toast.success('Saved on this device. It uploads, and gets its number, when you’re back online.', { duration: 5000 });
                else toast.success(`Sale ${result.sale.saleNumber} recorded`);
            }
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
            toast.success(sale.artworkId && sale.inInventory ? 'Sale deleted. The piece is available again.' : 'Sale deleted');
            onSaved();
        } catch (e) {
            toast.error((e as Error).message || 'Could not delete the sale');
            setBusy(false);
        }
    };

    let item: React.ReactNode;
    if (sale?.artworkId) {
        item = (
            <div className="neu-inset rounded-2xl p-3 flex items-center gap-3">
                <ItemThumb sale={sale} />
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[14px]">{sale.itemTitle}</span>
                    <ItemNote sale={sale} />
                    <span className="block text-[11.5px] text-[var(--neu-text-dim)]">Listed at {rupees(sale.itemPrice)}</span>
                </span>
            </div>
        );
    } else if (freeText) {
        item = (
            <div className="space-y-3">
                <Field label="What was sold" htmlFor="sale-item">
                    <Input id="sale-item" value={s.itemTitle} onChange={e => set({ itemTitle: e.target.value })} placeholder="e.g. Framed print, gift card" maxLength={200} data-autofocus />
                </Field>
                <Field label="Its price (optional)" htmlFor="sale-item-price">
                    <Input id="sale-item-price" type="number" inputMode="decimal" min={0} step="0.01" value={priceText} onChange={e => setPriceText(e.target.value)} />
                </Field>
                {isNew && available.length > 0 && (
                    <button type="button" onClick={() => setFreeText(false)} className="text-[12px] font-semibold text-gold-700 dark:text-gold-300 underline underline-offset-2">Choose from the inventory instead</button>
                )}
            </div>
        );
    } else {
        item = (
            <div className="space-y-2">
                {picked && <p className="text-[12.5px]">Selected: <strong className="font-medium">{picked.title}</strong> · listed at {rupees(picked.price)}</p>}
                <ArtworkPicker
                    artworks={available}
                    selected={new Set(s.artworkId ? [s.artworkId] : [])}
                    onToggle={pick}
                    statusFilters={false}
                    scroll
                    detail={a => [a.customId, rupees(a.price)].filter(Boolean).join(' · ')}
                    searchPlaceholder="Search available pieces…"
                />
                <button type="button" onClick={() => { setFreeText(true); set({ artworkId: null }); }} className="text-[12px] font-semibold text-gold-700 dark:text-gold-300 underline underline-offset-2">Item not in the list?</button>
            </div>
        );
    }

    return (
        <Drawer
            title={isNew ? 'Record sale' : `Sale ${sale.saleNumber}`}
            onClose={onClose}
            footer={(
                <>
                    {!isNew && <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy} icon={<Trash2 size={14} />}>Delete</Button>}
                    <Button variant="primary" onClick={() => { void save(); }} disabled={busy} className="ml-auto" icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}>
                        {isNew ? 'Record sale' : 'Save'}
                    </Button>
                </>
            )}
        >
            <section aria-label="Item" className="space-y-2">
                <h3 className="neu-label">Item sold</h3>
                {item}
                {!isNew && sale?.artworkId && <p className="text-[11.5px] text-[var(--neu-text-dim)]">To change the piece, delete this sale (the piece goes back on sale) and record it again.</p>}
            </section>

            <Field label="Buyer" htmlFor="sale-buyer" hint={s.contactId ? 'From your contacts' : undefined}>
                <Input id="sale-buyer" value={s.buyerName} onChange={e => setBuyer(e.target.value)} list={contacts.length ? 'sale-contacts' : undefined} autoComplete="off" maxLength={120} />
                {contacts.length > 0 && (
                    <datalist id="sale-contacts">
                        {[...contactNames.values()].map(c => <option key={c.id} value={c.name}>{c.phone}</option>)}
                    </datalist>
                )}
            </Field>
            <Field label="Buyer’s phone (optional)" htmlFor="sale-phone">
                <Input id="sale-phone" type="tel" inputMode="tel" value={s.buyerPhone} onChange={e => set({ buyerPhone: e.target.value })} maxLength={40} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
                <Field label="Day of sale" htmlFor="sale-date">
                    <Input id="sale-date" type="date" max={todayIso()} value={s.saleDate} onChange={e => set({ saleDate: e.target.value })} />
                </Field>
                <Field label="Amount received" htmlFor="sale-amount">
                    <Input id="sale-amount" type="number" inputMode="decimal" min={0} step="0.01" value={amountText}
                        onChange={e => { amountTouched.current = true; setAmountText(e.target.value); }} />
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
            <Field label="Notes (optional)" htmlFor="sale-notes">
                <Textarea id="sale-notes" rows={2} value={s.notes} onChange={e => set({ notes: e.target.value })} maxLength={1000} />
            </Field>

            {tried && errors.length > 0 && <Msg kind="error">{errors[0]}</Msg>}
            {sale && <p className="text-[11.5px] text-[var(--neu-text-dim)]">Recorded {new Date(sale.recordedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}{sale.createdByName ? ` by ${sale.createdByName}` : ''}.</p>}

            <TypeDeleteDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                title="Delete this sale?"
                itemName={`${sale?.saleNumber ?? ''} · ${sale?.itemTitle ?? ''}`}
                message={sale?.artworkId && sale.inInventory ? 'The piece goes back to Available in the inventory. The sale is archived and its number isn’t reused.' : 'The sale is archived and its number isn’t reused.'}
                onConfirm={() => { void remove(); }}
            />
        </Drawer>
    );
};
