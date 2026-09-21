import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { PaymentLink } from '../types';
import { paymentService } from '../services/paymentService';
import { IndianRupee, Copy, Check, RefreshCw, Link as LinkIcon, MessageCircle } from 'lucide-react';
import {
    PageRoot, PageHeader, PageBody, Card, SectionTitle, Field, Input,
    Button, GhostIconButton, Badge, EmptyState, ToggleRow,
} from '../components/ui';

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
    const [isCreating, setIsCreating] = useState(false);
    const [createdLink, setCreatedLink] = useState<PaymentLink | null>(null);

    const [links, setLinks] = useState<PaymentLink[]>([]);
    const [isLoadingLinks, setIsLoadingLinks] = useState(true);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const loadLinks = useCallback(async (silent = false) => {
        if (!silent) setIsLoadingLinks(true);
        try {
            setLinks(await paymentService.getPaymentLinks());
        } catch (e) {
            if (!silent) toast.error((e as Error).message || 'Could not load payment links');
        } finally {
            if (!silent) setIsLoadingLinks(false);
        }
    }, []);

    // Load on mount and keep the list fresh (a paid webhook can land any time).
    useEffect(() => {
        loadLinks();
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') loadLinks(true);
        }, 15000);
        return () => clearInterval(interval);
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
                                            <div className="flex items-center gap-2">
                                                <span className="text-[11px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">
                                                    {link.status === 'paid' && link.paidAt ? `Paid ${formatDate(link.paidAt)}` : formatDate(link.createdAt)}
                                                </span>
                                                {link.status !== 'paid' && (
                                                    <>
                                                        <button onClick={() => copyLink(link)} className="neu-icon-btn-sm active-scale" title="Copy link" aria-label="Copy link">
                                                            {copiedId === link.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                                                        </button>
                                                        <button onClick={() => shareOnWhatsApp(link)} className="neu-icon-btn-sm active-scale" title="Share on WhatsApp" aria-label="Share on WhatsApp">
                                                            <MessageCircle size={14} />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
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
