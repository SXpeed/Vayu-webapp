import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { PaymentLink } from '../types';
import { paymentService } from '../services/paymentService';
import { createRefreshScheduler } from '../services/refreshScheduler';
import { realtimeService } from '../services/realtimeService';
import { IndianRupee, Copy, Check, RefreshCw, Link as LinkIcon, MessageCircle, Trash2, CalendarClock } from 'lucide-react';
import {
    PageRoot, PageHeader, PageBody, Card, SectionTitle, Field, Input, Select,
    Button, GhostIconButton, Badge, EmptyState, ToggleRow,
} from '../components/ui';
import { IfCan } from '../components/Layout';

const formatRupees = (paise: number) =>
    `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

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

export const PaymentsView: React.FC = () => {
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

    const handleCreate = async () => {
        if (isCreating) return;
        const rupees = Number.parseFloat(amount);
        if (!Number.isFinite(rupees) || rupees < 1) {
            toast.error('Enter a valid amount (minimum ₹1)');
            return;
        }
        if (!customerName.trim()) {
            toast.error('Customer name is required');
            return;
        }
        const expiresAt = expiryFor(validity, validUntil);
        if (!expiresAt) {
            toast.error(EXPIRY_RANGE_MESSAGE);
            return;
        }
        setIsCreating(true);
        try {
            const link = await paymentService.createPaymentLink({
                amount: rupees,
                description: description.trim() || undefined,
                customerName: customerName.trim(),
                customerPhone: customerPhone.trim() || undefined,
                customerEmail: customerEmail.trim() || undefined,
                notifySms,
                notifyEmail: !!customerEmail.trim(),
                expiresAt,
            });
            setCreatedLink(link);
            setLinks(prev => [link, ...prev]);
            setAmount(''); setDescription('');
            toast.success('Payment link created');
        } catch (e) {
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

                            <Field label="Amount (₹) *" htmlFor="pay-amount">
                                <Input
                                    id="pay-amount" type="number" inputMode="decimal" min="1" value={amount}
                                    onChange={e => setAmount(e.target.value)}
                                    placeholder="0.00"
                                    className="font-serif text-lg"
                                />
                            </Field>

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
                                <p className="text-xs text-gray-700 dark:text-gray-300">
                                    {formatRupees(createdLink.amount)} · {createdLink.customerName}
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
                                        <div className="flex justify-between items-start gap-2">
                                            <div className="min-w-0">
                                                <p className="font-serif text-base text-gray-900 dark:text-white truncate">{link.customerName}</p>
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
                                                        title={confirmDeleteId === link.id ? (isOpen(link) ? 'Tap again to cancel and delete' : 'Tap again to remove') : (isOpen(link) ? 'Cancel and delete' : 'Remove from the list')}
                                                        aria-label={confirmDeleteId === link.id ? 'Tap again to confirm' : (isOpen(link) ? 'Cancel and delete link' : 'Remove from the list')}
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
                                                    : `Tap the bin again to remove it from the list.${link.status === 'paid' ? ' The payment stays in Razorpay.' : ''}`}
                                            </p>
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
