import React, { useState, useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import type { Invoice, PaymentAccountInfo, PaymentLink } from '../types';
import { paymentService } from '../services/paymentService';
import { createRefreshScheduler } from '../services/refreshScheduler';
import { realtimeService } from '../services/realtimeService';
import { IndianRupee, Copy, Check, RefreshCw, Link as LinkIcon, MessageCircle, Trash2, CalendarClock, Info, Loader2 } from 'lucide-react';
import {
    PageRoot, PageHeader, PageBody, Card, SectionTitle, Field, Input, Select,
    Button, GhostIconButton, Badge, EmptyState, ToggleRow,
} from '../components/ui';
import { IfCan, useAppChrome } from '../components/Layout';
import { AccountNotice, InvoiceField, OverrideFields, TestBadge, rupeesToPaise } from './payments/NewLinkParts';
import { DetailRow, PaymentAttemptCard, dateTime, formatRupees, sortPayments } from '../components/PaymentAttempts';

const formatDate = (ts: number) => {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** Status colour lives in the ink, not a flat pill fill — the pill itself is
 *  a pressed well like every other chip in the app. */
const STATUS_STYLES: Record<string, string> = {
    paid: 'text-green-700 dark:text-green-400',
    created: 'text-gold-700 dark:text-gold-400',
    partially_paid: 'text-blue-700 dark:text-blue-400',
    expired: 'text-gray-600 dark:text-gray-400',
    cancelled: 'text-red-600 dark:text-red-400',
};

/** How long a new link stays valid. Razorpay allows up to six months. */
const VALIDITY_OPTIONS: { value: string; label: string; days?: number }[] = [
    { value: '1', label: '1 day', days: 1 },
    { value: '3', label: '3 days', days: 3 },
    { value: '7', label: '7 days', days: 7 },
    { value: '15', label: '15 days', days: 15 },
    { value: '30', label: '30 days', days: 30 },
    { value: '90', label: '3 months', days: 90 },
    { value: '180', label: '6 months (longest)', days: 180 },
    { value: 'date', label: 'Pick date & time…' },
];
const DEFAULT_VALIDITY = '7';
const DAY_MS = 86_400_000;

/** Razorpay needs the expiry at least 15 minutes away; the app asks for 30. */
const MIN_AHEAD_MS = 30 * 60_000;
const MAX_AHEAD_MS = 180 * DAY_MS;

/** yyyy-mm-ddThh:mm for a date-and-time input, in local time. */
const dateTimeInputValue = (ts: number) => {
    const d = new Date(ts);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** A date-and-time input's value as a timestamp (local time); NaN when incomplete. */
const parseDateTime = (value: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : Number.NaN;
};

/** The chosen validity as an expiry time; null when the date and time are missing or out of range. */
const expiryFor = (choice: string, dateTime: string): number | null => {
    const option = VALIDITY_OPTIONS.find(o => o.value === choice);
    if (option?.days) return Date.now() + option.days * DAY_MS;
    const at = parseDateTime(dateTime);
    const ahead = at - Date.now();
    return Number.isFinite(at) && ahead >= MIN_AHEAD_MS && ahead <= MAX_AHEAD_MS ? at : null;
};

const EXPIRY_RANGE_MESSAGE = 'Pick a date and time between 30 minutes and 6 months from now';

/** "Valid till 3 Oct, 11:59 pm" / "Expires in 5 h" / "Expired 2 Oct". */
const validityText = (link: PaymentLink): string | null => {
    if (!link.expiresAt) return null;
    const left = link.expiresAt - Date.now();
    const when = new Date(link.expiresAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    if (link.status === 'expired' || left <= 0) return `Expired ${new Date(link.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
    if (link.status !== 'created' && link.status !== 'partially_paid') return null;
    if (left < DAY_MS) return `Expires in ${Math.max(1, Math.round(left / 3_600_000))} h`;
    return `Valid till ${when}`;
};

const isOpen = (link: PaymentLink) => link.status === 'created' || link.status === 'partially_paid';

const STATUS_LABELS: Record<string, string> = {
    paid: 'Paid',
    created: 'Awaiting',
    partially_paid: 'Partial',
    expired: 'Expired',
    cancelled: 'Cancelled',
};


/** The bin button's tooltip: an open link is cancelled first, a closed one only removed. */
function binTitle(open: boolean, confirming: boolean): string {
    if (confirming) return open ? 'Tap again to cancel and delete' : 'Tap again to remove';
    return open ? 'Cancel and delete' : 'Remove from the list';
}

const binLabel = (open: boolean): string => (open ? 'Cancel and delete link' : 'Remove from the list');

const removeNote = (paid: boolean): string =>
    'Tap the bin again to remove it from the list.' + (paid ? ' The payment stays in Razorpay.' : '');

/** Errors worth trying again with the SAME request key (the first try may have worked). */
const retryable = (e: unknown): boolean => {
    const { status, code } = e as { status?: number; code?: string };
    return status === undefined || status >= 500 || code === 'request_in_progress';
};

/** A new link's amount, checked on this device first (the server checks it again). */
function linkAmount(amount: string, invoiceId: string): { amountPaise?: number; problem?: string } {
    const typed = amount.trim();
    if (!typed) return invoiceId ? {} : { problem: 'Enter the amount' };
    const paise = rupeesToPaise(typed);
    if (paise === null || paise < 100) return { problem: 'Enter a valid amount (minimum ₹1, at most two decimals)' };
    return { amountPaise: paise };
}

export const PaymentsView: React.FC<{ invoices?: Invoice[] }> = ({ invoices = [] }) => {
    const { isAdmin } = useAppChrome();
    const [account, setAccount] = useState<PaymentAccountInfo | null>(null);
    const [confirmTest, setConfirmTest] = useState(false);
    const [invoiceId, setInvoiceId] = useState('');
    const [settles, setSettles] = useState(false);
    const [overrideReason, setOverrideReason] = useState('');
    const [reasonShown, setReasonShown] = useState(false);
    /** One key per request: reused when retrying it, so a retry never makes a second link. */
    const requestKey = useRef<string | null>(null);
    const [amount, setAmount] = useState('');
    const [customerName, setCustomerName] = useState('');
    const [customerPhone, setCustomerPhone] = useState('');
    const [customerEmail, setCustomerEmail] = useState('');
    const [description, setDescription] = useState('');
    const [notifySms, setNotifySms] = useState(true);
    const [validity, setValidity] = useState(DEFAULT_VALIDITY);
    const [validUntil, setValidUntil] = useState(() => dateTimeInputValue(Date.now() + 7 * DAY_MS));
    const [isCreating, setIsCreating] = useState(false);
    const [createdLink, setCreatedLink] = useState<PaymentLink | null>(null);

    const [links, setLinks] = useState<PaymentLink[]>([]);
    const [isLoadingLinks, setIsLoadingLinks] = useState(true);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    /** Link whose delete button asked "tap again"; the question lapses. */
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    /** Link whose payment details are open. */
    const [detailsId, setDetailsId] = useState<string | null>(null);
    /** Link whose validity is being changed, and the choice so far. */
    const [editingValidity, setEditingValidity] = useState<{ id: string; choice: string; date: string } | null>(null);

    useEffect(() => {
        if (!confirmDeleteId) return;
        const timer = setTimeout(() => setConfirmDeleteId(null), 4000);
        return () => clearTimeout(timer);
    }, [confirmDeleteId]);

    const loadLinks = useCallback(async (silent = false) => {
        if (!silent) setIsLoadingLinks(true);
        try {
            setLinks(await paymentService.getPaymentLinks());
        } catch (e) {
            if (!silent) toast.error((e as Error).message || 'Could not load payment links');
            if (silent) throw e;
        } finally {
            if (!silent) setIsLoadingLinks(false);
        }
    }, []);

    // Load on mount and refresh occasionally while visible. Razorpay webhooks
    // are the source of truth; a 15-second loop needlessly multiplied Worker
    // invocations on every open Payments screen.
    useEffect(() => {
        const scheduler = createRefreshScheduler({
            run: async () => {
                try { await loadLinks(true); }
                finally { setIsLoadingLinks(false); }
            },
            // A paid webhook is pushed over the realtime socket; polling is
            // then only a safety net.
            intervalMs: () => (realtimeService.connected ? 10 * 60_000 : 60_000),
            enabled: () => document.visibilityState === 'visible' && navigator.onLine,
        });
        const refresh = () => { void scheduler.request(); };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'payments')
                && document.visibilityState === 'visible') {
                void loadLinks(true).catch(() => { /* the scheduler retries */ });
            }
        });
        return () => {
            unsubscribe();
            scheduler.stop();
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('online', refresh);
        };
    }, [loadLinks]);

    useEffect(() => {
        paymentService.getAccount().then(setAccount).catch(() => setAccount(null));
    }, []);

    // A changed request is a new request: it gets a new key.
    useEffect(() => { requestKey.current = null; }, [amount, customerName, customerPhone, customerEmail, description, invoiceId, settles, confirmTest]);

    const handleCreate = async () => {
        if (isCreating) return;
        const checked = linkAmount(amount, invoiceId);
        if (checked.problem) { toast.error(checked.problem); return; }
        if (!customerName.trim()) {
            toast.error('Customer name is required');
            return;
        }
        if (account?.mode === 'test' && !confirmTest) {
            toast.error('This account is in TEST mode: confirm it’s a test link first');
            return;
        }
        const expiresAt = expiryFor(validity, validUntil);
        if (!expiresAt) {
            toast.error(EXPIRY_RANGE_MESSAGE);
            return;
        }
        setIsCreating(true);
        requestKey.current ??= crypto.randomUUID();
        try {
            const link = await paymentService.createPaymentLink({
                amountPaise: checked.amountPaise,
                description: description.trim() || undefined,
                customerName: customerName.trim(),
                customerPhone: customerPhone.trim() || undefined,
                customerEmail: customerEmail.trim() || undefined,
                notifySms,
                notifyEmail: !!customerEmail.trim(),
                expiresAt,
                ...(account?.mode === 'test' ? { mode: 'test' as const } : {}),
                ...(invoiceId ? { invoiceId, settlesInFull: settles || undefined, overrideReason: overrideReason.trim() || undefined } : {}),
            }, requestKey.current);
            requestKey.current = null;
            setCreatedLink(link);
            setLinks(prev => [link, ...prev.filter(l => l.id !== link.id)]);
            setAmount(''); setDescription(''); setInvoiceId(''); setSettles(false); setOverrideReason(''); setReasonShown(false);
            toast.success(link.replayed ? 'That link was already made; here it is' : 'Payment link created');
        } catch (e) {
            const code = (e as { code?: string }).code;
            if (code === 'override_reason_required') setReasonShown(true);
            if (!retryable(e)) requestKey.current = null;
            toast.error((e as Error).message || 'Could not create payment link');
        } finally {
            setIsCreating(false);
        }
    };

    const copyLink = async (link: PaymentLink) => {
        try {
            await navigator.clipboard.writeText(link.shortUrl);
            setCopiedId(link.id);
            setTimeout(() => setCopiedId(null), 2000);
            toast.success('Link copied');
        } catch {
            toast.error('Could not copy the link');
        }
    };

    const shareOnWhatsApp = (link: PaymentLink) => {
        const text = encodeURIComponent(
            `Hello ${link.customerName},\n\nPlease use this secure link to complete your payment of ${formatRupees(link.amount)} to Vayu Design:\n${link.shortUrl}\n\nThank you!`
        );
        const phone = link.customerPhone.replaceAll(/[^\d]/g, '');
        const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
        globalThis.open(url, '_blank', 'noopener');
    };

    const deleteLink = async (link: PaymentLink) => {
        if (confirmDeleteId !== link.id) { setConfirmDeleteId(link.id); return; }
        setConfirmDeleteId(null);
        setBusyId(link.id);
        try {
            await paymentService.deletePaymentLink(link.id);
            setLinks(prev => prev.filter(l => l.id !== link.id));
            if (createdLink?.id === link.id) setCreatedLink(null);
            toast.success(isOpen(link) ? 'Link cancelled and deleted' : 'Removed from the list');
        } catch (e) {
            toast.error((e as Error).message || 'Could not delete the link');
            void loadLinks(true).catch(() => undefined); // e.g. it was just paid
        } finally {
            setBusyId(null);
        }
    };

    const saveValidity = async () => {
        if (!editingValidity) return;
        const expiresAt = expiryFor(editingValidity.choice, editingValidity.date);
        if (!expiresAt) { toast.error(EXPIRY_RANGE_MESSAGE); return; }
        setBusyId(editingValidity.id);
        try {
            const updated = await paymentService.setPaymentLinkExpiry(editingValidity.id, expiresAt);
            setLinks(prev => prev.map(l => (l.id === updated.id ? updated : l)));
            setEditingValidity(null);
            toast.success('Validity changed');
        } catch (e) {
            toast.error((e as Error).message || 'Could not change the validity');
        } finally {
            setBusyId(null);
        }
    };

    const linkCount = links.length === 1 ? '1 link' : `${links.length} links`;

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Payment Links"
                subtitle={links.length > 0 ? linkCount : undefined}
                actions={
                    <GhostIconButton
                        onClick={() => loadLinks()}
                        label="Refresh"
                        icon={<RefreshCw size={16} className={isLoadingLinks ? 'animate-spin' : ''} />}
                        disabled={isLoadingLinks}
                    />
                }
            />

            <PageBody space="none">
                {/* Desktop puts the form and the history side by side instead of
                    stacking one narrow column down the middle of a wide screen. */}
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-4 lg:gap-6 items-start">

                    {/* ── Create form ─────────────────────────────────────── */}
                    <div className="space-y-4 lg:sticky lg:top-0">
                        <Card padding="lg" className="space-y-4 animate-fade-in-up">
                            <SectionTitle>New Payment Link</SectionTitle>

                            <AccountNotice info={account} confirmTest={confirmTest} onConfirmTest={setConfirmTest} />

                            <InvoiceField invoices={invoices} value={invoiceId} onChange={id => { setInvoiceId(id); setSettles(false); setReasonShown(false); }} />

                            <Field label={invoiceId ? 'Amount (₹)' : 'Amount (₹) *'} htmlFor="pay-amount" hint={invoiceId ? 'Leave blank to collect what’s outstanding on the invoice.' : undefined}>
                                <Input
                                    id="pay-amount" type="text" inputMode="decimal" value={amount}
                                    onChange={e => setAmount(e.target.value)}
                                    placeholder={invoiceId ? 'Outstanding amount' : '0.00'}
                                    className="font-serif text-lg"
                                />
                            </Field>

                            {invoiceId && (
                                <OverrideFields isAdmin={isAdmin} settles={settles} onSettles={setSettles}
                                    reasonShown={reasonShown} reason={overrideReason} onReason={setOverrideReason} />
                            )}

                            <Field label="Customer Name *" htmlFor="pay-name">
                                <Input id="pay-name" value={customerName} onChange={e => setCustomerName(e.target.value)} />
                            </Field>

                            <div className="flex gap-3">
                                <Field label="Phone" htmlFor="pay-phone" className="flex-1 min-w-0">
                                    <Input id="pay-phone" type="tel" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="+91…" />
                                </Field>
                                <Field label="Email" htmlFor="pay-email" className="flex-1 min-w-0">
                                    <Input id="pay-email" type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} />
                                </Field>
                            </div>

                            <Field label="Description" htmlFor="pay-desc">
                                <Input id="pay-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder='e.g. "Golden Hour" — oil on canvas' />
                            </Field>

                            <Field label="Valid for" htmlFor="pay-validity">
                                <ValidityPicker
                                    id="pay-validity"
                                    choice={validity}
                                    date={validUntil}
                                    onChoice={setValidity}
                                    onDate={setValidUntil}
                                />
                            </Field>

                            <ToggleRow
                                title="Send link by SMS"
                                checked={notifySms}
                                onChange={() => setNotifySms(v => !v)}
                            />

                            <Button
                                variant="primary"
                                block
                                onClick={handleCreate}
                                disabled={isCreating}
                                icon={<IndianRupee size={15} />}
                                className="uppercase tracking-wider py-3.5"
                            >
                                {isCreating ? 'Creating…' : 'Generate Payment Link'}
                            </Button>
                        </Card>

                        {/* Fresh link result */}
                        {createdLink && (
                            <Card padding="lg" className="space-y-3 animate-fade-in-up ring-1 ring-gold-500/40">
                                <div className="flex items-center gap-2 text-gold-700 dark:text-gold-300">
                                    <LinkIcon size={15} />
                                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em]">Link Ready</h3>
                                </div>
                                <p className="text-sm text-gray-900 dark:text-white break-all font-medium">{createdLink.shortUrl}</p>
                                <p className="text-xs text-gray-700 dark:text-gray-300 flex items-center gap-2">
                                    {formatRupees(createdLink.amount)} · {createdLink.customerName} <TestBadge mode={createdLink.mode} />
                                </p>
                                <div className="flex gap-3">
                                    <Button
                                        block
                                        onClick={() => copyLink(createdLink)}
                                        icon={copiedId === createdLink.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                                        className="uppercase tracking-wider"
                                    >
                                        Copy
                                    </Button>
                                    <Button
                                        block
                                        onClick={() => shareOnWhatsApp(createdLink)}
                                        icon={<MessageCircle size={14} />}
                                        className="uppercase tracking-wider text-green-700 dark:text-green-400"
                                    >
                                        WhatsApp
                                    </Button>
                                </div>
                            </Card>
                        )}
                    </div>

                    {/* ── History ─────────────────────────────────────────── */}
                    <section className="animate-fade-in-up">
                        <SectionTitle className="px-1">Recent Links</SectionTitle>
                        {links.length === 0 && !isLoadingLinks ? (
                            <EmptyState
                                icon={<LinkIcon size={20} />}
                                title="No payment links yet"
                                message="Create your first one with the form alongside."
                            />
                        ) : (
                            <div className="space-y-2.5 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0 2xl:grid-cols-3">
                                {links.map(link => (
                                    <Card key={link.id}>
                                        <div
                                            className={`flex justify-between items-start gap-2 ${link.status === 'paid' || link.status === 'partially_paid' ? 'cursor-pointer' : ''}`}
                                            onClick={() => { if (link.status === 'paid' || link.status === 'partially_paid') setDetailsId(id => (id === link.id ? null : link.id)); }}
                                        >
                                            <div className="min-w-0">
                                                <p className="font-serif text-base text-gray-900 dark:text-white truncate flex items-center gap-2"><span className="truncate">{link.customerName}</span><TestBadge mode={link.mode} /></p>
                                                {link.description && (
                                                    <p className="text-xs text-gray-700 dark:text-gray-300 mt-0.5 truncate">{link.description}</p>
                                                )}
                                            </div>
                                            <Badge className={`shrink-0 uppercase ${STATUS_STYLES[link.status] || STATUS_STYLES.expired}`}>
                                                {STATUS_LABELS[link.status] || link.status}
                                            </Badge>
                                        </div>
                                        <div className="flex justify-between items-center mt-3 pt-2.5 gap-2">
                                            <span className="font-serif text-lg text-gray-900 dark:text-white">{formatRupees(link.amount)}</span>
                                            <span className="text-[11px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">
                                                {link.status === 'paid' && link.paidAt ? `Paid ${formatDate(link.paidAt)}` : formatDate(link.createdAt)}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center mt-2 gap-2">
                                            <span className={`text-[11px] leading-tight min-w-0 ${link.status === 'expired' ? 'text-gray-500 dark:text-gray-400' : 'text-gray-700 dark:text-gray-300'}`}>
                                                {validityText(link) ?? ''}
                                            </span>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <button
                                                    onClick={() => setDetailsId(id => (id === link.id ? null : link.id))}
                                                    className={`neu-icon-btn-sm active-scale ${detailsId === link.id ? 'text-gold-700 dark:text-gold-300' : ''}`}
                                                    title="Payment details"
                                                    aria-label="Payment details"
                                                    aria-expanded={detailsId === link.id}
                                                >
                                                    <Info size={14} />
                                                </button>
                                                {isOpen(link) && (
                                                    <>
                                                        <button onClick={() => copyLink(link)} className="neu-icon-btn-sm active-scale" title="Copy link" aria-label="Copy link">
                                                            {copiedId === link.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                                                        </button>
                                                        <button onClick={() => shareOnWhatsApp(link)} className="neu-icon-btn-sm active-scale" title="Share on WhatsApp" aria-label="Share on WhatsApp">
                                                            <MessageCircle size={14} />
                                                        </button>
                                                        <IfCan section="payments">
                                                            <button
                                                                onClick={() => setEditingValidity(v => (v?.id === link.id ? null : { id: link.id, choice: DEFAULT_VALIDITY, date: dateTimeInputValue(Math.max(link.expiresAt ?? 0, Date.now()) + 7 * DAY_MS) }))}
                                                                className="neu-icon-btn-sm active-scale"
                                                                title="Change validity"
                                                                aria-label="Change validity"
                                                                aria-expanded={editingValidity?.id === link.id}
                                                            >
                                                                <CalendarClock size={14} />
                                                            </button>
                                                        </IfCan>
                                                    </>
                                                )}
                                                <IfCan section="payments">
                                                    <button
                                                        onClick={() => void deleteLink(link)}
                                                        disabled={busyId === link.id}
                                                        className={`neu-icon-btn-sm active-scale disabled:opacity-50 ${confirmDeleteId === link.id ? 'text-red-600 dark:text-red-400 ring-1 ring-red-500/60' : ''}`}
                                                        title={binTitle(isOpen(link), confirmDeleteId === link.id)}
                                                        aria-label={confirmDeleteId === link.id ? 'Tap again to confirm' : binLabel(isOpen(link))}
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </IfCan>
                                            </div>
                                        </div>
                                        {confirmDeleteId === link.id && (
                                            <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">
                                                {isOpen(link)
                                                    ? 'Tap the bin again: the link is cancelled so it can no longer be paid, then removed.'
                                                    : removeNote(link.status === 'paid')}
                                            </p>
                                        )}
                                        {detailsId === link.id && (
                                            <PaymentDetailsPanel
                                                link={link}
                                                onUpdated={updated => setLinks(prev => prev.map(l => (l.id === updated.id ? updated : l)))}
                                            />
                                        )}
                                        {editingValidity?.id === link.id && (
                                            <div className="mt-3 pt-3 border-t border-gray-200/70 dark:border-white/10 space-y-2.5">
                                                <ValidityPicker
                                                    id={`validity-${link.id}`}
                                                    choice={editingValidity.choice}
                                                    date={editingValidity.date}
                                                    onChoice={choice => setEditingValidity(v => (v ? { ...v, choice } : v))}
                                                    onDate={date => setEditingValidity(v => (v ? { ...v, date } : v))}
                                                    fromNow
                                                />
                                                <div className="flex gap-2">
                                                    <Button variant="primary" onClick={() => void saveValidity()} disabled={busyId === link.id} className="flex-1">
                                                        {busyId === link.id ? 'Saving…' : 'Save'}
                                                    </Button>
                                                    <Button onClick={() => setEditingValidity(null)} className="flex-1">Cancel</Button>
                                                </div>
                                            </div>
                                        )}
                                    </Card>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </PageBody>
        </PageRoot>
    );
};

/** How long a link stays valid: a preset, or until a chosen date and time. */
const ValidityPicker: React.FC<{
    id: string;
    choice: string;
    date: string;
    onChoice: (choice: string) => void;
    onDate: (date: string) => void;
    /** Changing an existing link: presets count from now. */
    fromNow?: boolean;
}> = ({ id, choice, date, onChoice, onDate, fromNow = false }) => (
    <div className="flex flex-col gap-2">
        <Select id={id} value={choice} onChange={e => onChoice(e.target.value)} className="flex-1 min-w-0" aria-label="Valid for">
            {VALIDITY_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.days && fromNow ? `${o.label} from now` : o.label}</option>
            ))}
        </Select>
        {choice === 'date' && (
            <Input
                type="datetime-local"
                aria-label="Valid until (date and time)"
                value={date}
                min={dateTimeInputValue(Date.now() + MIN_AHEAD_MS)}
                max={dateTimeInputValue(Date.now() + MAX_AHEAD_MS)}
                step={60}
                onChange={e => onDate(e.target.value)}
                className="flex-1 min-w-0"
            />
        )}
    </div>
);

/**
 * Everything about one link's payment: asked of Razorpay when opened, and
 * again with "Recheck". Shows each payment's references, time, method and
 * what the customer entered at checkout, and the link's own details.
 */
const PaymentDetailsPanel: React.FC<{ link: PaymentLink; onUpdated: (link: PaymentLink) => void }> = ({ link, onUpdated }) => {
    const [checking, setChecking] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const recheck = useCallback(async (announce: boolean) => {
        setChecking(true);
        try {
            const res = await paymentService.getPaymentLinkDetails(link.id);
            onUpdated(res.link);
            setNote(res.checked ? `Checked with Razorpay at ${new Date(res.checkedAt ?? Date.now()).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : res.reason ?? null);
            if (announce) {
                if (!res.checked) toast.error(res.reason ?? "Couldn't reach Razorpay");
                else if (res.link.status === 'paid') toast.success('Payment confirmed by Razorpay');
                else toast(`Razorpay says: ${STATUS_LABELS[res.link.status] ?? res.link.status}`);
            }
        } catch (e) {
            setNote((e as Error).message || "Couldn't check with Razorpay");
            if (announce) toast.error((e as Error).message || "Couldn't check with Razorpay");
        } finally {
            setChecking(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [link.id]);

    // Fresh from Razorpay whenever the panel opens.
    useEffect(() => { void recheck(false); }, [recheck]);

    const payments = sortPayments(link.payments);
    return (
        <div className="mt-3 pt-3 border-t border-gray-200/70 dark:border-white/10 space-y-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-gray-600 dark:text-gray-400 min-w-0">
                    {checking ? 'Checking with Razorpay…' : note}
                </p>
                <Button onClick={() => void recheck(true)} disabled={checking} icon={checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} className="shrink-0 text-[11px] uppercase tracking-wider">
                    Recheck
                </Button>
            </div>

            {payments.length === 0 && !checking && (
                <p className="text-[12px] text-gray-700 dark:text-gray-300">No payment has been made on this link yet.</p>
            )}

            {payments.map(p => <PaymentAttemptCard key={p.id} payment={p} />)}

            <dl className="px-1">
                <DetailRow label="Link" value={link.shortUrl} copy={link.shortUrl} />
                <DetailRow label="Link ID" value={link.id} copy={link.id} />
                <DetailRow label="Made by" value={link.createdByName ? `${link.createdByName}, ${dateTime(link.createdAt)}` : dateTime(link.createdAt)} />
                <DetailRow label="Valid until" value={link.expiresAt ? dateTime(link.expiresAt) : undefined} />
                <DetailRow label="Customer (as entered)" value={[link.customerName, link.customerPhone, link.customerEmail].filter(Boolean).join(' · ')} />
            </dl>
        </div>
    );
};
