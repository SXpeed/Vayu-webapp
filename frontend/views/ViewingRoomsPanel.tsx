// Private viewing rooms, the staff side: curate artworks for one client, share
// a secret link and passcode, see views and inquiries, switch a room off.
// The client's page is room/RoomPage.tsx; the rules are in viewingRooms.ts.
import React, { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Check, Copy, Eye, Image as ImageIcon, KeyRound, Lock, MessageCircle, Pencil, Plus, Power, Share2, Trash2, X } from 'lucide-react';
import { Artwork } from '../types';
import { apiCall } from '../services/apiClient';
import { getThumbUrl } from '../services/storageService';
import { SearchBar } from '../components/SearchBar';
import { Button, Card, Field, Input, Textarea, ToggleRow } from '../components/ui';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { IfCan } from '../components/Layout';

interface StaffRoom {
    id: string; token: string; name: string; clientName: string; clientPhone: string; clientEmail: string; message: string;
    artworkIds: string[]; showPrices: boolean; expiresAt: number; status: 'active' | 'expired' | 'off';
    viewCount: number; lastViewedAt: number | null; inquiryCount: number; createdByName: string; createdAt: number;
    /** Only right after creating the room or making a new passcode. */
    passcode?: string;
}

const EXPIRY_CHOICES = [7, 14, 30, 90];

/** The client's address for a room. The dev server has no /room/:token route, so it uses room.html?t=. */
export function roomLink(token: string): string {
    return import.meta.env.DEV ? `${location.origin}/room.html?t=${token}` : `${location.origin}/room/${token}`;
}

/** A copy of the set with this id added or removed. */
function toggled(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function shareText(room: StaffRoom, passcode: string): string {
    const hello = room.clientName ? `Hello ${room.clientName}, here` : 'Here';
    return `${hello} is a private selection of works I put together for you:\n${roomLink(room.token)}\n\nPasscode: ${passcode}\n(The link works until ${day(room.expiresAt)}.)`;
}

async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); }
    catch { toast.error("Couldn't copy. Select the text and copy it instead."); }
}

const STATUS: Record<StaffRoom['status'], { label: string; cls: string }> = {
    active: { label: 'Active', cls: 'text-green-700 dark:text-green-400' },
    expired: { label: 'Expired', cls: 'text-amber-700 dark:text-amber-400' },
    off: { label: 'Switched off', cls: 'text-gray-600 dark:text-gray-400' },
};

export const ViewingRoomsPanel: React.FC<{ artworks: Artwork[]; onClose: () => void }> = ({ artworks, onClose }) => {
    const [rooms, setRooms] = useState<StaffRoom[] | null>(null);
    const [editing, setEditing] = useState<StaffRoom | 'new' | null>(null);
    const [sharing, setSharing] = useState<StaffRoom | null>(null);
    const [deleting, setDeleting] = useState<StaffRoom | null>(null);

    const load = async () => {
        try { setRooms(await apiCall<StaffRoom[]>('/viewing-rooms')); }
        catch (e) { toast.error((e as Error).message); setRooms([]); }
    };
    useEffect(() => { void load(); }, []);

    const patch = async (room: StaffRoom, body: Record<string, unknown>, done?: string) => {
        try {
            const updated = await apiCall<StaffRoom>(`/viewing-rooms/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
            setRooms(list => list?.map(r => r.id === room.id ? updated : r) ?? null);
            if (updated.passcode) setSharing(updated);
            else if (done) toast.success(done);
        } catch (e) { toast.error((e as Error).message); }
    };

    const remove = async (room: StaffRoom) => {
        try {
            await apiCall(`/viewing-rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
            setRooms(list => list?.filter(r => r.id !== room.id) ?? null);
            toast.success('Private room deleted');
        } catch (e) { toast.error((e as Error).message); }
    };

    if (editing) {
        return (
            <RoomForm artworks={artworks} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
                onSaved={(saved) => {
                    setRooms(list => {
                        const rest = (list ?? []).filter(r => r.id !== saved.id);
                        return editing === 'new' ? [saved, ...rest] : (list ?? []).map(r => r.id === saved.id ? saved : r);
                    });
                    setEditing(null);
                    if (saved.passcode) setSharing(saved);
                    else toast.success('Private room saved');
                }} />
        );
    }

    return (
        <div className="neu-sheet z-[70] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+env(safe-area-inset-top,0px))]">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Close"><X size={20} /></button>
                <h2 className="flex-1 text-center text-base font-serif text-gray-900 dark:text-white">Private rooms</h2>
                <IfCan section="catalogs" level="edit">
                    <button onClick={() => setEditing('new')} className="neu-icon-btn text-gold-700 dark:text-gold-300 active-scale" aria-label="New private room"><Plus size={20} /></button>
                </IfCan>
            </div>
            <div className="flex-1 overflow-y-auto p-3 no-scrollbar">
                <p className="text-[12px] text-gray-700 dark:text-gray-300 mb-4 px-1 leading-relaxed">
                    Choose works for one client and send them a private link with a passcode. They can view the works and send an inquiry; it arrives in Inquiry.
                </p>
                {rooms === null && <p className="text-sm text-gray-600 dark:text-gray-400 px-1">Loading…</p>}
                {rooms?.length === 0 && (
                    <Card className="text-center">
                        <div className="w-12 h-12 mx-auto mb-3 rounded-full neu-inset flex items-center justify-center text-gold-700 dark:text-gold-300"><Lock size={20} /></div>
                        <p className="font-serif text-gray-900 dark:text-gray-100">No private rooms yet</p>
                        <IfCan section="catalogs" level="edit">
                            <Button variant="primary" className="mt-4" onClick={() => setEditing('new')} icon={<Plus size={15} />}>New private room</Button>
                        </IfCan>
                    </Card>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                    {rooms?.map(room => (
                        <RoomCard key={room.id} room={room} artworks={artworks}
                            onShare={() => setSharing(room)}
                            onEdit={() => setEditing(room)}
                            onNewPasscode={() => void patch(room, { newPasscode: true })}
                            onToggle={() => void patch(room, { isActive: room.status === 'off' }, room.status === 'off' ? 'Switched on' : 'Switched off')}
                            onExtend={() => void patch(room, { expiresInDays: 30, ...(room.status === 'off' ? { isActive: true } : {}) }, 'Link works for 30 more days')}
                            onDelete={() => setDeleting(room)} />
                    ))}
                </div>
            </div>
            {sharing && <ShareCard room={sharing} onClose={() => setSharing(null)} />}
            <TypeDeleteDialog
                isOpen={!!deleting}
                title="Delete private room"
                itemName={deleting?.name ?? ''}
                message="the link stops working at once; inquiries already sent stay in Inquiry"
                onClose={() => setDeleting(null)}
                onConfirm={() => { const r = deleting; setDeleting(null); if (r) void remove(r); }}
            />
        </div>
    );
};

const RoomCard: React.FC<{
    room: StaffRoom; artworks: Artwork[];
    onShare: () => void; onEdit: () => void; onNewPasscode: () => void; onToggle: () => void; onExtend: () => void; onDelete: () => void;
}> = ({ room, artworks, onShare, onEdit, onNewPasscode, onToggle, onExtend, onDelete }) => {
    const covers = room.artworkIds.map(id => artworks.find(a => a.id === id)).filter((a): a is Artwork => !!a).slice(0, 4);
    const status = STATUS[room.status];
    const action = 'neu-pill text-[11px] inline-flex items-center gap-1';
    return (
        <Card>
            <div className="flex items-start gap-3">
                <div className="flex -space-x-3 shrink-0">
                    {covers.length === 0 && <div className="w-11 h-11 rounded-lg neu-inset flex items-center justify-center text-gray-500"><ImageIcon size={16} /></div>}
                    {covers.map(a => a.imageUrls?.[0]
                        ? <img key={a.id} src={getThumbUrl(a.imageUrls[0])} alt="" className="w-11 h-11 rounded-lg object-cover ring-2 ring-[var(--neu-bg)]" loading="lazy" />
                        : <div key={a.id} className="w-11 h-11 rounded-lg neu-inset ring-2 ring-[var(--neu-bg)]" />)}
                </div>
                <div className="min-w-0 flex-1">
                    <p className={`text-[10px] font-bold uppercase tracking-widest ${status.cls}`}>{status.label}{room.status !== 'off' ? ` · until ${day(room.expiresAt)}` : ''}</p>
                    <h3 className="font-serif text-gray-900 dark:text-gray-100 break-words">{room.name}</h3>
                    <p className="text-[12px] text-gray-700 dark:text-gray-300">
                        {room.clientName ? `For ${room.clientName} · ` : ''}{room.artworkIds.length} work{room.artworkIds.length === 1 ? '' : 's'} · {room.showPrices ? 'prices shown' : 'price on request'}
                    </p>
                    <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400 inline-flex items-center gap-2">
                        <span className="inline-flex items-center gap-1"><Eye size={12} /> {room.viewCount} view{room.viewCount === 1 ? '' : 's'}</span>
                        <span className="inline-flex items-center gap-1"><MessageCircle size={12} /> {room.inquiryCount} inquir{room.inquiryCount === 1 ? 'y' : 'ies'}</span>
                    </p>
                </div>
            </div>
            <IfCan section="catalogs" level="edit">
                <div className="mt-3 flex flex-wrap gap-2">
                    {room.status === 'active' && <button type="button" className={action} onClick={onShare}><Share2 size={12} /> Share</button>}
                    <button type="button" className={action} onClick={onNewPasscode}><KeyRound size={12} /> New passcode</button>
                    {room.status !== 'active' && <button type="button" className={action} onClick={onExtend}>Reopen 30 days</button>}
                    {room.status === 'active' && <button type="button" className={action} onClick={onExtend}>+30 days</button>}
                    <button type="button" className={action} onClick={onToggle}><Power size={12} /> {room.status === 'off' ? 'Switch on' : 'Switch off'}</button>
                    <button type="button" className={action} onClick={onEdit}><Pencil size={12} /> Edit</button>
                    <button type="button" className={`${action} text-red-600 dark:text-red-400`} onClick={onDelete}><Trash2 size={12} /> Delete</button>
                </div>
            </IfCan>
        </Card>
    );
};

/** The link, and the passcode when it was just made, ready to send. */
const ShareCard: React.FC<{ room: StaffRoom; onClose: () => void }> = ({ room, onClose }) => {
    const link = roomLink(room.token);
    const text = room.passcode ? shareText(room, room.passcode) : null;
    const share = async () => {
        if (!text) return;
        if (navigator.share) {
            try { await navigator.share({ text }); return; } catch { /* cancelled: fall through to copy */ }
        }
        await copy(text, 'Message');
    };
    return (
        <div className="fixed inset-0 z-[80] bg-black/20 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Share the private room">
            <Card padding="lg" className="w-full sm:max-w-md rounded-b-none sm:rounded-b-[inherit] space-y-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="font-serif text-xl text-gray-900 dark:text-gray-100">Share with {room.clientName || 'your client'}</h3>
                        <p className="text-[12px] text-gray-700 dark:text-gray-300">Works until {day(room.expiresAt)}.</p>
                    </div>
                    <button type="button" onClick={onClose} className="neu-icon-btn shrink-0" aria-label="Close"><X size={16} /></button>
                </div>
                <Field label="Link" htmlFor="vr-link">
                    <div className="flex gap-2">
                        <Input id="vr-link" readOnly value={link} className="flex-1 min-w-0 text-[12px]" onFocus={e => e.currentTarget.select()} />
                        <Button onClick={() => void copy(link, 'Link')} icon={<Copy size={14} />} aria-label="Copy link" />
                    </div>
                </Field>
                {room.passcode ? (
                    <>
                        <div>
                            <p className="neu-label">Passcode</p>
                            <div className="flex items-center gap-2">
                                <p className="flex-1 neu-inset rounded-xl py-2 text-center text-2xl tracking-[0.4em] font-medium tabular-nums text-gray-900 dark:text-gray-100">{room.passcode}</p>
                                <Button onClick={() => void copy(room.passcode!, 'Passcode')} icon={<Copy size={14} />} aria-label="Copy passcode" />
                            </div>
                            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">Shown only now. Send it with the link; if it is lost, make a new one.</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="primary" onClick={() => void share()} icon={<Share2 size={15} />}>Share message</Button>
                            <a className="neu-button" href={`https://wa.me/?text=${encodeURIComponent(text!)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
                            <Button onClick={() => void copy(text!, 'Message')} icon={<Copy size={14} />}>Copy message</Button>
                        </div>
                    </>
                ) : (
                    <p className="text-[12px] text-gray-700 dark:text-gray-300">The passcode is only shown when it is made. To send it again, make a new passcode (the old one stops working).</p>
                )}
            </Card>
        </div>
    );
};

const RoomForm: React.FC<{ artworks: Artwork[]; initial: StaffRoom | null; onClose: () => void; onSaved: (room: StaffRoom) => void }> = ({ artworks, initial, onClose, onSaved }) => {
    const [name, setName] = useState(initial?.name ?? '');
    const [clientName, setClientName] = useState(initial?.clientName ?? '');
    const [clientPhone, setClientPhone] = useState(initial?.clientPhone ?? '');
    const [clientEmail, setClientEmail] = useState(initial?.clientEmail ?? '');
    const [message, setMessage] = useState(initial?.message ?? '');
    const [showPrices, setShowPrices] = useState(initial?.showPrices ?? false);
    const [days, setDays] = useState(30);
    const [selected, setSelected] = useState<Set<string>>(new Set(initial?.artworkIds ?? []));
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? artworks.filter(a => a.title.toLowerCase().includes(q) || a.customId.toLowerCase().includes(q) || (a.artist ?? '').toLowerCase().includes(q)) : artworks;
    }, [artworks, query]);
    const toggle = (id: string) => setSelected(s => toggled(s, id));
    const saveLabel = initial ? 'Save' : 'Create';

    const save = async () => {
        if (!name.trim()) { toast.error('Give the room a name'); return; }
        if (selected.size === 0) { toast.error('Choose at least one artwork'); return; }
        const details = { name, clientName, clientPhone, clientEmail, message, showPrices, artworkIds: artworks.filter(a => selected.has(a.id)).map(a => a.id) };
        setBusy(true);
        try {
            const saved = initial
                ? await apiCall<StaffRoom>(`/viewing-rooms/${encodeURIComponent(initial.id)}`, { method: 'PATCH', body: JSON.stringify({ details }) })
                : await apiCall<StaffRoom>('/viewing-rooms', { method: 'POST', body: JSON.stringify({ ...details, expiresInDays: days }) });
            onSaved(saved);
        } catch (e) { toast.error((e as Error).message); }
        finally { setBusy(false); }
    };

    return (
        <div className="neu-sheet z-[70] animate-fade-in-up">
            <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+env(safe-area-inset-top,0px))]">
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Back"><X size={20} /></button>
                <h2 className="flex-1 text-center text-base font-serif text-gray-900 dark:text-white">{initial ? 'Edit private room' : 'New private room'}</h2>
                <button onClick={() => void save()} disabled={busy} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    {busy ? 'Saving…' : saveLabel}
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 no-scrollbar flex flex-col gap-5">
                <Card className="space-y-4">
                    <Field label="Room name *" htmlFor="vr-name"><Input id="vr-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. For Mrs. Mehta — monsoon works" /></Field>
                    <div className="grid gap-4 sm:grid-cols-3">
                        <Field label="Client name" htmlFor="vr-client"><Input id="vr-client" value={clientName} onChange={e => setClientName(e.target.value)} /></Field>
                        <Field label="Phone" htmlFor="vr-phone"><Input id="vr-phone" value={clientPhone} onChange={e => setClientPhone(e.target.value)} inputMode="tel" /></Field>
                        <Field label="Email" htmlFor="vr-email"><Input id="vr-email" type="email" value={clientEmail} onChange={e => setClientEmail(e.target.value)} /></Field>
                    </div>
                    <Field label="Message to the client" htmlFor="vr-message" hint="Shown at the top of the room.">
                        <Textarea id="vr-message" value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="A few works I thought you would love…" />
                    </Field>
                    <ToggleRow title="Show prices" description={showPrices ? 'Listed prices are shown (not for sold works).' : 'Clients see "Price on request".'} checked={showPrices} onChange={() => setShowPrices(v => !v)} />
                    {!initial && (
                        <div>
                            <p className="neu-label">Link works for</p>
                            <div className="flex flex-wrap gap-2">
                                {EXPIRY_CHOICES.map(d => (
                                    <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d} className={`neu-pill text-[12px] ${days === d ? 'neu-pill-active' : ''}`}>{d} days</button>
                                ))}
                            </div>
                        </div>
                    )}
                </Card>

                <div>
                    <div className="flex justify-between items-end mb-3 px-1">
                        <h3 className="font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[11px]">Choose works</h3>
                        <span className="text-[11px] text-gray-700 dark:text-gray-300 uppercase tracking-wider">{selected.size} selected</span>
                    </div>
                    <SearchBar value={query} onChange={setQuery} placeholder="Search by title, artist or ID..." className="mb-4" />
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        {shown.map(art => {
                            const isSelected = selected.has(art.id);
                            return (
                                <button type="button" key={art.id} onClick={() => toggle(art.id)} aria-pressed={isSelected}
                                    className={`relative w-full text-left rounded-lg overflow-hidden border-2 transition-all neu-inset active-scale ${isSelected ? 'border-gold-500 shadow-md' : 'border-transparent'}`}>
                                    {art.imageUrls?.[0]
                                        ? <img loading="lazy" decoding="async" src={getThumbUrl(art.imageUrls[0])} alt={art.title} className="w-full h-32 object-cover" />
                                        : <div className="w-full h-32 flex items-center justify-center text-gray-500"><ImageIcon size={20} strokeWidth={1.5} /></div>}
                                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
                                        <p className="text-white text-[11px] font-serif truncate leading-[1.35]">{art.title}</p>
                                        {art.status !== 'Available' && <p className="text-white/80 text-[10px] uppercase tracking-wider">{art.status}</p>}
                                    </div>
                                    {isSelected && <div className="absolute top-1.5 right-1.5 bg-gold-500 text-white rounded-full p-1"><Check size={12} strokeWidth={3} /></div>}
                                </button>
                            );
                        })}
                        {shown.length === 0 && <p className="col-span-full text-center text-gray-600 dark:text-gray-300 py-6 text-xs">No artworks match "{query}".</p>}
                    </div>
                </div>
                <div className="h-10" />
            </div>
        </div>
    );
};
