// The client's private viewing room: enter the passcode, browse the chosen
// artworks, tick the ones you like and send an inquiry. Talks only to
// /api/viewing/:token/* (see frontend/viewingRooms.ts).
import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ImageOff, Lock, Send, X } from 'lucide-react';
import { Button, Card, Field, Input, Textarea } from '../components/ui';

interface RoomInfo { name: string; clientName: string; message: string; sharedBy: string; showPrices: boolean; expiresAt: number }
interface RoomArtwork {
    id: string; title: string; artist?: string; year?: string; medium?: string; dimensions?: string; description?: string;
    availability: 'available' | 'reserved' | 'sold'; price?: number; plusGst?: boolean;
    images: { full: string; thumb: string }[];
}
interface Opened { room: RoomInfo; artworks: RoomArtwork[]; pass: string; passExpiresAt: number }

/**
 * The secret from /room/<token>, or /room/<workspace>/<token> for a room in a
 * workspace (on the dev server: /room.html?t=…&w=…).
 */
function roomFromUrl(): { token: string; workspace: string | null } {
    const match = /^\/room\/(?:([A-Za-z0-9-]{1,64})\/)?([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname);
    if (match) return { token: match[2], workspace: match[1] ?? null };
    const params = new URLSearchParams(location.search);
    const workspace = params.get('w');
    return { token: params.get('t') ?? '', workspace: workspace && /^[A-Za-z0-9-]{1,64}$/.test(workspace) ? workspace : null };
}

const ROOM = roomFromUrl();
const API = ROOM.workspace ? `/api/o/${ROOM.workspace}` : '/api';

function tokenFromUrl(): string {
    return ROOM.token;
}

const passKey = (token: string) => `viewing-pass:${token}`;

function rememberPass(token: string, pass: string, expiresAt: number) {
    try { sessionStorage.setItem(passKey(token), JSON.stringify({ pass, expiresAt })); } catch { /* private mode: ask again next time */ }
}

function heldPass(token: string): string | null {
    try {
        const held = JSON.parse(sessionStorage.getItem(passKey(token)) ?? 'null') as { pass: string; expiresAt: number } | null;
        return held && held.expiresAt > Date.now() + 60_000 ? held.pass : null;
    } catch { return null; }
}

async function post<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
    try {
        const res = await fetch(`${API}/viewing/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return { ok: true, data: data as T };
        return { ok: false, status: res.status, message: (data as { error?: string }).error || 'Something went wrong. Please try again.' };
    } catch {
        return { ok: false, status: 0, message: 'You seem to be offline. Check your connection and try again.' };
    }
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

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

export const RoomPage: React.FC = () => {
    const token = tokenFromUrl();
    const [phase, setPhase] = useState<'loading' | 'passcode' | 'room' | 'gone'>('loading');
    const [opened, setOpened] = useState<Opened | null>(null);
    const [goneMessage, setGoneMessage] = useState('');

    const accept = useCallback((data: Opened) => {
        rememberPass(token, data.pass, data.passExpiresAt);
        setOpened(data);
        setPhase('room');
        document.title = data.room.name;
    }, [token]);

    // A reload re-opens with the pass this tab already holds.
    useEffect(() => {
        if (!token) { setGoneMessage('This link is incomplete. Please open it again from your message.'); setPhase('gone'); return; }
        const pass = heldPass(token);
        if (!pass) { setPhase('passcode'); return; }
        void post<Opened>(`${token}/open`, { pass }).then(res => {
            if (res.ok) accept(res.data);
            else if (res.status === 404) { setGoneMessage(res.message); setPhase('gone'); }
            else setPhase('passcode');
        });
    }, [token, accept]);

    if (phase === 'loading') return <Centered><p className="text-sm text-gray-600 dark:text-gray-400">Opening…</p></Centered>;
    if (phase === 'gone') return <Centered><Gone message={goneMessage} /></Centered>;
    if (phase === 'passcode' || !opened) {
        return <Centered><PasscodeForm token={token} onOpened={accept} onGone={m => { setGoneMessage(m); setPhase('gone'); }} /></Centered>;
    }
    return <Room token={token} opened={opened} />;
};

const Centered: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="min-h-dvh flex items-center justify-center px-4 py-10">{children}</div>
);

const Gone: React.FC<{ message: string }> = ({ message }) => (
    <Card padding="lg" className="max-w-sm w-full text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full neu-inset flex items-center justify-center text-gray-500"><Lock size={20} /></div>
        <h1 className="font-serif text-xl text-gray-900 dark:text-gray-100">Not available</h1>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">{message}</p>
    </Card>
);

const PasscodeForm: React.FC<{ token: string; onOpened: (d: Opened) => void; onGone: (m: string) => void }> = ({ token, onOpened, onGone }) => {
    const [passcode, setPasscode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        const res = await post<Opened>(`${token}/open`, { passcode });
        setBusy(false);
        if (res.ok) onOpened(res.data);
        else if (res.status === 404) onGone(res.message);
        else setError(res.message);
    };
    return (
        <Card padding="lg" className="max-w-sm w-full">
            <form onSubmit={submit} className="text-center">
                <div className="w-12 h-12 mx-auto mb-4 rounded-full neu-inset flex items-center justify-center text-gold-700 dark:text-gold-300"><Lock size={20} /></div>
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-700 dark:text-gold-300">A private selection</p>
                <h1 className="mt-1 font-serif text-2xl text-gray-900 dark:text-gray-100">Enter your passcode</h1>
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">It came with the link, in the message you received.</p>
                <label htmlFor="room-passcode" className="sr-only">Passcode</label>
                <Input id="room-passcode" value={passcode} autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                    onChange={e => setPasscode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className="mt-5 text-center text-2xl tracking-[0.5em] font-medium tabular-nums" placeholder="••••••" />
                {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
                <Button type="submit" variant="primary" block className="mt-5" disabled={busy || passcode.length !== 6}>
                    {busy ? 'Opening…' : 'Open'}
                </Button>
            </form>
        </Card>
    );
};

const Availability: React.FC<{ art: RoomArtwork }> = ({ art }) =>
    art.availability === 'available' ? null : (
        <span className="neu-status text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded-full">
            {art.availability === 'sold' ? 'Sold' : 'Reserved'}
        </span>
    );

const Price: React.FC<{ art: RoomArtwork; showPrices: boolean }> = ({ art, showPrices }) => {
    if (art.availability === 'sold') return null;
    if (showPrices && art.price) {
        return <p className="text-sm font-medium text-gray-900 dark:text-gray-100 tabular-nums">{inr(art.price)}{art.plusGst && <span className="text-[11px] font-light text-gray-600 dark:text-gray-400"> + GST</span>}</p>;
    }
    return <p className="text-sm font-light text-gray-700 dark:text-gray-300">Price on request</p>;
};

/** A photo that shows a quiet placeholder when it can't load (or there is none). */
const Photo: React.FC<{ src?: string; fallback?: string; alt: string; className: string }> = ({ src, fallback, alt, className }) => {
    const [current, setCurrent] = useState(src);
    useEffect(() => setCurrent(src), [src]);
    if (!current) {
        return <div className={`${className} flex items-center justify-center neu-inset text-gray-400`}><ImageOff size={22} strokeWidth={1.5} /></div>;
    }
    return <img src={current} alt={alt} className={className} loading="lazy" decoding="async"
        onError={() => setCurrent(current === fallback || !fallback ? undefined : fallback)} />;
};

const Room: React.FC<{ token: string; opened: Opened }> = ({ token, opened }) => {
    const { room, artworks, pass } = opened;
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [viewing, setViewing] = useState<RoomArtwork | null>(null);
    const [asking, setAsking] = useState(false);
    const [sent, setSent] = useState(false);
    const toggle = (id: string) => setSelected(s => toggled(s, id));
    const until = new Date(room.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

    return (
        <div className="min-h-dvh pb-32">
            <header className="max-w-5xl mx-auto px-4 sm:px-6 pt-10 sm:pt-14 pb-6">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-700 dark:text-gold-300">A private selection{room.clientName ? ` for ${room.clientName}` : ''}</p>
                <h1 className="mt-2 font-serif text-3xl sm:text-4xl text-gray-900 dark:text-gray-100 break-words">{room.name}</h1>
                {room.message && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre-line">{room.message}</p>}
                <p className="mt-4 text-[12px] text-gray-600 dark:text-gray-400">
                    {room.sharedBy ? `Shared by ${room.sharedBy} · ` : ''}This link works until {until}.
                </p>
            </header>

            {sent && (
                <div className="max-w-5xl mx-auto px-4 sm:px-6 mb-6">
                    <Card className="flex items-start gap-3">
                        <CheckCircle2 size={20} className="text-green-600 shrink-0 mt-0.5" />
                        <div>
                            <p className="font-medium text-gray-900 dark:text-gray-100">Thank you, your inquiry is on its way.</p>
                            <p className="text-sm text-gray-700 dark:text-gray-300">We will be in touch shortly.</p>
                        </div>
                    </Card>
                </div>
            )}

            <main className="max-w-5xl mx-auto px-4 sm:px-6 grid gap-5 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {artworks.map(art => {
                    const isSelected = selected.has(art.id);
                    const canAsk = art.availability !== 'sold';
                    return (
                        <Card key={art.id} padding="none" className="overflow-hidden flex flex-col">
                            <button type="button" onClick={() => setViewing(art)} className="block w-full aspect-[4/5] overflow-hidden" aria-label={`View ${art.title}`}>
                                <Photo src={art.images[0]?.thumb} fallback={art.images[0]?.full} alt={art.title} className="w-full h-full object-cover" />
                            </button>
                            <div className="p-4 flex-1 flex flex-col gap-1">
                                <div className="flex items-start justify-between gap-2">
                                    <h2 className="font-serif text-lg leading-snug text-gray-900 dark:text-gray-100 break-words">{art.title}</h2>
                                    <Availability art={art} />
                                </div>
                                {(art.artist || art.year) && <p className="text-sm text-gray-700 dark:text-gray-300">{[art.artist, art.year].filter(Boolean).join(', ')}</p>}
                                {(art.medium || art.dimensions) && <p className="text-[12px] font-light text-gray-600 dark:text-gray-400">{[art.medium, art.dimensions].filter(Boolean).join(' · ')}</p>}
                                <div className="mt-auto pt-3 flex items-end justify-between gap-2">
                                    <Price art={art} showPrices={room.showPrices} />
                                    {canAsk && (
                                        <button type="button" onClick={() => toggle(art.id)} aria-pressed={isSelected}
                                            className={`neu-pill text-[12px] inline-flex items-center gap-1.5 ${isSelected ? 'neu-pill-active' : ''}`}>
                                            {isSelected && <Check size={13} />} {isSelected ? 'Interested' : "I'm interested"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </Card>
                    );
                })}
            </main>

            {selected.size > 0 && !asking && (
                <div className="fixed inset-x-0 bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 z-30">
                    <div className="max-w-md mx-auto neu-raised rounded-2xl p-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-gray-800 dark:text-gray-200">{selected.size} selected</p>
                        <Button variant="primary" onClick={() => setAsking(true)} icon={<Send size={15} />}>Send inquiry</Button>
                    </div>
                </div>
            )}

            {viewing && <Viewer art={viewing} showPrices={room.showPrices} onClose={() => setViewing(null)}
                selected={selected.has(viewing.id)} onToggle={() => toggle(viewing.id)} />}
            {asking && (
                <InterestForm token={token} pass={pass} artworks={artworks.filter(a => selected.has(a.id))} clientName={room.clientName}
                    onClose={() => setAsking(false)} onSent={() => { setAsking(false); setSent(true); setSelected(new Set()); scrollTo({ top: 0, behavior: 'smooth' }); }} />
            )}
        </div>
    );
};

const Viewer: React.FC<{ art: RoomArtwork; showPrices: boolean; selected: boolean; onToggle: () => void; onClose: () => void }> = ({ art, showPrices, selected, onToggle, onClose }) => {
    const [index, setIndex] = useState(0);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        addEventListener('keydown', onKey);
        return () => removeEventListener('keydown', onKey);
    }, [onClose]);
    const image = art.images[index];
    return (
        <div className="fixed inset-0 z-40 bg-[var(--neu-bg)] overflow-y-auto" role="dialog" aria-modal="true" aria-label={art.title}>
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex justify-end">
                <button type="button" onClick={onClose} className="neu-icon-btn" aria-label="Close"><X size={18} /></button>
            </div>
            <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-12 grid gap-6 lg:grid-cols-[3fr_2fr] items-start">
                <div>
                    <div className="relative neu-inset rounded-2xl overflow-hidden flex items-center justify-center min-h-[40vh]">
                        <Photo src={image?.full} alt={art.title} className="max-h-[75vh] w-auto max-w-full object-contain" />
                        {art.images.length > 1 && (
                            <>
                                <button type="button" onClick={() => setIndex(i => (i - 1 + art.images.length) % art.images.length)} className="absolute left-3 neu-icon-btn" aria-label="Previous photo"><ArrowLeft size={16} /></button>
                                <button type="button" onClick={() => setIndex(i => (i + 1) % art.images.length)} className="absolute right-3 neu-icon-btn" aria-label="Next photo"><ArrowRight size={16} /></button>
                            </>
                        )}
                    </div>
                    {art.images.length > 1 && <p className="mt-2 text-center text-[12px] text-gray-600 dark:text-gray-400">{index + 1} / {art.images.length}</p>}
                </div>
                <div className="space-y-2">
                    <Availability art={art} />
                    <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100 break-words">{art.title}</h2>
                    {(art.artist || art.year) && <p className="text-gray-700 dark:text-gray-300">{[art.artist, art.year].filter(Boolean).join(', ')}</p>}
                    {art.medium && <p className="text-sm text-gray-700 dark:text-gray-300">{art.medium}</p>}
                    {art.dimensions && <p className="text-sm text-gray-700 dark:text-gray-300">{art.dimensions}</p>}
                    <div className="pt-2"><Price art={art} showPrices={showPrices} /></div>
                    {art.description && <p className="pt-2 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre-line">{art.description}</p>}
                    {art.availability !== 'sold' && (
                        <div className="pt-4">
                            <Button variant={selected ? 'default' : 'primary'} onClick={onToggle} icon={selected ? <Check size={15} /> : undefined}>
                                {selected ? 'Added to your inquiry' : "I'm interested"}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const InterestForm: React.FC<{ token: string; pass: string; artworks: RoomArtwork[]; clientName: string; onClose: () => void; onSent: () => void }> = ({ token, pass, artworks, clientName, onClose, onSent }) => {
    const [name, setName] = useState(clientName);
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        const res = await post(`${token}/interest`, { pass, name, phone, email, message, artworkIds: artworks.map(a => a.id) });
        setBusy(false);
        if (res.ok) onSent();
        else setError(res.status === 401 ? 'This page has been open a long time. Reload it, enter the passcode again, then send.' : res.message);
    };
    return (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px] flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Send an inquiry">
            <Card padding="lg" className="w-full sm:max-w-md rounded-b-none sm:rounded-b-[inherit] max-h-[92dvh] overflow-y-auto">
                <form onSubmit={submit} className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <h2 className="font-serif text-xl text-gray-900 dark:text-gray-100">Send an inquiry</h2>
                            <p className="text-sm text-gray-700 dark:text-gray-300">About {artworks.length === 1 ? artworks[0].title : `${artworks.length} works`}</p>
                        </div>
                        <button type="button" onClick={onClose} className="neu-icon-btn shrink-0" aria-label="Close"><X size={16} /></button>
                    </div>
                    <Field label="Your name" htmlFor="ri-name"><Input id="ri-name" value={name} onChange={e => setName(e.target.value)} autoComplete="name" required /></Field>
                    <Field label="Phone" htmlFor="ri-phone"><Input id="ri-phone" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" /></Field>
                    <Field label="Email" htmlFor="ri-email" hint="A phone number or an email, so we can reply."><Input id="ri-email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></Field>
                    <Field label="Message (optional)" htmlFor="ri-message"><Textarea id="ri-message" value={message} onChange={e => setMessage(e.target.value)} rows={3} placeholder="Questions, a good time to call, a visit…" /></Field>
                    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                    <Button type="submit" variant="primary" block disabled={busy || !name.trim() || (!phone.trim() && !email.trim())} icon={<Send size={15} />}>
                        {busy ? 'Sending…' : 'Send inquiry'}
                    </Button>
                </form>
            </Card>
        </div>
    );
};
