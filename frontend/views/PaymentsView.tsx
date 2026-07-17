import React, { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { PaymentLink } from '../types';
import { paymentService } from '../services/paymentService';
import { IndianRupee, Copy, Check, RefreshCw, Link as LinkIcon, MessageCircle } from 'lucide-react';

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

const STATUS_STYLES: Record<string, string> = {
    paid: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
    created: 'bg-gold-500/15 text-gold-700 dark:text-gold-400',
    partially_paid: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
    expired: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400',
    cancelled: 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400',
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
        const phone = link.customerPhone.replace(/[^\d]/g, '');
        const url = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
        globalThis.open(url, '_blank', 'noopener');
    };

    const inputClass = 'w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors';
    const labelClass = 'block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider';

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <h1 className="text-xl font-serif text-gray-900 dark:text-white">Payment Links</h1>
                <button onClick={() => loadLinks()} className="text-brand-900 dark:text-gray-300 active-scale" title="Refresh">
                    <RefreshCw size={16} className={isLoadingLinks ? 'animate-spin' : ''} />
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-6 no-scrollbar pb-24">

                {/* Create form */}
                <section className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px]">New Payment Link</h2>

                    <div>
                        <label htmlFor="pay-amount" className={labelClass}>Amount (₹) *</label>
                        <input
                            id="pay-amount" type="number" inputMode="decimal" min="1" value={amount}
                            onChange={e => setAmount(e.target.value)}
                            placeholder="0.00"
                            className={`${inputClass} font-serif text-lg`}
                        />
                    </div>

                    <div>
                        <label htmlFor="pay-name" className={labelClass}>Customer Name *</label>
                        <input id="pay-name" value={customerName} onChange={e => setCustomerName(e.target.value)} className={inputClass} />
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-1">
                            <label htmlFor="pay-phone" className={labelClass}>Phone</label>
                            <input id="pay-phone" type="tel" value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="+91…" className={inputClass} />
                        </div>
                        <div className="flex-1">
                            <label htmlFor="pay-email" className={labelClass}>Email</label>
                            <input id="pay-email" type="email" value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} className={inputClass} />
                        </div>
                    </div>

                    <div>
                        <label htmlFor="pay-desc" className={labelClass}>Description</label>
                        <input id="pay-desc" value={description} onChange={e => setDescription(e.target.value)} placeholder='e.g. "Golden Hour" — oil on canvas' className={inputClass} />
                    </div>

                    <div className="flex justify-between items-center py-1">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Send link by SMS</span>
                        <button
                            onClick={() => setNotifySms(v => !v)}
                            className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-300 ease-in-out active-scale ${notifySms ? 'bg-gold-500' : 'bg-gray-300 dark:bg-gray-700'}`}
                        >
                            <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-300 ease-in-out ${notifySms ? 'translate-x-5' : 'translate-x-0'}`}></div>
                        </button>
                    </div>

                    <button
                        onClick={handleCreate}
                        disabled={isCreating}
                        className={`w-full bg-gold-500 hover:bg-gold-600 text-white p-3.5 rounded-[6px] shadow-sm flex items-center justify-center gap-2 font-medium uppercase tracking-wider text-xs transition-colors active-scale ${isCreating ? 'opacity-60' : ''}`}
                    >
                        <IndianRupee size={15} /> {isCreating ? 'Creating…' : 'Generate Payment Link'}
                    </button>
                </section>

                {/* Fresh link result */}
                {createdLink && (
                    <section className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gold-500/40 space-y-3 animate-fade-in-up">
                        <div className="flex items-center gap-2 text-gold-600 dark:text-gold-400">
                            <LinkIcon size={15} />
                            <h2 className="text-[10px] font-bold uppercase tracking-widest">Link Ready</h2>
                        </div>
                        <p className="text-sm text-gray-900 dark:text-white break-all font-medium">{createdLink.shortUrl}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                            {formatRupees(createdLink.amount)} · {createdLink.customerName}
                        </p>
                        <div className="flex gap-[6px]">
                            <button onClick={() => copyLink(createdLink)} className="flex-1 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 p-2.5 rounded-[6px] flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wider active-scale">
                                {copiedId === createdLink.id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />} Copy
                            </button>
                            <button onClick={() => shareOnWhatsApp(createdLink)} className="flex-1 bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-[6px] flex items-center justify-center gap-2 text-xs font-medium uppercase tracking-wider active-scale transition-colors">
                                <MessageCircle size={14} /> WhatsApp
                            </button>
                        </div>
                    </section>
                )}

                {/* History */}
                <section className="animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1">Recent Links</h2>
                    {links.length === 0 && !isLoadingLinks ? (
                        <div className="bg-white dark:bg-[#1e1e1e] p-6 rounded-[6px] border border-gray-100 dark:border-gray-800 text-center text-sm text-gray-400 dark:text-gray-500">
                            No payment links yet — create your first one above.
                        </div>
                    ) : (
                        <div className="space-y-[6px]">
                            {links.map(link => (
                                <div key={link.id} className="bg-white dark:bg-[#1e1e1e] p-4 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800">
                                    <div className="flex justify-between items-start gap-2">
                                        <div className="min-w-0">
                                            <p className="font-serif text-base text-gray-900 dark:text-white truncate">{link.customerName}</p>
                                            {link.description && (
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{link.description}</p>
                                            )}
                                        </div>
                                        <span className={`shrink-0 text-[9px] font-semibold uppercase tracking-wider rounded-full px-2.5 py-1 ${STATUS_STYLES[link.status] || STATUS_STYLES.expired}`}>
                                            {STATUS_LABELS[link.status] || link.status}
                                        </span>
                                    </div>
                                    <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800">
                                        <span className="font-serif text-lg text-gray-900 dark:text-white">{formatRupees(link.amount)}</span>
                                        <div className="flex items-center gap-3">
                                            <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                                                {link.status === 'paid' && link.paidAt ? `Paid ${formatDate(link.paidAt)}` : formatDate(link.createdAt)}
                                            </span>
                                            {link.status !== 'paid' && (
                                                <>
                                                    <button onClick={() => copyLink(link)} className="text-gray-400 hover:text-gold-600 dark:hover:text-gold-400 active-scale" title="Copy link">
                                                        {copiedId === link.id ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
                                                    </button>
                                                    <button onClick={() => shareOnWhatsApp(link)} className="text-gray-400 hover:text-green-600 active-scale" title="Share on WhatsApp">
                                                        <MessageCircle size={15} />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};
