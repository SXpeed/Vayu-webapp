import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
    AlertTriangle, ArrowUpRight, Check, ChevronDown, CreditCard, Gauge, Loader2, Receipt, RefreshCw, Sparkles, X,
} from 'lucide-react';
import { apiCall } from '../services/apiClient';
import { billingService, type BillingInfo, type BillingPeriod, type PlanOption, type PlanPayment } from '../services/billingService';
import { SITE_ORIGIN } from '../brand';
import { useBranding } from '../useBranding';
import { DetailRow, PaymentAttemptCard, dateTime, formatRupees, sortPayments } from './PaymentAttempts';

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
    subscription?: {
        status: string; trialEndsAt: number | null; currentPeriodEnd: number | null; paymentWaived: boolean;
        graceEndsAt?: number | null;
    };
    active?: boolean;
    usage: UsageRow[];
    modules?: string[];
    features?: string[];
    historyDays?: number | null;
    monthStartedAt?: number;
}

/** From here a limit is "nearly full". */
const NEAR = 0.8;
/** Renewing is offered this long before a paid period ends. */
const RENEW_AHEAD_MS = 14 * 86_400_000;

const fmtNumber = (n: number, unit?: 'MB') => {
    if (unit === 'MB') return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
    return n.toLocaleString('en-IN');
};
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function share(row: UsageRow): number | null {
    if (row.used === null || row.limit === null) return null;
    if (row.limit === 0) return row.used > 0 ? 1 : 0;
    return row.used / row.limit;
}

/** The plan's state in words, and whether it needs attention. */
const statusText = (info: PlanInfo): { text: string; tone: 'ok' | 'warn' | 'bad' } => {
    const s = info.subscription;
    if (!s || s.status === 'none') return { text: 'No plan chosen yet', tone: 'warn' };
    if (s.status === 'trial_expired') return { text: 'Trial ended', tone: 'bad' };
    if (s.status === 'payment_required') return { text: 'Waiting for payment', tone: 'bad' };
    if (s.status === 'past_due') return { text: 'Renewal overdue', tone: 'bad' };
    if (s.status === 'trialing' && s.trialEndsAt) {
        const days = Math.max(0, Math.ceil((s.trialEndsAt - Date.now()) / 86_400_000));
        return { text: `Trial · ${days} day${days === 1 ? '' : 's'} left`, tone: days <= 7 ? 'warn' : 'ok' };
    }
    if (s.status === 'active' && s.currentPeriodEnd && s.currentPeriodEnd < Date.now()) return { text: 'Renewal due', tone: 'bad' };
    if (s.status === 'active') return { text: 'Active', tone: 'ok' };
    return { text: s.status.replaceAll('_', ' '), tone: info.active ? 'ok' : 'bad' };
};

const TONE_TEXT = { ok: 'text-green-700 dark:text-green-400', warn: 'text-amber-700 dark:text-amber-400', bad: 'text-red-600 dark:text-red-400' };

const barColour = (p: number) => {
    if (p >= 1) return 'bg-red-500';
    if (p >= NEAR) return 'bg-amber-500';
    return 'bg-gradient-to-r from-gold-400 to-gold-600';
};

/** A plan payment's state in words. */
const PAYMENT_STATE: Record<PlanPayment['status'], { label: string; tone: string }> = {
    paid: { label: 'Paid', tone: 'text-green-700 dark:text-green-400' },
    attempted: { label: 'Payment failed', tone: 'text-red-600 dark:text-red-400' },
    created: { label: 'Not completed', tone: 'text-amber-700 dark:text-amber-400' },
};

const periodWord = (p: BillingPeriod) => (p === 'annual' ? 'year' : 'month');

/**
 * Admin → Plan: the organization's plan, how much of each limit it uses, and
 * changing or renewing it with a payment through Razorpay. Also the whole
 * screen of a workspace whose plan has lapsed (onActive: it's open again).
 */
export const PlanPanel: React.FC<{ onActive?: () => void }> = ({ onActive }) => {
    const [info, setInfo] = useState<PlanInfo | null>(null);
    const [billing, setBilling] = useState<BillingInfo | null>(null);
    /** Why paying isn't offered here: not an owner/admin, or no plans on this workspace. */
    const [billingNote, setBillingNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [choosing, setChoosing] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [plan, bill] = await Promise.all([
                apiCall<PlanInfo>('/plan'),
                billingService.get().then(b => ({ ok: true as const, b }), (e: Error & { status?: number }) => ({ ok: false as const, e })),
            ]);
            setInfo(plan);
            if (bill.ok) { setBilling(bill.b); setBillingNote(null); }
            else { setBilling(null); setBillingNote(bill.e.status === 403 ? bill.e.message : null); }
            setError(null);
            return plan;
        } catch (e) {
            setError((e as Error).message || 'Could not load the plan');
            return null;
        } finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);

    /** After a payment: fresh figures, and tell a lapsed workspace it's open. */
    const afterPayment = useCallback(async () => {
        setChoosing(false);
        const plan = await load();
        if (plan?.active) onActive?.();
    }, [load, onActive]);

    if (error) return <p className="text-sm text-red-600 dark:text-red-400 px-1">{error}</p>;
    if (!info) return <p className="text-sm text-[var(--neu-text-dim)] px-1">Loading your plan…</p>;
    if (!info.plan && !info.subscription) {
        return <p className="text-sm text-[var(--neu-text-dim)] px-1">This workspace isn't on a plan.</p>;
    }

    const status = statusText(info);
    const near = info.usage.filter(r => (share(r) ?? 0) >= NEAR);
    const currentOption = billing?.plans.find(p => p.current);
    const { renewable } = renewalState(info.subscription, currentOption);

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
                <PlanFacts info={info} currentOption={currentOption} />

                <div className="mt-4 flex flex-wrap items-center gap-2">
                    {billing && billing.plans.length > 0 ? (
                        <>
                            {renewable && currentOption && (
                                <RenewButton option={currentOption} payable={billing.payable} onDone={afterPayment} />
                            )}
                            <button
                                type="button"
                                onClick={() => setChoosing(c => !c)}
                                aria-expanded={choosing}
                                className={`neu-button ${renewable ? '' : 'neu-button-primary'} inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold`}
                            >
                                <Sparkles size={13} /> {info.plan ? 'Upgrade or change plan' : 'Choose a plan'}
                                <ChevronDown size={13} className={`transition-transform ${choosing ? 'rotate-180' : ''}`} />
                            </button>
                        </>
                    ) : <SeeLargerPlans note={billingNote} />}
                </div>
            </section>

            {choosing && billing && (
                <PlanChooser billing={billing} usage={info.usage} onClose={() => setChoosing(false)} onPaid={afterPayment} />
            )}

            {near.length > 0 && (
                <div className="flex items-start gap-2.5 rounded-2xl neu-inset p-3.5 text-[12px] text-amber-800 dark:text-amber-300">
                    <AlertTriangle size={15} className="shrink-0 mt-px" />
                    <p>
                        <span className="font-semibold">Nearly full:</span>{' '}
                        {near.map(r => `${r.label} (${Math.round((share(r) ?? 0) * 100)}%)`).join(', ')}. Move to a larger plan before you run out.
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

            {billing && billing.payments.length > 0 && (
                <PaymentHistory payments={billing.payments} onChanged={afterPayment} />
            )}
        </div>
    );
};

/** Whether the plan needs paying for, can be renewed now, or ran out and is in its grace days. */
function renewalState(sub: PlanInfo['subscription'], current: PlanOption | undefined) {
    const now = Date.now();
    const end = sub?.currentPeriodEnd ?? null;
    const needsPayment = !!sub && ['payment_required', 'past_due', 'trial_expired'].includes(sub.status);
    const dueSoon = end !== null && end - now < RENEW_AHEAD_MS;
    const renewable = !!current && end !== null && !sub?.paymentWaived && (dueSoon || needsPayment);
    const overdue = sub?.status === 'active' && end !== null && end < now;
    return { needsPayment, renewable, overdue };
}

/** No paying in the app here (not an owner or admin, or no plans on offer): the public price list instead. */
const SeeLargerPlans: React.FC<{ note: string | null }> = ({ note }) => (
    <>
        <a
            href={`${SITE_ORIGIN}/#pricing`}
            target="_blank"
            rel="noopener noreferrer"
            className="neu-button neu-button-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
        >
            See larger plans <ArrowUpRight size={13} />
        </a>
        <span className="text-[11px] text-[var(--neu-text-dim)]">
            {note ?? 'The ateliersupport team moves you to a new plan; nothing is lost.'}
        </span>
    </>
);

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div><dt className="text-[var(--neu-text-dim)]">{label}</dt><dd className="text-[var(--neu-text)]">{children}</dd></div>
);

/** Dates and billing facts under the plan's name, and what to do if it needs paying for. */
const PlanFacts: React.FC<{ info: PlanInfo; currentOption: PlanOption | undefined }> = ({ info, currentOption }) => {
    const sub = info.subscription;
    const { needsPayment, overdue } = renewalState(sub, currentOption);
    let notice: string | null = null;
    if (overdue && sub?.currentPeriodEnd && sub.graceEndsAt) {
        notice = `Your paid period ended on ${fmtDate(sub.currentPeriodEnd)}. Renew by ${fmtDate(sub.graceEndsAt)} to keep using the workspace.`;
    } else if (overdue || needsPayment) {
        notice = 'The workspace opens again as soon as the plan is paid for.';
    }
    return (
        <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                {sub?.status === 'trialing' && !!sub.trialEndsAt && <Fact label="Trial ends">{fmtDate(sub.trialEndsAt)}</Fact>}
                {!!sub?.currentPeriodEnd && sub.status === 'active' && <Fact label="Paid until">{fmtDate(sub.currentPeriodEnd)}</Fact>}
                {info.historyDays != null && <Fact label="Activity history">{info.historyDays} days</Fact>}
                {sub?.paymentWaived && <Fact label="Billing">Payment waived</Fact>}
            </dl>
            {notice && <p className="mt-3 rounded-xl neu-inset p-3 text-[12px] text-red-700 dark:text-red-300">{notice}</p>}
        </>
    );
};

/** Pays through Razorpay and says how it went; onDone runs after anything but a closed checkout. */
function usePay(onDone: () => void) {
    const branding = useBranding();
    const [paying, setPaying] = useState<string | null>(null);
    const pay = useCallback(async (option: PlanOption, period: BillingPeriod) => {
        setPaying(`${option.key}:${period}`);
        try {
            const outcome = await billingService.pay(option.key, period, { appName: branding.appName, accent: branding.accentColor ?? undefined });
            if (outcome.kind === 'paid') {
                const end = outcome.result.payment.periodEnd;
                const until = end ? ` until ${fmtDate(end)}` : '';
                toast.success(`Paid. You're on ${option.name}${until}.`, { duration: 6000 });
                onDone();
            } else if (outcome.kind === 'pending') {
                toast("Payment received by Razorpay; confirming it. This page updates in a moment.", { duration: 6000 });
                onDone();
            } else if (outcome.kind === 'failed') {
                toast.error(outcome.message, { duration: 7000 });
                onDone();
            }
            // Closed without paying: nothing to say.
        } catch (e) {
            toast.error((e as Error).message || "Couldn't start the payment");
        } finally {
            setPaying(null);
        }
    }, [branding.appName, branding.accentColor, onDone]);
    return { pay, paying };
}

const RenewButton: React.FC<{ option: PlanOption; payable: boolean; onDone: () => void }> = ({ option, payable, onDone }) => {
    const { pay, paying } = usePay(onDone);
    const period: BillingPeriod = option.priceMonthly >= 100 ? 'monthly' : 'annual';
    const { price } = optionPrice(option, period);
    return (
        <button
            type="button"
            disabled={!payable || !!paying}
            onClick={() => void pay(option, period)}
            className="neu-button neu-button-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
        >
            {paying ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
            Renew {option.name} · {formatRupees(price)}/{periodWord(period)}
        </button>
    );
};

/** The headline limits a plan card compares. */
const COMPARE = ['maxMembers', 'maxItems', 'maxCatalogs', 'maxContacts', 'storageMb'];

const PlanChooser: React.FC<{ billing: BillingInfo; usage: UsageRow[]; onClose: () => void; onPaid: () => void }> = ({ billing, usage, onClose, onPaid }) => {
    const hasAnnual = billing.plans.some(p => p.priceAnnual >= 100);
    const hasMonthly = billing.plans.some(p => p.priceMonthly >= 100);
    const [period, setPeriod] = useState<BillingPeriod>(hasMonthly ? 'monthly' : 'annual');
    const { pay, paying } = usePay(onPaid);
    const rows = usage.filter(r => COMPARE.includes(r.key));

    return (
        <section className="neu-card p-4 lg:p-5" aria-label="Choose a plan">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="font-serif text-xl text-[var(--neu-text)]">Choose a plan</h3>
                    <p className="mt-0.5 text-[12px] text-[var(--neu-text-dim)]">
                        Pay securely with Razorpay (UPI, cards, net banking). The new plan starts as soon as the payment goes through.
                    </p>
                </div>
                <button type="button" onClick={onClose} className="neu-icon-btn-sm active-scale shrink-0" aria-label="Close" title="Close"><X size={14} /></button>
            </div>

            {billing.mode === 'test' && (
                <p className="mt-3 rounded-xl neu-inset px-3 py-2 text-[11.5px] text-blue-700 dark:text-blue-300">
                    Test mode: payments here are practice runs and no real money is taken.
                </p>
            )}
            {!billing.payable && (
                <p className="mt-3 rounded-xl neu-inset px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">{billing.reason}</p>
            )}

            {hasAnnual && hasMonthly && (
                <div className="mt-4 inline-flex rounded-full neu-inset p-1" role="group" aria-label="Billing period">
                    {(['monthly', 'annual'] as const).map(p => (
                        <button
                            key={p}
                            type="button"
                            onClick={() => setPeriod(p)}
                            aria-pressed={period === p}
                            className={`px-4 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${period === p ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}
                        >
                            {p === 'monthly' ? 'Monthly' : 'Yearly'}
                        </button>
                    ))}
                </div>
            )}

            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
                {billing.plans.map(option => (
                    <PlanOptionCard key={option.key} option={option} period={period} rows={rows} payable={billing.payable}
                        paying={paying} onPay={() => void pay(option, period)} />
                ))}
            </ul>
            <p className="mt-3 text-[11px] text-[var(--neu-text-dim)]">
                A payment covers one {period === 'annual' ? 'year' : 'month'}; nothing renews by itself. Renewing the same plan adds the time on to the end of what you have. Changing plan starts the new one straight away.
            </p>
        </section>
    );
};

const offerEnds = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** What the plan costs for the chosen period: the list price, and the offer price if one runs. */
function optionPrice(option: PlanOption, period: BillingPeriod) {
    const list = period === 'annual' ? option.priceAnnual : option.priceMonthly;
    let price = list;
    if (option.offer) price = period === 'annual' ? option.offer.priceAnnual : option.offer.priceMonthly;
    return { list, price, available: list >= 100, discounted: price < list };
}

/** One plan in the chooser: price (with any offer), headline limits, and the pay button. */
const PlanOptionCard: React.FC<{
    option: PlanOption; period: BillingPeriod; rows: UsageRow[]; payable: boolean; paying: string | null; onPay: () => void;
}> = ({ option, period, rows, payable, paying, onPay }) => {
    const { list, price, available, discounted } = optionPrice(option, period);
    const monthlyEquivalent = period === 'annual' && available ? Math.round(price / 12) : null;
    const saving = period === 'annual' && available && option.priceMonthly >= 100
        ? Math.round((1 - list / (option.priceMonthly * 12)) * 100) : 0;
    // Nothing is deleted on a smaller plan, but adding more is blocked.
    const over = rows.filter(r => {
        const limit = option.highlights.limits[r.key] ?? null;
        return r.used !== null && limit !== null && r.used > limit;
    });
    const busy = paying === `${option.key}:${period}`;
    const offerName = option.offer?.label ? ` · ${option.offer.label}` : '';
    const savingNote = saving > 0 ? ` · save ${saving}%` : '';
    const payLabel = available ? ` ${formatRupees(price)}` : '';
    return (
        <li className={`rounded-2xl p-4 flex flex-col ${option.current ? 'neu-inset' : 'neu-raised-sm'}`}>
            <div className="flex items-baseline justify-between gap-2">
                <h4 className="font-serif text-lg text-[var(--neu-text)] min-w-0 truncate">{option.name}</h4>
                {option.current && <span className="neu-badge text-[10px] shrink-0">Current</span>}
            </div>
            {option.description && <p className="mt-0.5 text-[12px] text-[var(--neu-text-dim)]">{option.description}</p>}
            {option.offer && available && (
                <p className="mt-2 text-[11px] font-semibold text-green-700 dark:text-green-400">
                    {option.offer.percentOff}% off{offerName} · ends {offerEnds(option.offer.endsAt)}
                </p>
            )}
            <p className="mt-2">
                {available ? (
                    <>
                        {discounted && <span className="mr-1.5 text-[13px] line-through text-[var(--neu-text-dim)]">{formatRupees(list)}</span>}
                        <span className="font-serif text-2xl text-[var(--neu-text)]">{formatRupees(price)}</span>
                        <span className="text-[12px] text-[var(--neu-text-dim)]"> / {periodWord(period)}</span>
                    </>
                ) : (
                    <span className="text-[12px] text-[var(--neu-text-dim)]">Not offered {period === 'annual' ? 'yearly' : 'monthly'}</span>
                )}
            </p>
            {monthlyEquivalent !== null && (
                <p className="text-[11px] text-[var(--neu-text-dim)]">{formatRupees(monthlyEquivalent)} a month{savingNote}</p>
            )}
            <ul className="mt-3 space-y-1 text-[12px] text-[var(--neu-text)]">
                {rows.map(r => {
                    const limit = option.highlights.limits[r.key] ?? null;
                    return (
                        <li key={r.key} className="flex justify-between gap-2">
                            <span className="text-[var(--neu-text-dim)] min-w-0 truncate">{r.label}</span>
                            <span className="tabular-nums shrink-0">{limit === null ? 'Unlimited' : fmtNumber(limit, r.unit)}</span>
                        </li>
                    );
                })}
            </ul>
            {over.length > 0 && (
                <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
                    You already use more {over.map(r => r.label.toLowerCase()).join(', ')} than this plan allows. Nothing is deleted, but adding more is blocked.
                </p>
            )}
            <div className="mt-auto pt-4">
                <button
                    type="button"
                    disabled={!available || !payable || !!paying}
                    onClick={onPay}
                    className={`neu-button ${option.current ? '' : 'neu-button-primary'} w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold`}
                >
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <CreditCard size={13} />}
                    {option.current ? 'Renew' : 'Pay'}{payLabel}
                </button>
            </div>
        </li>
    );
};

/** Plan payments made from this workspace, each with Razorpay's full record. */
const PaymentHistory: React.FC<{ payments: PlanPayment[]; onChanged: () => void }> = ({ payments, onChanged }) => {
    const [open, setOpen] = useState<string | null>(null);
    return (
        <section className="neu-card p-4 lg:p-5">
            <div className="flex items-center gap-2 mb-3">
                <Receipt size={15} className="text-gold-700 dark:text-gold-300" />
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text)]">Plan payments</h3>
            </div>
            <ul className="space-y-2">
                {payments.map(p => (
                    <PlanPaymentRow key={p.id} payment={p} open={open === p.id} onToggle={() => setOpen(o => (o === p.id ? null : p.id))} onChanged={onChanged} />
                ))}
            </ul>
        </section>
    );
};

/** "20% off (Diwali offer) · list price ₹2,500" for a payment made with an offer. */
function offerLine(p: PlanPayment): string | undefined {
    if (!p.discountPercent) return undefined;
    const name = p.offerLabel ? ` (${p.offerLabel})` : '';
    const list = p.listAmount ? ` · list price ${formatRupees(p.listAmount)}` : '';
    return `${p.discountPercent}% off${name}${list}`;
}

export const PlanPaymentRow: React.FC<{
    payment: PlanPayment; open: boolean; onToggle: () => void; onChanged: () => void;
    /** The control centre adds the organization and can recheck any payment. */
    extra?: React.ReactNode; recheck?: (id: string) => Promise<{ payment: PlanPayment; checked: boolean; applied: boolean; reason: string | null }>;
}> = ({ payment, open, onToggle, onChanged, extra, recheck = billingService.recheck }) => {
    const [p, setP] = useState(payment);
    const [checking, setChecking] = useState(false);
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => setP(payment), [payment]);
    const state = PAYMENT_STATE[p.status];
    let checkNote = note ?? (p.checkedAt ? `Last checked ${dateTime(p.checkedAt)}` : '');
    if (checking) checkNote = 'Checking with Razorpay…';

    const doRecheck = async () => {
        setChecking(true);
        try {
            const res = await recheck(p.id);
            setP(res.payment);
            setNote(res.checked ? `Checked with Razorpay at ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : res.reason);
            if (!res.checked) toast.error(res.reason ?? "Couldn't reach Razorpay");
            else if (res.applied) { toast.success(`Payment confirmed. ${res.payment.planName} is active.`); onChanged(); }
            else if (res.payment.status === 'paid') toast.success('Paid, confirmed by Razorpay');
            else toast(`Razorpay says: ${PAYMENT_STATE[res.payment.status].label.toLowerCase()}`);
        } catch (e) {
            toast.error((e as Error).message || "Couldn't check with Razorpay");
        } finally {
            setChecking(false);
        }
    };

    return (
        <li className="rounded-2xl neu-raised-sm">
            <button type="button" onClick={onToggle} aria-expanded={open} className="w-full text-left p-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-[var(--neu-text)] truncate">
                        {p.planName} · 1 {periodWord(p.period)}
                        {p.mode === 'test' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-300">Test</span>}
                    </p>
                    <p className="text-[11px] text-[var(--neu-text-dim)] truncate">
                        {extra}{fmtDate(p.paidAt ?? p.createdAt)}{p.createdByName ? ` · ${p.createdByName}` : ''}
                    </p>
                </div>
                <div className="text-right shrink-0">
                    <p className="font-serif text-base text-[var(--neu-text)]">{formatRupees(p.amount)}</p>
                    <p className={`text-[10px] font-semibold uppercase tracking-wider ${state.tone}`}>{state.label}</p>
                </div>
                <ChevronDown size={14} className={`shrink-0 text-[var(--neu-text-dim)] transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] text-[var(--neu-text-dim)] min-w-0">
                            {checkNote}
                        </p>
                        <button type="button" onClick={() => void doRecheck()} disabled={checking} className="neu-button inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] uppercase tracking-wider shrink-0">
                            {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Recheck
                        </button>
                    </div>
                    {p.payments.length === 0 && !checking && (
                        <p className="text-[12px] text-[var(--neu-text-dim)]">No payment was made on this checkout.</p>
                    )}
                    {sortPayments(p.payments).map(x => <PaymentAttemptCard key={x.id} payment={x} who="Payer" />)}
                    <dl className="px-1">
                        <DetailRow label="Plan" value={`${p.planName}, 1 ${periodWord(p.period)}`} />
                        <DetailRow label="Offer" value={offerLine(p)} />
                        <DetailRow label="Covers" value={p.periodStart && p.periodEnd ? `${fmtDate(p.periodStart)} – ${fmtDate(p.periodEnd)}` : undefined} />
                        <DetailRow label="Plan changed" value={p.appliedAt ? dateTime(p.appliedAt) : undefined} />
                        <DetailRow label="Started by" value={p.createdByName ? `${p.createdByName}, ${dateTime(p.createdAt)}` : dateTime(p.createdAt)} />
                        <DetailRow label="Razorpay order ID" value={p.orderId} copy={p.orderId} />
                        <DetailRow label="Payment ID" value={p.paymentId ?? undefined} copy={p.paymentId ?? undefined} />
                    </dl>
                </div>
            )}
        </li>
    );
};
