import { getThumbUrl } from '../services/storageService';
import React, { useState, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Plus, X, FileText, CheckCircle2, Image as ImageIcon, Info, Search, ArrowLeft, Edit2, Trash2, Download, Share2, Loader2, Phone, Mail, MapPin } from 'lucide-react';
import { Invoice, Artwork, InvoiceItem } from '../types';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { makeDocumentNumber } from '../services/documentNumber';
import { exportProformaPdf } from '../services/proformaPdf';

export type NewInvoice = Omit<Invoice, 'id' | 'date'>;

const getInvoiceStatusColor = (status: string) => {
    switch (status) {
        case 'Paid': return 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400';
        case 'Sent': return 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400';
        default: return 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400';
    }
};

const inputClass = 'w-full bg-transparent border-b border-gray-300 dark:border-gray-700 py-1.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 transition-colors';
const labelClass = 'block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1 uppercase tracking-wider';

interface InvoiceViewProps {
    invoices: Invoice[];
    artworks: Artwork[];
    onAddInvoice: (invoice: NewInvoice) => Promise<Invoice>;
    onUpdateInvoice: (invoice: Invoice) => void;
    onDeleteInvoice: (id: string) => void;
    onArtworkClick: (artwork: Artwork) => void;
}

export const InvoiceView: React.FC<InvoiceViewProps> = ({ invoices, artworks, onAddInvoice, onUpdateInvoice, onDeleteInvoice, onArtworkClick }) => {
    const [isAdding, setIsAdding] = useState(false);
    const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    React.useEffect(() => {
        const handlePopState = (e: PopStateEvent) => {
            if (e.state?.modal !== 'invoice') {
                setSelectedInvoice(null);
            }
        };
        globalThis.addEventListener('popstate', handlePopState);
        return () => globalThis.removeEventListener('popstate', handlePopState);
    }, []);

    const handleInvoiceClick = (invoice: Invoice) => {
        setSelectedInvoice(invoice);
        globalThis.history.pushState({ view: 'invoice', modal: 'invoice' }, '');
    };

    const handleCloseModal = () => {
        if (globalThis.history.state?.modal === 'invoice') {
            globalThis.history.back();
        } else {
            setSelectedInvoice(null);
        }
    };

    const query = searchQuery.toLowerCase();
    const filteredInvoices = invoices.filter(invoice =>
        invoice.customerName.toLowerCase().includes(query) ||
        invoice.invoiceNumber.toLowerCase().includes(query) ||
        (invoice.customerPhone ?? '').includes(query)
    );
    // Proformas are quotations, so only paid ones count as revenue.
    const paidTotal = invoices.filter(inv => inv.status === 'Paid').reduce((sum, inv) => sum + inv.total, 0);

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800" style={{ paddingTop: 'calc(1.75rem + env(safe-area-inset-top, 0px))' }}>
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Proforma Invoices</h1>
                    <button
                        onClick={() => setIsAdding(true)}
                        aria-label="New proforma invoice"
                        className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                    >
                        <Plus size={20} />
                    </button>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search proforma invoices..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] space-y-4 no-scrollbar pb-20">
                {/* Summary Cards */}
                <div className="grid grid-cols-2 gap-[6px] mb-6">
                    <div className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                        <p className="text-[9px] text-gray-500 dark:text-gray-400 font-medium mb-1.5 uppercase tracking-widest">Paid</p>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">₹{paidTotal.toLocaleString('en-IN')}</p>
                    </div>
                    <div className="bg-white dark:bg-[#1e1e1e] p-[6px] rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                        <p className="text-[9px] text-gray-500 dark:text-gray-400 font-medium mb-1.5 uppercase tracking-widest">Proformas</p>
                        <p className="text-xl font-serif text-gray-900 dark:text-white">{invoices.length}</p>
                    </div>
                </div>

                <h2 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-[6px] px-1 animate-fade-in-up" style={{ animationDelay: '150ms' }}>Recent Proforma Invoices</h2>

                <div className="space-y-2">
                    {filteredInvoices.map((invoice, index) => (
                        <button
                            type="button"
                            key={invoice.id}
                            onClick={() => handleInvoiceClick(invoice)}
                            className="w-full text-left bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] flex items-center justify-between border border-gray-100 dark:border-gray-800 animate-fade-in-up cursor-pointer active-scale"
                            style={{ animationDelay: `${index * 25}ms` }}
                        >
                            <div className="flex items-center gap-[6px]">
                                <div className="bg-gray-50 dark:bg-gray-800 p-2.5 rounded-full text-brand-900 dark:text-gold-400">
                                    <FileText size={18} strokeWidth={1.5} />
                                </div>
                                <div>
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm">{invoice.customerName}</h3>
                                    <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">{invoice.invoiceNumber} • {new Date(invoice.date).toLocaleDateString()}</p>
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="font-medium text-brand-900 dark:text-gold-400 text-sm">₹{invoice.total.toLocaleString('en-IN')}</p>
                                <span className={`text-[8px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider inline-block mt-1 ${getInvoiceStatusColor(invoice.status)}`}>
                                    {invoice.status}
                                </span>
                            </div>
                        </button>
                    ))}
                    {filteredInvoices.length === 0 && (
                        <div className="text-center text-gray-400 dark:text-gray-500 mt-10 font-light text-sm">
                            No proforma invoices found.
                        </div>
                    )}
                </div>
            </div>

            {isAdding && (
                <InvoiceFormModal
                    artworks={artworks}
                    onClose={() => setIsAdding(false)}
                    onSave={async (newInv) => {
                        const created = await onAddInvoice(newInv);
                        setIsAdding(false);
                        // Open it straight away so the PDF is one tap away.
                        handleInvoiceClick(created);
                    }}
                    onArtworkClick={onArtworkClick}
                />
            )}

            {selectedInvoice && (
                <InvoiceDetailModal
                    invoice={selectedInvoice}
                    artworks={artworks}
                    onClose={handleCloseModal}
                    onUpdateInvoice={(updated) => {
                        onUpdateInvoice(updated);
                        setSelectedInvoice(updated);
                    }}
                    onDeleteInvoice={() => {
                        onDeleteInvoice(selectedInvoice.id);
                        setSelectedInvoice(null);
                    }}
                    onArtworkClick={onArtworkClick}
                />
            )}
        </div>
    );
};

// ─── PDF actions ────────────────────────────────────────

interface ProformaPdfActionsProps {
    readonly invoice: Invoice;
    readonly artworks: Artwork[];
    readonly compact?: boolean;
}

/** "Download PDF" plus "Share" where the device supports sharing files (e.g. to WhatsApp). */
export const ProformaPdfActions: React.FC<ProformaPdfActionsProps> = ({ invoice, artworks, compact = false }) => {
    const [busy, setBusy] = useState<'download' | 'share' | null>(null);
    const canShare = typeof navigator.canShare === 'function';

    const run = async (mode: 'download' | 'share') => {
        setBusy(mode);
        try {
            const result = await exportProformaPdf(invoice, artworks, mode === 'share');
            if (mode === 'share' && result === 'downloaded') toast('Sharing isn’t available here, so the PDF was downloaded.');
        } catch (e) {
            // Closing the share sheet rejects with AbortError — not a failure.
            if ((e as Error).name !== 'AbortError') {
                console.error('Proforma PDF failed:', e);
                toast.error('Could not create the PDF. Please try again.');
            }
        } finally {
            setBusy(null);
        }
    };

    const size = compact ? 13 : 15;
    const base = compact
        ? 'flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-[6px] text-[9px] font-bold uppercase tracking-widest active-scale disabled:opacity-60'
        : 'flex-1 flex items-center justify-center gap-2 py-3 rounded-[6px] text-[10px] font-bold uppercase tracking-widest active-scale shadow-sm disabled:opacity-60';

    return (
        <div className={compact ? 'flex gap-1.5' : 'flex gap-[6px]'}>
            <button
                type="button"
                onClick={() => { void run('download'); }}
                disabled={busy !== null}
                className={`${base} bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950`}
            >
                {busy === 'download' ? <Loader2 size={size} className="animate-spin" /> : <Download size={size} />}
                {compact ? 'PDF' : 'Download PDF'}
            </button>
            {canShare && (
                <button
                    type="button"
                    onClick={() => { void run('share'); }}
                    disabled={busy !== null}
                    className={`${base} bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700`}
                >
                    {busy === 'share' ? <Loader2 size={size} className="animate-spin" /> : <Share2 size={size} />}
                    Share
                </button>
            )}
        </div>
    );
};

// ─── Detail Modal ───────────────────────────────────────

interface InvoiceDetailModalProps {
    invoice: Invoice;
    artworks: Artwork[];
    onClose: () => void;
    onUpdateInvoice: (invoice: Invoice) => void;
    onDeleteInvoice: () => void;
    onArtworkClick: (artwork: Artwork) => void;
}

export const InvoiceDetailModal: React.FC<InvoiceDetailModalProps> = ({ invoice, artworks, onClose, onUpdateInvoice, onDeleteInvoice, onArtworkClick }) => {
    const [isEditing, setIsEditing] = useState(false);

    const handleSaveEdit = (updatedData: NewInvoice) => {
        onUpdateInvoice({
            ...updatedData,
            id: invoice.id,
            date: invoice.date
        });
        setIsEditing(false);
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} aria-label="Back" className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full flex items-center gap-2 transition-colors active-scale">
                    <ArrowLeft size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white truncate px-[6px]">{invoice.invoiceNumber}</h2>
                <div className="flex items-center gap-2">
                    <button onClick={() => setIsEditing(true)} aria-label="Edit proforma invoice" className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                        <Edit2 size={18} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar pb-20">
                <div className="mb-4 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <ProformaPdfActions invoice={invoice} artworks={artworks} />
                </div>

                <div className="bg-white dark:bg-[#1e1e1e] p-6 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 mb-6">
                    <div className="flex justify-between items-start mb-6 gap-3">
                        <div className="min-w-0">
                            <h3 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">Bill To</h3>
                            <p className="font-serif text-lg text-gray-900 dark:text-white">{invoice.customerName}</p>
                            {invoice.customerPhone && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1.5"><Phone size={11} className="text-gold-500 shrink-0" />{invoice.customerPhone}</p>
                            )}
                            {invoice.customerEmail && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1.5 break-all"><Mail size={11} className="text-gold-500 shrink-0" />{invoice.customerEmail}</p>
                            )}
                            {invoice.customerAddress && (
                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 flex items-start gap-1.5 whitespace-pre-line"><MapPin size={11} className="text-gold-500 shrink-0 mt-0.5" />{invoice.customerAddress}</p>
                            )}
                        </div>
                        <div className="text-right shrink-0">
                            <h3 className="text-[9px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-widest mb-1">Status</h3>
                            <span className={`text-[10px] px-2 py-1 rounded-[3px] font-medium uppercase tracking-wider inline-block ${getInvoiceStatusColor(invoice.status)}`}>
                                {invoice.status}
                            </span>
                            <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-2">{new Date(invoice.date).toLocaleDateString()}</p>
                        </div>
                    </div>

                    <div className="w-full h-px bg-gray-100 dark:bg-gray-800 mb-6"></div>

                    <h3 className="text-[10px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-4">Items</h3>
                    <div className="space-y-4 mb-6">
                        {invoice.items.map((item) => {
                            const art = artworks.find(a => a.id === item.artworkId);
                            return (
                                <div key={item.artworkId} className="flex justify-between items-center">
                                    <div className="flex items-center gap-[6px]">
                                        {art?.imageUrls?.length ? (
                                            <img loading="lazy" decoding="async" src={getThumbUrl(art.imageUrls[0])} alt={item.title} className="w-10 h-10 rounded-[3px] object-cover" />
                                        ) : (
                                            <div className="w-10 h-10 rounded-[3px] bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400">
                                                <ImageIcon size={14} />
                                            </div>
                                        )}
                                        <div>
                                            <p className="font-serif text-sm text-gray-900 dark:text-white">{item.title}</p>
                                            {art && (
                                                <button onClick={() => onArtworkClick(art)} className="text-[9px] text-gold-600 dark:text-gold-400 uppercase tracking-wider hover:underline">
                                                    View Details
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <p className="font-medium text-sm text-gray-900 dark:text-white">₹{item.price.toLocaleString('en-IN')}</p>
                                </div>
                            );
                        })}
                    </div>

                    <div className="w-full h-px bg-gray-100 dark:bg-gray-800 mb-4"></div>

                    <div className="space-y-2">
                        <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400">
                            <span>Subtotal</span>
                            <span>₹{invoice.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400">
                            <span>GST ({(invoice.taxRate * 100).toFixed(1)}%)</span>
                            <span>₹{(invoice.total - invoice.subtotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="pt-3 mt-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center">
                            <span className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px]">Total</span>
                            <span className="text-xl font-serif text-brand-900 dark:text-gold-400">₹{invoice.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                    </div>
                </div>

                {isEditing && (
                    <InvoiceFormModal
                        initialData={invoice}
                        artworks={artworks}
                        onClose={() => setIsEditing(false)}
                        onSave={handleSaveEdit}
                        onArtworkClick={onArtworkClick}
                        onDelete={onDeleteInvoice}
                    />
                )}
            </div>
        </div>
    );
};

// ─── Form Modal ─────────────────────────────────────────

interface InvoiceFormModalProps {
    /** Existing proforma being edited. */
    initialData?: Invoice;
    /** Starting values for a new proforma (e.g. from an inquiry). */
    prefill?: Partial<NewInvoice>;
    artworks: Artwork[];
    saveLabel?: string;
    onClose: () => void;
    onSave: (invoice: NewInvoice) => void | Promise<void>;
    onArtworkClick: (artwork: Artwork) => void;
    /** Shown only when editing an existing proforma — delete lives inside the edit form. */
    onDelete?: () => void;
}

export const InvoiceFormModal: React.FC<InvoiceFormModalProps> = ({ initialData, prefill, artworks, saveLabel = 'Save', onClose, onSave, onArtworkClick, onDelete }) => {
    const [confirmDelete, setConfirmDelete] = useState(false);
    const start = initialData ?? prefill;
    const [customerName, setCustomerName] = useState(start?.customerName ?? '');
    const [customerPhone, setCustomerPhone] = useState(start?.customerPhone ?? '');
    const [customerEmail, setCustomerEmail] = useState(start?.customerEmail ?? '');
    const [customerAddress, setCustomerAddress] = useState(start?.customerAddress ?? '');
    const [status, setStatus] = useState<Invoice['status']>(start?.status ?? 'Draft');
    const [selectedArtworkIds, setSelectedArtworkIds] = useState<Set<string>>(new Set(start?.items?.map(item => item.artworkId) ?? []));
    const [taxRate, setTaxRate] = useState(start?.taxRate ?? 0.18);
    const [isSaving, setIsSaving] = useState(false);

    // Available artworks, plus anything already on this proforma (even if reserved or sold).
    const availableArtworks = artworks.filter(a => a.status === 'Available' || selectedArtworkIds.has(a.id));

    const toggleArtwork = (id: string) => {
        const newSet = new Set(selectedArtworkIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setSelectedArtworkIds(newSet);
    };

    const selectedItems: InvoiceItem[] = useMemo(() => {
        return Array.from(selectedArtworkIds).map(id => {
            const art = artworks.find(a => a.id === id);
            if (!art) return null;
            return { artworkId: art.id, title: art.title, price: art.price };
        }).filter((item): item is InvoiceItem => item !== null);
    }, [selectedArtworkIds, artworks]);

    const subtotal = useMemo(() => selectedItems.reduce((sum, item) => sum + item.price, 0), [selectedItems]);
    const taxAmount = subtotal * taxRate;
    const total = subtotal + taxAmount;

    const handleSubmit = async () => {
        if (!customerName.trim()) return toast.error('Client name is required');
        if (!customerPhone.trim() && !customerEmail.trim()) return toast.error('Add the client’s phone number or email');
        if (selectedItems.length === 0) return toast.error('Select at least one artwork');

        setIsSaving(true);
        try {
            await onSave({
                invoiceNumber: initialData?.invoiceNumber || makeDocumentNumber('PI'),
                customerName: customerName.trim(),
                customerPhone: customerPhone.trim(),
                customerEmail: customerEmail.trim(),
                customerAddress: customerAddress.trim(),
                inquiryId: start?.inquiryId,
                items: selectedItems,
                subtotal,
                taxRate,
                total,
                status
            });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-[70] flex flex-col animate-fade-in-up">
            <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                <button onClick={onClose} aria-label="Close" className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Proforma Invoice' : 'New Proforma Invoice'}</h2>
                <button onClick={() => { void handleSubmit(); }} disabled={isSaving} className="text-gold-600 dark:text-gold-400 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale disabled:opacity-60 flex items-center gap-1">
                    {isSaving && <Loader2 size={12} className="animate-spin" />}
                    {saveLabel}
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-[6px] no-scrollbar flex flex-col gap-6">
                {/* Client Info */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-5 animate-fade-in-up" style={{ animationDelay: '50ms' }}>
                    <div>
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest">Client Details</h3>
                        <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-1">Name, plus a phone number or email.</p>
                    </div>
                    <div>
                        <label htmlFor="invoice-customer-name" className={labelClass}>Name *</label>
                        <input
                            id="invoice-customer-name"
                            value={customerName}
                            onChange={e => setCustomerName(e.target.value)}
                            className={inputClass}
                            placeholder="Client Name"
                        />
                    </div>
                    <div>
                        <label htmlFor="invoice-customer-phone" className={labelClass}>Phone</label>
                        <input
                            id="invoice-customer-phone"
                            type="tel"
                            value={customerPhone}
                            onChange={e => setCustomerPhone(e.target.value)}
                            className={inputClass}
                            placeholder="+91 98765 43210"
                        />
                    </div>
                    <div>
                        <label htmlFor="invoice-customer-email" className={labelClass}>Email</label>
                        <input
                            id="invoice-customer-email"
                            type="email"
                            value={customerEmail}
                            onChange={e => setCustomerEmail(e.target.value)}
                            className={inputClass}
                            placeholder="client@example.com"
                        />
                    </div>
                    <div>
                        <label htmlFor="invoice-customer-address" className={labelClass}>Address</label>
                        <textarea
                            id="invoice-customer-address"
                            value={customerAddress}
                            onChange={e => setCustomerAddress(e.target.value)}
                            rows={2}
                            className={`${inputClass} resize-none`}
                            placeholder="Billing address (optional)"
                        />
                    </div>
                    <div>
                        <label htmlFor="invoice-status" className={labelClass}>Status</label>
                        <select
                            id="invoice-status"
                            value={status}
                            onChange={e => setStatus(e.target.value as Invoice['status'])}
                            className={inputClass}
                        >
                            <option value="Draft" className="dark:bg-gray-800">Draft</option>
                            <option value="Sent" className="dark:bg-gray-800">Sent</option>
                            <option value="Paid" className="dark:bg-gray-800">Paid</option>
                        </select>
                        <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-1">Marking as Paid marks these artworks as Sold.</p>
                    </div>
                </div>

                {/* Select Artworks */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest">Artworks</h3>
                        <span className="text-[9px] bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{selectedItems.length} selected</span>
                    </div>

                    <div className="space-y-2 max-h-60 overflow-y-auto pr-1 no-scrollbar">
                        {availableArtworks.length === 0 && (
                            <p className="text-xs text-gray-400 dark:text-gray-500 font-light">No available artworks.</p>
                        )}
                        {availableArtworks.map((art, index) => {
                            const isSelected = selectedArtworkIds.has(art.id);
                            const coverImage = art.imageUrls?.[0];
                            return (
                                <div
                                    key={art.id}
                                    className={`relative w-full text-left flex items-center p-2 rounded-[6px] border transition-colors cursor-pointer active-scale animate-scale-in ${
                                        isSelected ? 'border-gold-500 bg-gold-50/50 dark:bg-gold-900/10' : 'border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50'
                                    }`}
                                    style={{ animationDelay: `${index * 25}ms` }}
                                >
                                    {/* Row tap target; inner action buttons sit above it (z-[2]). */}
                                    <button
                                        type="button"
                                        onClick={() => toggleArtwork(art.id)}
                                        aria-label={`${isSelected ? 'Remove' : 'Add'} ${art.title}`}
                                        aria-pressed={isSelected}
                                        className="absolute inset-0 z-[1] w-full h-full rounded-[6px] cursor-pointer"
                                    />
                                    {coverImage ? (
                                        <img loading="lazy" decoding="async" src={getThumbUrl(coverImage)} alt={art.title} className="w-10 h-10 rounded-[3px] object-cover mr-3" />
                                    ) : (
                                        <div className="w-10 h-10 rounded-[3px] bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-400 mr-3">
                                            <ImageIcon size={14} />
                                        </div>
                                    )}
                                    <div className="flex-1">
                                        <p className="font-serif text-xs text-gray-900 dark:text-gray-100 line-clamp-1">{art.title}</p>
                                        <p className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider mt-0.5">{art.customId}</p>
                                    </div>
                                    <div className="text-right flex items-center gap-[6px]">
                                        <p className="font-medium text-xs text-gray-900 dark:text-gray-100">₹{art.price.toLocaleString('en-IN')}{art.plusGst ? ' + GST' : ''}</p>
                                        <button type="button" aria-label="View artwork details"
                                            onClick={(e) => { e.stopPropagation(); onArtworkClick(art); }}
                                            className="relative z-[2] p-1 text-gray-400 hover:text-gold-500 transition-colors"
                                        >
                                            <Info size={14} />
                                        </button>
                                        <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                                            isSelected ? 'bg-gold-500 border-gold-500 text-white' : 'border-gray-300 dark:border-gray-600 text-transparent'
                                        }`}>
                                            <CheckCircle2 size={10} strokeWidth={3} />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Totals */}
                <div className="bg-white dark:bg-[#1e1e1e] p-5 rounded-[6px] shadow-sm border border-gray-100 dark:border-gray-800 space-y-3 animate-fade-in-up" style={{ animationDelay: '200ms' }}>
                    <h3 className="font-bold text-gray-900 dark:text-gray-100 text-[10px] uppercase tracking-widest mb-[6px]">Summary</h3>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400">
                        <span>Subtotal</span>
                        <span className="text-gray-900 dark:text-gray-100">₹{subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 items-center">
                        <span className="flex items-center gap-2">
                            GST {' '}
                            <input
                                type="number"
                                aria-label="GST rate percent"
                                value={taxRate * 100}
                                onChange={e => setTaxRate(Number(e.target.value) / 100)}
                                className="w-12 bg-transparent border-b border-gray-300 dark:border-gray-700 px-1 text-center text-gray-900 dark:text-white focus:outline-none focus:border-gold-500"
                                step="0.1"
                            />%
                        </span>
                        <span className="text-gray-900 dark:text-gray-100">₹{taxAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div className="pt-3 border-t border-gray-100 dark:border-gray-800 flex justify-between items-center mt-1">
                        <span className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[10px]">Total</span>
                        <span className="text-xl font-serif text-brand-900 dark:text-gold-400">₹{total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                </div>

                <div className="h-10"></div>

                {initialData && onDelete && (
                    <button
                        type="button"
                        onClick={() => setConfirmDelete(true)}
                        className="w-full rounded-[6px] py-2.5 text-sm font-medium tracking-wide transition-colors active-scale flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20 mb-4"
                    >
                        <Trash2 size={14} /> Delete Proforma Invoice
                    </button>
                )}
            </div>

            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete proforma invoice"
                itemName={initialData ? `${initialData.invoiceNumber} — ${initialData.customerName}` : ''}
                message="it will be archived for admin review"
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => {
                    setConfirmDelete(false);
                    onDelete?.();
                }}
            />
        </div>
    );
};
