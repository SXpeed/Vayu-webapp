import React, { useCallback, useEffect, useState } from 'react';
import { ChevronRight, CloudOff, HandCoins } from 'lucide-react';
import { realtimeService } from '../services/realtimeService';
import { salesService, type SalesData } from '../services/salesService';
import { monthRange, todayIso, type PaymentMode, type SalesSummary } from '../salesRules';

// Pieces of the sales ledger shared by the Sales screen and Home. Kept out of
// views/SalesView so Home, which loads first, doesn't pull that screen in.

/** "₹4,39,500", or "₹4,39,500.50" when there are paise. */
export const rupees = (n: number): string => {
    const digits = Number.isInteger(n) ? 0 : 2;
    return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
export const itemsText = (n: number): string => `${n} item${n === 1 ? '' : 's'}`;
export const saleDayLabel = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** How the takings split across payment modes, largest first. */
export const ModeBreakdown: React.FC<{ summary: SalesSummary; compact?: boolean }> = ({ summary, compact = false }) => {
    const modes = (Object.entries(summary.byMode) as [PaymentMode, { count: number; amount: number }][])
        .sort((a, b) => b[1].amount - a[1].amount);
    if (!modes.length) return null;
    return (
        <ul className={compact ? 'space-y-1.5' : 'space-y-2.5'} aria-label="By payment mode">
            {modes.map(([mode, m]) => {
                const share = summary.totalAmount > 0 ? m.amount / summary.totalAmount : 0;
                return (
                    <li key={mode} className="text-[12px]">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium text-[var(--neu-text)]">{mode} <span className="font-normal text-[var(--neu-text-dim)]">· {m.count}</span></span>
                            <span className="tabular-nums text-[var(--neu-text)]">{rupees(m.amount)}</span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full neu-inset overflow-hidden" aria-hidden="true">
                            <div className="h-full rounded-full bg-[var(--neu-gold)]" style={{ width: `${Math.max(share * 100, 2)}%` }} />
                        </div>
                    </li>
                );
            })}
        </ul>
    );
};

const LAST_FEW = 3;

/**
 * Home's "Sales this month": the count and total, the split by payment mode
 * and the last few sales. Shown to anyone with the Sales permission (Home
 * leaves it out otherwise); opens the ledger.
 */
export const SalesMonthCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
    const [data, setData] = useState<SalesData | null>(null);
    const [failed, setFailed] = useState(false);
    const load = useCallback(async () => {
        const [from, to] = monthRange(todayIso());
        try {
            setData(await salesService.load(from, to));
            setFailed(false);
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        void load();
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'sales') && document.visibilityState === 'visible') void load();
        });
        const onOnline = () => { void load(); };
        window.addEventListener('online', onOnline);
        return () => { unsubscribe(); window.removeEventListener('online', onOnline); };
    }, [load]);

    const summary = data?.summary;
    let figure: React.ReactNode = <span className="text-[var(--neu-text-dim)]">…</span>;
    if (failed && !data) figure = <span className="text-[13px] font-sans text-[var(--neu-text-dim)]">Couldn’t load</span>;
    else if (summary) figure = <>{rupees(summary.totalAmount)}<span className="ml-2 font-sans text-[12px] text-[var(--neu-text-dim)]">{itemsText(summary.count)}</span></>;

    return (
        <button type="button" onClick={onOpen} className="neu-card-interactive w-full p-3.5 text-left active-scale">
            <span className="flex items-center gap-3">
                <span className="neu-inset shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center">
                    <HandCoins size={20} strokeWidth={1.5} className="text-brand-900 dark:text-gold-400" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300">
                        {new Date().toLocaleDateString('en-IN', { month: 'long' })} so far
                    </span>
                    <span className="block text-xl font-serif tabular-nums text-gray-900 dark:text-white">{figure}</span>
                </span>
                <ChevronRight size={18} className="shrink-0 text-gold-700 dark:text-gold-300" />
            </span>
            {summary && summary.count > 0 && (
                <span className="block mt-3"><ModeBreakdown summary={summary} compact /></span>
            )}
            {data && data.sales.length > 0 && (
                <span className="block mt-3 pt-2.5 border-t border-[var(--neu-line)] space-y-1.5">
                    {data.sales.slice(0, LAST_FEW).map(s => (
                        <span key={s.id} className="flex items-baseline gap-2 text-[12px]">
                            <span className="shrink-0 w-12 text-[var(--neu-text-dim)]">{saleDayLabel(s.saleDate)}</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--neu-text)]">{s.itemTitle} <span className="text-[var(--neu-text-dim)]">· {s.buyerName}</span></span>
                            <span className="shrink-0 tabular-nums font-medium text-[var(--neu-gold)]">{rupees(s.amount)}</span>
                        </span>
                    ))}
                </span>
            )}
            {summary && summary.count === 0 && !data?.pending.length && (
                <span className="block mt-2 text-[12px] text-[var(--neu-text-dim)]">No sales recorded this month yet.</span>
            )}
            {(data?.pending.length ?? 0) > 0 && (
                <span className="mt-2 flex items-center gap-1.5 text-[11.5px] sr-open-text"><CloudOff size={12} /> {data?.pending.length} recorded offline, waiting to upload</span>
            )}
        </button>
    );
};
