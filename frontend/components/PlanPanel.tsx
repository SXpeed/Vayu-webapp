import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Check, Gauge, RefreshCw } from 'lucide-react';
import { apiCall } from '../services/apiClient';
import { SITE_ORIGIN } from '../brand';

interface UsageRow {
    key: string;
    label: string;
    hint: string;
    used: number | null;
    limit: number | null;
    unit?: 'MB';
    period?: 'month';
    enforced: boolean;
}

interface PlanInfo {
    plan: { key: string; name: string; version: number; billingType: string } | null;
    subscription?: { status: string; trialEndsAt: number | null; currentPeriodEnd: number | null; paymentWaived: boolean };
    active?: boolean;
    usage: UsageRow[];
    modules?: string[];
    features?: string[];
    historyDays?: number | null;
    monthStartedAt?: number;
}

/** From here a limit is "nearly full". */
const NEAR = 0.8;

const fmtNumber = (n: number, unit?: 'MB') => {
    if (unit === 'MB') return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
    return n.toLocaleString('en-IN');
};
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const share = (row: UsageRow): number | null =>
    row.used === null || row.limit === null ? null : row.limit === 0 ? (row.used > 0 ? 1 : 0) : row.used / row.limit;

/** The plan's state in words, and whether it needs attention. */
const statusText = (info: PlanInfo): { text: string; tone: 'ok' | 'warn' | 'bad' } => {
    const s = info.subscription;
    if (!s || s.status === 'none') return { text: 'No plan chosen yet', tone: 'warn' };
    if (s.status === 'trial_expired') return { text: 'Trial ended', tone: 'bad' };
    if (s.status === 'trialing' && s.trialEndsAt) {
        const days = Math.max(0, Math.ceil((s.trialEndsAt - Date.now()) / 86_400_000));
        return { text: `Trial · ${days} day${days === 1 ? '' : 's'} left`, tone: days <= 7 ? 'warn' : 'ok' };
    }
    if (s.status === 'active') return { text: 'Active', tone: 'ok' };
    return { text: s.status.replaceAll('_', ' '), tone: info.active ? 'ok' : 'bad' };
};

const TONE_TEXT = { ok: 'text-green-700 dark:text-green-400', warn: 'text-amber-700 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' };

const barColour = (p: number) => {
    if (p >= 1) return 'bg-red-500';
    if (p >= NEAR) return 'bg-amber-500';
    return 'bg-gradient-to-r from-gold-400 to-gold-600';
};

/**
 * Admin → Plan: the organization's plan and how much of each limit it uses,
 * so it can ask for a larger plan before it runs out.
 */
export const PlanPanel: React.FC = () => {
    const [info, setInfo] = useState<PlanInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setInfo(await apiCall<PlanInfo>('/plan'));
            setError(null);
        } catch (e) {
            setError((e as Error).message || 'Could not load the plan');
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    if (error) return <p className="text-sm text-red-600 dark:text-red-400 px-1">{error}</p>;
    if (!info) return <p className="text-sm text-[var(--neu-text-dim)] px-1">Loading your plan…</p>;
    if (!info.plan && !info.subscription) {
        return <p className="text-sm text-[var(--neu-text-dim)] px-1">This workspace isn't on a plan.</p>;
    }

    const status = statusText(info);
    const near = info.usage.filter(r => (share(r) ?? 0) >= NEAR);
    const sub = info.subscription;

    return (
        <div className="space-y-4">
            {/* The plan */}
            <section className="neu-card p-4 lg:p-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">Your plan</p>
                        <h3 className="mt-0.5 font-serif text-2xl text-[var(--neu-text)] truncate">{info.plan?.name ?? 'Starter (no plan chosen)'}</h3>
                        <p className={`mt-1 text-xs font-semibold first-letter:uppercase ${TONE_TEXT[status.tone]}`}>{status.text}</p>
                    </div>
                    <button type="button" onClick={() => void load()} disabled={loading} className="neu-icon-btn-sm active-scale shrink-0" aria-label="Refresh usage" title="Refresh">
                        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                    {sub?.status === 'trialing' && sub.trialEndsAt && (
                        <div><dt className="text-[var(--neu-text-dim)]">Trial ends</dt><dd className="text-[var(--neu-text)]">{fmtDate(sub.trialEndsAt)}</dd></div>
                    )}
                    {sub?.currentPeriodEnd && (
                        <div><dt className="text-[var(--neu-text-dim)]">Renews</dt><dd className="text-[var(--neu-text)]">{fmtDate(sub.currentPeriodEnd)}</dd></div>
                    )}
                    {info.historyDays != null && (
                        <div><dt className="text-[var(--neu-text-dim)]">Activity history</dt><dd className="text-[var(--neu-text)]">{info.historyDays} days</dd></div>
                    )}
                    {sub?.paymentWaived && (
                        <div><dt className="text-[var(--neu-text-dim)]">Billing</dt><dd className="text-[var(--neu-text)]">Payment waived</dd></div>
                    )}
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <a
                        href={`${SITE_ORIGIN}/#pricing`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="neu-button neu-button-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
                    >
                        See larger plans <ArrowUpRight size={13} />
                    </a>
                    <span className="text-[11px] text-[var(--neu-text-dim)]">The ateliersupport team moves you to a new plan; nothing is lost.</span>
                </div>
            </section>

            {near.length > 0 && (
                <div className="flex items-start gap-2.5 rounded-2xl neu-inset p-3.5 text-[12px] text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={15} className="shrink-0 mt-px" />
                    <p>
                        <span className="font-semibold">Nearly full:</span>{' '}
                        {near.map(r => `${r.label} (${Math.round((share(r) ?? 0) * 100)}%)`).join(', ')}. Ask for a larger plan before you run out.
                    </p>
                </div>
            )}

            {/* Usage */}
            <section className="neu-card p-4 lg:p-5">
                <div className="flex items-center gap-2 mb-3">
                    <Gauge size={15} className="text-gold-700 dark:text-gold-300" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text)]">Usage</h3>
                </div>
                <ul className="space-y-3.5">
                    {info.usage.map(row => {
                        const p = share(row);
                        let figure: string;
                        if (row.used === null) figure = 'Not counted yet';
                        else if (row.limit === null) figure = `${fmtNumber(row.used, row.unit)} · Unlimited`;
                        else figure = `${fmtNumber(row.used, row.unit)} of ${fmtNumber(row.limit, row.unit)}`;
                        return (
                            <li key={row.key}>
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-[13px] text-[var(--neu-text)] min-w-0 truncate">
                                        {row.label}
                                        {row.period === 'month' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[var(--neu-text-dim)]">This month</span>}
                                    </span>
                                    <span className={`text-[12px] tabular-nums shrink-0 ${p !== null && p >= 1 ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-[var(--neu-text-dim)]'}`}>{figure}</span>
                                </div>
                                {p !== null && (
                                    <div
                                        className="mt-1.5 h-2 rounded-full bg-gray-300/50 dark:bg-white/10 overflow-hidden"
                                        role="progressbar"
                                        aria-label={row.label}
                                        aria-valuemin={0}
                                        aria-valuemax={row.limit ?? 0}
                                        aria-valuenow={row.used ?? 0}
                                    >
                                        <div className={`h-full rounded-full ${barColour(p)}`} style={{ width: `${Math.min(100, Math.max(p * 100, p > 0 ? 3 : 0))}%` }} />
                                    </div>
                                )}
                                <p className="mt-1 text-[11px] text-[var(--neu-text-dim)] font-light">
                                    {row.hint}{row.enforced && row.limit !== null ? ' New ones are blocked at the limit.' : ''}
                                </p>
                            </li>
                        );
                    })}
                </ul>
                {info.monthStartedAt && (
                    <p className="mt-4 text-[11px] text-[var(--neu-text-dim)]">
                        Monthly figures count from {fmtDate(info.monthStartedAt)}. Storage is recounted every few hours.
                    </p>
                )}
            </section>

            {/* What's included */}
            {!!(info.modules?.length || info.features?.length) && (
                <section className="neu-card p-4 lg:p-5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text)] mb-3">Included</h3>
                    <ul className="flex flex-wrap gap-2">
                        {[...(info.modules ?? []), ...(info.features ?? [])].map(name => (
                            <li key={name} className="neu-badge inline-flex items-center gap-1 text-[11px]">
                                <Check size={11} className="text-green-600 dark:text-green-400" /> {name}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
};
