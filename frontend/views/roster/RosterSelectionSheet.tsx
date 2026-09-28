import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Library, Loader2, MessageSquarePlus, Share2, ShoppingBag, Trash2, X } from 'lucide-react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { Button, EmptyState, Field, Input, Select, Textarea, ToggleRow } from '../../components/ui';
import { useAppChrome } from '../../components/Layout';
import { getThumbUrl } from '../../services/storageService';
import { makeDocumentNumber } from '../../services/documentNumber';
import type { Artwork, Collection, Inquiry } from '../../types';

type Mode = 'list' | 'inquiry' | 'collection';

const SOURCES: Inquiry['source'][] = ['Walk-in', 'Phone', 'Email', 'Social Media', 'Referral', 'Other'];

interface RosterSelectionSheetProps {
    pieces: Artwork[];
    onRemove: (id: string) => void;
    onClear: () => void;
    onOpenPiece: (art: Artwork) => void;
    onAddInquiry: (inquiry: Omit<Inquiry, 'id' | 'date'>) => Promise<void>;
    onAddCollection: (collection: Omit<Collection, 'id'>) => Promise<void>;
    onClose: () => void;
}

/** A plain-text list of the pieces, for WhatsApp, email or a note. */
function shareText(pieces: Artwork[], withPrices: boolean): string {
    const lines = pieces.map((a, i) => {
        const bits = [a.medium, a.dimensions].filter(Boolean).join(', ');
        const price = withPrices && a.price ? `₹${a.price.toLocaleString('en-IN')}${a.plusGst ? ' + GST' : ''}` : 'Price on request';
        return `${i + 1}. ${a.title}${bits ? ` (${bits})` : ''} — ${price}`;
    });
    return [`A selection of ${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'}:`, '', ...lines].join('\n');
}

/**
 * The person's selection (the bag): look it over, then share it as a list,
 * start an inquiry with it, or keep it as a collection. Each action shows only
 * when the person's role can do it.
 */
export const RosterSelectionSheet: React.FC<RosterSelectionSheetProps> = ({
    pieces, onRemove, onClear, onOpenPiece, onAddInquiry, onAddCollection, onClose,
}) => {
    const { can, navigate } = useAppChrome();
    const [mode, setMode] = useState<Mode>('list');
    const [withPrices, setWithPrices] = useState(false);
    const [busy, setBusy] = useState(false);
    const [customer, setCustomer] = useState({ name: '', phone: '', email: '', source: 'Walk-in' as Inquiry['source'], notes: '' });
    const [collectionName, setCollectionName] = useState('');

    const canInquire = can('inquiries', 'edit');
    const canCollect = can('collections', 'edit');
    const total = useMemo(() => pieces.reduce((sum, a) => sum + (a.price || 0), 0), [pieces]);

    const share = async () => {
        const text = shareText(pieces, withPrices);
        try {
            if (navigator.share) {
                await navigator.share({ title: 'Selection', text });
                return;
            }
            await navigator.clipboard.writeText(text);
            toast.success('Copied. Paste it into a message.');
        } catch (e) {
            if ((e as Error).name === 'AbortError') return; // closed the share sheet
            try {
                await navigator.clipboard.writeText(text);
                toast.success('Copied. Paste it into a message.');
            } catch {
                toast.error('Could not share or copy the list');
            }
        }
    };

    const createInquiry = async () => {
        if (!customer.name.trim() || !customer.phone.trim()) { toast.error('Add the customer’s name and phone'); return; }
        setBusy(true);
        try {
            await onAddInquiry({
                inquiryNumber: makeDocumentNumber('INQ'),
                customerName: customer.name.trim(),
                customerPhone: customer.phone.trim(),
                customerEmail: customer.email.trim(),
                artworkIds: pieces.map(a => a.id),
                notes: customer.notes.trim() || 'Selected from the Showcase.',
                source: customer.source,
                status: 'New',
                catalogShared: false,
            });
            toast.success(t => (
                <span className="flex items-center gap-3">
                    Inquiry created
                    <button type="button" className="underline font-medium" onClick={() => { toast.dismiss(t.id); onClose(); navigate('inquiry'); }}>Open</button>
                </span>
            ), { duration: 6000 });
            onClear();
            onClose();
        } catch (e) {
            toast.error((e as Error).message || 'Could not create the inquiry');
        } finally {
            setBusy(false);
        }
    };

    const createCollection = async () => {
        if (!collectionName.trim()) { toast.error('Name the collection'); return; }
        setBusy(true);
        try {
            await onAddCollection({
                name: collectionName.trim(),
                description: 'Gathered from the Showcase.',
                artworkIds: pieces.map(a => a.id),
                coverImageUrl: pieces.find(a => a.imageUrls[0])?.imageUrls[0],
                createdAt: Date.now(),
            });
            toast.success('Collection saved');
            setMode('list');
            setCollectionName('');
        } catch (e) {
            toast.error((e as Error).message || 'Could not save the collection');
        } finally {
            setBusy(false);
        }
    };

    let title = `Your selection · ${pieces.length}`;
    if (mode === 'inquiry') title = 'New inquiry';
    else if (mode === 'collection') title = 'Save as a collection';

    return (
        <FullScreenPortal>
            <div className="neu-sheet animate-fade-in-up" role="dialog" aria-modal="true" aria-label="Your selection">
                <div className="flex justify-between items-center gap-3 px-3 pb-2" style={{ paddingTop: 'calc(0.75rem + var(--safe-top))' }}>
                    <button type="button" onClick={mode === 'list' ? onClose : () => setMode('list')} aria-label={mode === 'list' ? 'Close' : 'Back'}
                        className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                        <X size={20} />
                    </button>
                    <h2 className="text-base font-serif text-gray-900 dark:text-white truncate">{title}</h2>
                    <span className="w-9" />
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 lg:px-6 pb-[calc(2rem+var(--safe-bottom-ui))] lg:pb-6 space-y-4">
                    {pieces.length === 0 && (
                        <EmptyState
                            icon={<ShoppingBag size={22} strokeWidth={1.5} />}
                            title="Nothing selected yet"
                            message="Tap the bag on any piece to gather a shortlist for a client."
                        />
                    )}

                    {pieces.length > 0 && mode === 'list' && (
                        <>
                            <ul className="space-y-2">
                                {pieces.map(art => (
                                    <li key={art.id} className="neu-card p-2 flex items-center gap-3">
                                        <button type="button" onClick={() => onOpenPiece(art)} className="flex items-center gap-3 min-w-0 flex-1 text-left active-scale">
                                            <span className="w-14 h-14 shrink-0 rounded-xl overflow-hidden roster-backdrop-studio">
                                                {art.imageUrls[0] && <img src={getThumbUrl(art.imageUrls[0])} alt="" loading="lazy" className="w-full h-full object-contain p-1" />}
                                            </span>
                                            <span className="min-w-0">
                                                <span className="block font-serif text-[14px] truncate text-[var(--neu-text)]">{art.title}</span>
                                                <span className="block text-[11px] uppercase tracking-wider truncate text-[var(--neu-text-dim)]">
                                                    {[art.customId, art.dimensions].filter(Boolean).join(' · ') || art.status}
                                                </span>
                                            </span>
                                        </button>
                                        <button type="button" onClick={() => onRemove(art.id)} aria-label={`Remove ${art.title}`} className="neu-icon-btn-sm hover:text-red-500 active-scale">
                                            <X size={13} />
                                        </button>
                                    </li>
                                ))}
                            </ul>

                            {can('inventory') && total > 0 && (
                                <p className="px-1 text-[12px] text-[var(--neu-text-dim)]">
                                    Listed prices add up to <span className="font-semibold text-[var(--neu-gold)]">₹{total.toLocaleString('en-IN')}</span>
                                </p>
                            )}

                            <div className="neu-card p-4 space-y-3">
                                <ToggleRow title="Include prices when sharing" description="Otherwise each piece says “Price on request”."
                                    checked={withPrices} onChange={() => setWithPrices(v => !v)} />
                                <div className="grid gap-2 sm:grid-cols-3">
                                    <Button onClick={() => { void share(); }} icon={<Share2 size={15} />}>Share list</Button>
                                    {canInquire && <Button variant="primary" onClick={() => setMode('inquiry')} icon={<MessageSquarePlus size={15} />}>Start inquiry</Button>}
                                    {canCollect && <Button onClick={() => setMode('collection')} icon={<Library size={15} />}>Save as collection</Button>}
                                </div>
                            </div>

                            <button type="button" onClick={onClear} className="mx-auto flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)] hover:text-red-500 active-scale">
                                <Trash2 size={12} /> Clear the selection
                            </button>
                        </>
                    )}

                    {pieces.length > 0 && mode === 'inquiry' && (
                        <div className="neu-card p-4 space-y-4">
                            <p className="text-[12.5px] text-[var(--neu-text-dim)]">An inquiry for the {pieces.length} selected {pieces.length === 1 ? 'piece' : 'pieces'}. You can add details later in Inquiries.</p>
                            <Field label="Customer name *" htmlFor="sel-name">
                                <Input id="sel-name" value={customer.name} onChange={e => setCustomer(c => ({ ...c, name: e.target.value }))} autoComplete="off" />
                            </Field>
                            <div className="grid gap-4 sm:grid-cols-2">
                                <Field label="Phone *" htmlFor="sel-phone">
                                    <Input id="sel-phone" type="tel" value={customer.phone} onChange={e => setCustomer(c => ({ ...c, phone: e.target.value }))} autoComplete="off" />
                                </Field>
                                <Field label="Email" htmlFor="sel-email">
                                    <Input id="sel-email" type="email" value={customer.email} onChange={e => setCustomer(c => ({ ...c, email: e.target.value }))} autoComplete="off" />
                                </Field>
                            </div>
                            <Field label="How they reached us" htmlFor="sel-source">
                                <Select id="sel-source" value={customer.source} onChange={e => setCustomer(c => ({ ...c, source: e.target.value as Inquiry['source'] }))}>
                                    {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                                </Select>
                            </Field>
                            <Field label="Notes" htmlFor="sel-notes">
                                <Textarea id="sel-notes" rows={3} value={customer.notes} onChange={e => setCustomer(c => ({ ...c, notes: e.target.value }))} className="resize-none" />
                            </Field>
                            <Button variant="primary" block disabled={busy} onClick={() => { void createInquiry(); }}
                                icon={busy ? <Loader2 size={15} className="animate-spin" /> : <MessageSquarePlus size={15} />}>
                                Create inquiry
                            </Button>
                        </div>
                    )}

                    {pieces.length > 0 && mode === 'collection' && (
                        <div className="neu-card p-4 space-y-4">
                            <Field label="Collection name" htmlFor="sel-col" hint={`${pieces.length} ${pieces.length === 1 ? 'piece' : 'pieces'}, in this order.`}>
                                <Input id="sel-col" value={collectionName} onChange={e => setCollectionName(e.target.value)} placeholder="e.g. For the Mehta residence" />
                            </Field>
                            <Button variant="primary" block disabled={busy} onClick={() => { void createCollection(); }}
                                icon={busy ? <Loader2 size={15} className="animate-spin" /> : <Library size={15} />}>
                                Save collection
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </FullScreenPortal>
    );
};
