import React, { useCallback, useEffect, useState } from 'react';
import { realtimeService } from '../services/realtimeService';
import { salesService, type SalesData } from '../services/salesService';
import { monthRange, todayIso, type TagTotal } from '../salesRules';

// Pieces of the sales ledger shared by the Sales screen and Home. Kept out of
// views/SalesView so Home, which loads first, doesn't pull that screen in.

/** "₹4,39,500", or "₹4,39,500.50" when there are paise. */
export const rupees = (n: number): string => {
    const digits = Number.isInteger(n) ? 0 : 2;
    return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
export const itemsText = (n: number): string => `${n} item${n === 1 ? '' : 's'}`;
/** What stands in for an amount until the person chooses to see it. */
export const HIDDEN_AMOUNT = '₹ ••••';
/** An amount, or the stand-in while amounts are hidden. */
export const money = (n: number, hidden = false): string => (hidden ? HIDDEN_AMOUNT : rupees(n));
export const saleDayLabel = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

interface BreakdownRow { key: string; label: string; count: number; amount: number }

/** Rows of count and amount, each with a bar for its share of `total`. Rows can be buttons (`onPick`). */
const Breakdown: React.FC<{ rows: BreakdownRow[]; total: number; compact?: boolean; label: string; active?: string; onPick?: (key: string) => void; hidden?: boolean }> = ({ rows, total, compact = false, label, active, onPick, hidden = false }) => {
    if (!rows.length) return null;
    return (
        <ul className={compact ? 'space-y-1.5' : 'space-y-2.5'} aria-label={label}>
            {rows.map(row => {
                const share = total > 0 ? row.amount / total : 0;
                const inner = (
                    <>
                        <span className="flex items-baseline justify-between gap-2">
                            <span className={`min-w-0 truncate font-medium ${active === row.key ? 'text-[var(--neu-gold)]' : 'text-[var(--neu-text)]'}`}>{row.label} <span className="font-normal text-[var(--neu-text-dim)]">· {row.count}</span></span>
                            <span className="shrink-0 tabular-nums text-[var(--neu-text)]">{money(row.amount, hidden)}</span>
                        </span>
                        <span className="block mt-1 h-1.5 rounded-full neu-inset overflow-hidden" aria-hidden="true">
                            <span className="block h-full rounded-full bg-[var(--neu-gold)]" style={{ width: `${Math.min(Math.max(share * 100, 2), 100)}%` }} />
                        </span>
                    </>
                );
                return (
                    <li key={row.key} className="text-[12px]">
                        {onPick
                            ? <button type="button" onClick={() => onPick(row.key)} aria-pressed={active === row.key} className="block w-full text-left active-scale">{inner}</button>
                            : inner}
                    </li>
                );
            })}
        </ul>
    );
};

/**
 * Takings per tag (an event, say), with untagged sales last. Tapping a row
 * shows only those sales. A sale with two tags counts under both.
 */
export const TagBreakdown: React.FC<{ rows: TagTotal[]; total: number; active?: string; onPick?: (tag: string) => void }> = ({ rows, total, active, onPick }) => (
    <Breakdown
        rows={rows.map(r => ({ key: r.tag, label: r.tag || 'Untagged', count: r.count, amount: r.amount }))}
        total={total} label="By tag" active={active} onPick={onPick}
    />
);

/** The first day of the current month, as YYYY-MM-01. */
export const currentMonth = (): string => monthRange(todayIso())[0];

export interface MonthSales {
    data: SalesData | null;
    failed: boolean;
}

/**
 * The sales of one month (given by its first day), kept current: loaded
 * again when a sale is recorded anywhere and when the device is back online.
 */
export function useMonthSales(month: string): MonthSales {
    const [state, setState] = useState<MonthSales & { month: string | null }>({ month: null, data: null, failed: false });
    const load = useCallback(async () => {
        const [from, to] = monthRange(month);
        try {
            const data = await salesService.load(from, to);
            setState({ month, data, failed: false });
        } catch {
            setState(prev => (prev.month === month ? { ...prev, failed: true } : { month, data: null, failed: true }));
        }
    }, [month]);

    useEffect(() => {
        void load();
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'sales') && document.visibilityState === 'visible') void load();
        });
        const onOnline = () => { void load(); };
        window.addEventListener('online', onOnline);
        return () => { unsubscribe(); window.removeEventListener('online', onOnline); };
    }, [load]);

    // Another month's answer is never shown under this month's name.
    return state.month === month ? state : { data: null, failed: false };
}
