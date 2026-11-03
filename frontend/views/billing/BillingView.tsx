// Billing: Proforma · Tax Invoice · Challan · Notes · Reports, with the store
// switcher, the setup (⚙) button and New (+) in the header of every tab.

import React, { useMemo, useState } from 'react';
import { AlertTriangle, FileText, Plus, Receipt, Settings, Truck, FileMinus, BarChart3, Store } from 'lucide-react';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, GhostIconButton, EmptyState, Pill, Button } from '../../components/ui';
import { SearchBar } from '../../components/SearchBar';
import { BillingProvider, useBilling, type BillingHandlers } from './billingContext';
import type { Artwork, Contact } from '../../types';
import {
    balanceOf, displayStatus, docTotals, kindLabel, newDoc, setupProblems, storeOf,
    type BillingDoc, type DocKind,
} from '../../invoicing';
import { rupeesText } from '../../gstRules';
import { PERIODS, periodRange, type Period } from '../../invoicingReports';
import { StatusBadge, shortDate } from './parts';
import { DocEditor } from './DocEditor';
import { DocDetail } from './DocDetail';
import { SettingsSheet, type SettingsSection } from './SettingsSheet';
import { ReportsView } from './ReportsView';

export type Tab = 'proforma' | 'tax' | 'challan' | 'notes' | 'reports';
const TAB_KEY = 'vayu.billing.tab';

const readTab = (): Tab => {
    try {
        const t = localStorage.getItem(TAB_KEY);
        return t === 'tax' || t === 'challan' || t === 'notes' || t === 'reports' ? t : 'proforma';
    } catch { return 'proforma'; }
};

const STATUS_FILTERS: Record<Exclude<Tab, 'reports'>, string[]> = {
    proforma: ['Draft', 'Sent', 'Accepted', 'Expired', 'Converted', 'Rejected'],
    tax: ['Draft', 'Unpaid', 'Partly paid', 'Paid', 'Overdue', 'Cancelled'],
    challan: ['Draft', 'Issued', 'Delivered', 'Part returned', 'Returned', 'Invoiced', 'Cancelled'],
    notes: ['Draft', 'Issued', 'Cancelled'],
};

const TAB_LABEL: Record<Tab, string> = { proforma: 'Proforma', tax: 'Tax Invoice', challan: 'Challan', notes: 'Credit / Debit', reports: 'Reports' };
const TAB_KINDS: Record<Tab, DocKind[]> = { proforma: ['proforma'], tax: ['tax'], challan: ['challan'], notes: ['credit', 'debit'], reports: [] };
const DRAFT_LABEL: Partial<Record<DocKind, string>> = { credit: 'Credit note draft', debit: 'Debit note draft' };

const TAB_ICON: Record<Tab, React.ElementType> = { proforma: FileText, tax: Receipt, challan: Truck, notes: FileMinus, reports: BarChart3 };

/** `onCollectPayment` opens Payments to make a link against a document. */
export function BillingView({ onCollectPayment }: { readonly onCollectPayment?: () => void }) {
    const b = useBilling();
    const { settings: s, docs } = b;
    const [tab, setTab] = useState<Tab>(readTab);
    const [storeSel, setStoreSel] = useState<string>('all');
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('');
    const [period, setPeriod] = useState<Period>('all');
    const [editing, setEditing] = useState<BillingDoc | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [setup, setSetup] = useState<SettingsSection | null>(null);
    const now = Date.now();

    const chooseTab = (t: Tab) => {
        setTab(t);
        setStatus('');
        try { localStorage.setItem(TAB_KEY, t); } catch { /* private mode */ }
    };

    const multiStore = s.stores.length > 1;
    // A store picked earlier that no longer exists falls back to all stores.
    const storeId = storeSel !== 'all' && storeOf(s, storeSel) ? storeSel : 'all';
    const newDocStore = storeId === 'all' ? s.stores[0]?.id ?? '' : storeId;
    const problems = setupProblems(s);
    const range = periodRange(period, now);

    const tabLabel = (t: Tab) => (t === 'tax' ? kindLabel('tax', s.registration) : TAB_LABEL[t]);
    const kindsOf = (t: Tab): DocKind[] => TAB_KINDS[t];
    const storeName = storeId === 'all' ? 'All stores' : storeOf(s, storeId)?.name;

    /** The status shown and filtered on: tax invoices show payment state (and Overdue) once issued. */
    const listStatus = (d: BillingDoc): string => {
        if (d.kind === 'tax' && d.status === 'Issued') {
            const bal = balanceOf(d, docs, s);
            if (bal.state !== 'Paid' && d.dueDate && d.dueDate < now) return 'Overdue';
            return bal.state;
        }
        return displayStatus(d, now);
    };

    const list = useMemo(() => {
        const q = query.trim().toLowerCase();
        return docs
            .filter(d => kindsOf(tab).includes(d.kind))
            .filter(d => storeId === 'all' || d.storeId === storeId)
            .filter(d => d.date >= range[0] && d.date < range[1])
            .filter(d => !status || listStatus(d) === status)
            .filter(d => !q || [d.number, d.party.name, d.party.phone, d.party.gstin, d.party.email].some(v => v.toLowerCase().includes(q)))
            .sort((a, z) => z.date - a.date || z.createdAt - a.createdAt);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docs, tab, storeId, range[0], range[1], status, query, s]);

    const cards = useMemo(() => summaryCards(tab, list, docs, s, now), [tab, list, docs, s, now]);

    const startNew = () => setEditing(newDoc(tab === 'notes' || tab === 'reports' ? 'proforma' : tab, s, newDocStore, Date.now()));
    const open = openId ? docs.find(d => d.id === openId) ?? null : null;

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Billing"
                subtitle={multiStore ? storeName : s.tradeName || s.legalName || undefined}
                actions={<>
                    {multiStore && (
                        <label className="relative flex items-center">
                            <span className="sr-only">Store</span>
                            <Store size={14} className="absolute left-2.5 text-gray-500 pointer-events-none" />
                            <select value={storeId} onChange={e => setStoreSel(e.target.value)} className="neu-field !py-1.5 !pl-7 !pr-7 max-w-[9.5rem] text-xs">
                                <option value="all">All stores</option>
                                {s.stores.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                            </select>
                        </label>
                    )}
                    {b.canEdit && <GhostIconButton label="Billing setup" icon={<Settings size={16} className="text-brand-900 dark:text-gold-400" />} onClick={() => setSetup(problems[0]?.[0] as SettingsSection ?? 'business')} />}
                    {b.canEdit && tab !== 'reports' && tab !== 'notes' && (
                        <PrimaryIconButton label={`New ${tabLabel(tab).toLowerCase()}`} icon={<Plus size={16} />} onClick={startNew} />
                    )}
                </>}
            >
                <fieldset className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5 border-0 m-0 min-w-0">
                    <legend className="sr-only">Billing documents</legend>
                    {(['proforma', 'tax', 'challan', 'notes', 'reports'] as Tab[]).map(t => {
                        const Icon = TAB_ICON[t];
                        return (
                            <Pill key={t} active={tab === t} onClick={() => chooseTab(t)} className="shrink-0 flex items-center gap-1.5">
                                <Icon size={13} /> {tabLabel(t)}
                            </Pill>
                        );
                    })}
                </fieldset>
                {tab !== 'reports' && <SearchBar value={query} onChange={setQuery} placeholder="Search number, customer, phone, GSTIN…" />}
            </PageHeader>

            <PageBody space="md">
                {problems.length > 0 && (
                    <div className="neu-card p-4 flex items-start gap-3 border-l-4 border-gold-500 animate-fade-in-up">
                        <AlertTriangle size={18} className="text-gold-600 dark:text-gold-400 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Finish billing setup to issue tax invoices and challans</p>
                            <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-0.5">Still needed: {problems.slice(0, 4).map(p => p[1]).join(', ')}{problems.length > 4 ? '…' : ''}. Proformas work already.</p>
                        </div>
                        {b.canEdit && <Button variant="primary" onClick={() => setSetup(problems[0][0] as SettingsSection)} className="shrink-0 !py-2 !px-3 text-xs">Set up</Button>}
                    </div>
                )}

                {tab === 'reports' ? (
                    <ReportsView docs={storeId === 'all' ? docs : docs.filter(d => d.storeId === storeId)} onOpen={setOpenId} />
                ) : (
                    <>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5 items-center">
                            <select aria-label="Period" value={period} onChange={e => setPeriod(e.target.value as Period)} className="neu-field !py-1.5 !w-auto text-xs shrink-0">
                                {PERIODS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                            <Pill active={!status} onClick={() => setStatus('')} className="shrink-0">All</Pill>
                            {STATUS_FILTERS[tab].map(st => <Pill key={st} active={status === st} onClick={() => setStatus(status === st ? '' : st)} className="shrink-0">{st}</Pill>)}
                        </div>

                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                            {cards.map((c, i) => (
                                <div key={c.label} className="neu-card p-3 animate-fade-in-up" style={{ animationDelay: `${i * 50}ms` }}>
                                    <p className="text-[11px] text-gray-700 dark:text-gray-300 font-medium mb-1.5 uppercase tracking-widest">{c.label}</p>
                                    <p className="text-xl font-serif text-gray-900 dark:text-white truncate">{c.value}</p>
                                </div>
                            ))}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                            {list.map((d, i) => {
                                const Icon = TAB_ICON[tab];
                                const total = docTotals(d, s).total;
                                const st = listStatus(d);
                                const bal = d.kind === 'tax' && d.status === 'Issued' ? balanceOf(d, docs, s) : null;
                                return (
                                    <button key={d.id} type="button" onClick={() => setOpenId(d.id)}
                                        className="w-full text-left neu-raised rounded-2xl p-3 flex items-center justify-between gap-3 animate-fade-in-up active-scale"
                                        style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="neu-inset p-2.5 rounded-full text-brand-900 dark:text-gold-400 shrink-0"><Icon size={18} strokeWidth={1.5} /></div>
                                            <div className="min-w-0">
                                                <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm truncate">{d.party.name || 'No customer yet'}</h3>
                                                <p className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider mt-0.5 truncate">
                                                    {d.number || DRAFT_LABEL[d.kind] || 'Draft'} • {shortDate(d.date)}
                                                    {multiStore && storeId === 'all' && storeOf(s, d.storeId) ? ` • ${storeOf(s, d.storeId)!.name}` : ''}
                                                </p>
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">{rupeesText(total)}</p>
                                            {bal && bal.due > 0 && bal.paid > 0 && <p className="text-[10px] text-gray-600 dark:text-gray-400">Due {rupeesText(bal.due)}</p>}
                                            <span className="mt-1 inline-block"><StatusBadge text={st} /></span>
                                        </div>
                                    </button>
                                );
                            })}
                            {list.length === 0 && (
                                <EmptyState icon={<FileText size={20} />} title={`No ${tabLabel(tab).toLowerCase()} documents here`}
                                    message={tab === 'notes' ? 'Credit and debit notes are made from an issued tax invoice: open it and choose Credit note or Debit note.' : 'Create one with the + button above, or change the filters.'} />
                            )}
                        </div>
                    </>
                )}
            </PageBody>

            {open && !editing && (
                <DocDetail doc={open} onClose={() => setOpenId(null)} onEdit={setEditing} onOpen={setOpenId} onSetup={sec => setSetup(sec)} onCollectPayment={onCollectPayment} />
            )}
            {editing && (
                <DocEditor initial={editing} onClose={() => setEditing(null)} onSaved={d => { setEditing(null); setOpenId(d.id); chooseTab(d.kind === 'credit' || d.kind === 'debit' ? 'notes' : d.kind); }} onSetup={sec => setSetup(sec)} />
            )}
            {setup && <SettingsSheet initialSection={setup} onClose={() => setSetup(null)} />}
        </PageRoot>
    );
}

function summaryCards(tab: Tab, list: BillingDoc[], all: BillingDoc[], s: ReturnType<typeof useBilling>['settings'], now: number): { label: string; value: string }[] {
    const sum = (docs: BillingDoc[]) => docs.reduce((t, d) => t + docTotals(d, s).total, 0);
    if (tab === 'proforma') {
        const open = list.filter(d => ['Draft', 'Sent', 'Accepted'].includes(displayStatus(d, now)));
        return [
            { label: 'Open quotes', value: rupeesText(sum(open)) },
            { label: 'Converted', value: String(list.filter(d => d.status === 'Converted').length) },
            { label: 'Proformas', value: String(list.length) },
        ];
    }
    if (tab === 'tax') {
        const live = list.filter(d => d.status === 'Issued');
        const bal = live.map(d => balanceOf(d, all, s));
        return [
            { label: 'Invoiced', value: rupeesText(sum(live)) },
            { label: 'GST', value: rupeesText(live.reduce((t, d) => t + docTotals(d, s).tax, 0)) },
            { label: 'Received', value: rupeesText(bal.reduce((t, x) => t + x.paid, 0)) },
            { label: 'Balance due', value: rupeesText(bal.reduce((t, x) => t + Math.max(0, x.due), 0)) },
        ];
    }
    if (tab === 'challan') {
        const out = list.filter(d => d.status === 'Issued' || d.status === 'Delivered');
        return [
            { label: 'Goods out', value: String(out.length) },
            { label: 'Overdue returns', value: String(out.filter(d => d.returnBy && d.returnBy < now).length) },
            { label: 'Value out', value: rupeesText(sum(out)) },
            { label: 'Challans', value: String(list.length) },
        ];
    }
    const issued = list.filter(d => d.status === 'Issued');
    return [
        { label: 'Credit notes', value: rupeesText(sum(issued.filter(d => d.kind === 'credit'))) },
        { label: 'Debit notes', value: rupeesText(sum(issued.filter(d => d.kind === 'debit'))) },
    ];
}

/** Billing with its data and actions: what App renders for the Billing screen. */
export function BillingScreen({ docs, artworks, contacts, handlers, onArtworkClick, onCollectPayment }: {
    readonly docs: BillingDoc[];
    readonly artworks: Artwork[];
    readonly contacts: readonly Contact[];
    readonly handlers: BillingHandlers;
    readonly onArtworkClick?: (artwork: Artwork) => void;
    readonly onCollectPayment?: () => void;
}) {
    return (
        <BillingProvider docs={docs} artworks={artworks} contacts={contacts} handlers={handlers} onArtworkClick={onArtworkClick}>
            <BillingView onCollectPayment={onCollectPayment} />
        </BillingProvider>
    );
}
