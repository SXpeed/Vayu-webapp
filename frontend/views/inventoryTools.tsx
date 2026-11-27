// Inventory screens beyond the list: settings (stock locations, statuses),
// moving stock, the stock panel on a piece, and the bulk-edit dialogs.

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowRightLeft, Plus } from 'lucide-react';
import { Button, Field, Input, Select, SectionTitle } from '../components/ui';
import { IfCan, useAppChrome } from '../components/Layout';
import { Modal, Sheet } from './billing/parts';
import type { Artwork, Collection } from '../types';
import {
    BASE_STATUSES, STATUS_COLORS, marginOf, newLocationId, newStatusId, stockByLocation, totalOf,
    type InventorySettings, type StatusColor, type StatusDef, type Stock,
} from '../inventoryRules';
import { getStockHistory, saveInventorySettings, useInventorySettings, type StockHistoryEntry } from '../services/inventorySettingsService';

export const STATUS_TEXT: Record<StatusColor, string> = {
    green: 'text-green-700 dark:text-green-400',
    amber: 'text-yellow-700 dark:text-yellow-400',
    red: 'text-red-700 dark:text-red-400',
    blue: 'text-blue-700 dark:text-blue-400',
    violet: 'text-violet-700 dark:text-violet-400',
    gray: 'text-gray-600 dark:text-gray-400',
};
const COLOR_NAME: Record<StatusColor, string> = { green: 'Green', amber: 'Amber', red: 'Red', blue: 'Blue', violet: 'Violet', gray: 'Grey' };

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** Inventory → ⚙: stock locations and statuses. Removing is archiving, so nothing that points at one breaks. */
export function InventorySettingsSheet({ onClose }: Readonly<{ onClose: () => void }>) {
    const saved = useInventorySettings();
    const [draft, setDraft] = useState<InventorySettings>(saved);
    const [saving, setSaving] = useState(false);
    const setLocation = (id: string, patch: Partial<InventorySettings['locations'][number]>) =>
        setDraft(d => ({ ...d, locations: d.locations.map(l => (l.id === id ? { ...l, ...patch } : l)) }));
    const setStatus = (id: string, patch: Partial<StatusDef>) =>
        setDraft(d => ({ ...d, statuses: d.statuses.map(s => (s.id === id ? { ...s, ...patch } : s)) }));
    const baseName = (b: string) => draft.statuses.find(s => s.id === b)?.name ?? b;

    const save = async () => {
        const blank = [...draft.locations, ...draft.statuses].some(x => !x.name.trim());
        if (blank) { toast.error('Give every location and status a name.'); return; }
        const names = (xs: { name: string }[]) => new Set(xs.map(x => x.name.trim().toLowerCase())).size !== xs.length;
        if (names(draft.locations) || names(draft.statuses)) { toast.error('Two locations or two statuses have the same name.'); return; }
        setSaving(true);
        try {
            await saveInventorySettings(draft);
            toast.success('Inventory settings saved');
            onClose();
        } catch (e) {
            toast.error((e as Error).message || 'Settings not saved');
        } finally {
            setSaving(false);
        }
    };

    const active = draft.locations.filter(l => !l.archived);
    const archived = draft.locations.filter(l => l.archived);
    return (
        <Sheet title="Inventory settings" onClose={onClose} close="close"
            actions={<Button variant="primary" onClick={() => { void save(); }} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>}>
            <section className="neu-card p-4 space-y-3">
                <SectionTitle actions={<Button icon={<Plus size={14} />} onClick={() => setDraft(d => ({ ...d, locations: [...d.locations, { id: newLocationId(), name: '' }] }))}>Add</Button>}>
                    Stock locations
                </SectionTitle>
                <p className="text-[12px] text-[var(--neu-text-dim)]">Stores, the office, a warehouse. Each piece counts its units at each. Sales take from the default unless you choose another.</p>
                {active.map(l => (
                    <div key={l.id} className="flex items-center gap-2">
                        <Input value={l.name} onChange={e => setLocation(l.id, { name: e.target.value })} placeholder="e.g. Store" aria-label="Location name" className="flex-1" />
                        <Button onClick={() => setDraft(d => ({ ...d, locations: d.locations.map(x => ({ ...x, isDefault: x.id === l.id || undefined })) }))}
                            variant={l.isDefault ? 'primary' : 'default'} aria-pressed={!!l.isDefault}>Default</Button>
                        {!l.isDefault && <Button onClick={() => setLocation(l.id, { archived: true })}>Archive</Button>}
                    </div>
                ))}
                {archived.length > 0 && (
                    <div className="pt-2 space-y-2">
                        <p className="text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)]">Archived</p>
                        {archived.map(l => (
                            <div key={l.id} className="flex items-center gap-2 opacity-75">
                                <span className="flex-1 text-sm text-[var(--neu-text)] truncate">{l.name}</span>
                                <Button onClick={() => setLocation(l.id, { archived: undefined })}>Restore</Button>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section className="neu-card p-4 space-y-3">
                <SectionTitle actions={<Button icon={<Plus size={14} />} onClick={() => setDraft(d => ({ ...d, statuses: [...d.statuses, { id: newStatusId(), name: '', behaves: 'Reserved', color: 'blue' }] }))}>Add</Button>}>
                    Statuses
                </SectionTitle>
                <p className="text-[12px] text-[var(--neu-text-dim)]">
                    Your own statuses, such as On loan or At the framer. Each works like one of the three built in: like {baseName('Available')} it can be sold, like {baseName('Reserved')} it can't until you change it, like {baseName('Sold')} it holds no stock.
                </p>
                {draft.statuses.filter(s => !s.archived).map(s => {
                    const builtIn = s.id === s.behaves;
                    return (
                        <div key={s.id} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_12rem_7rem_auto] gap-2 items-center">
                            <Input value={s.name} onChange={e => setStatus(s.id, { name: e.target.value })} placeholder="e.g. On loan" aria-label="Status name" />
                            {builtIn
                                ? <span className="hidden sm:block text-[12px] text-[var(--neu-text-dim)]">Built in</span>
                                : (
                                    <Select value={s.behaves} onChange={e => setStatus(s.id, { behaves: e.target.value as StatusDef['behaves'] })} aria-label={`${s.name || 'Status'} works like`}>
                                        {BASE_STATUSES.map(b => <option key={b} value={b}>Like {baseName(b)}</option>)}
                                    </Select>
                                )}
                            <Select value={s.color} onChange={e => setStatus(s.id, { color: e.target.value as StatusColor })} aria-label={`${s.name || 'Status'} colour`} className={STATUS_TEXT[s.color]}>
                                {STATUS_COLORS.map(c => <option key={c} value={c}>{COLOR_NAME[c]}</option>)}
                            </Select>
                            {builtIn ? <span className="sm:hidden" /> : <Button onClick={() => setStatus(s.id, { archived: true })}>Archive</Button>}
                        </div>
                    );
                })}
                {draft.statuses.some(s => s.archived) && (
                    <div className="pt-2 space-y-2">
                        <p className="text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)]">Archived</p>
                        {draft.statuses.filter(s => s.archived).map(s => (
                            <div key={s.id} className="flex items-center gap-2 opacity-75">
                                <span className="flex-1 text-sm text-[var(--neu-text)] truncate">{s.name}</span>
                                <Button onClick={() => setStatus(s.id, { archived: undefined })}>Restore</Button>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </Sheet>
    );
}

/** Units from one location to another. */
export function MoveStockModal({ artwork, onClose, onMove }: Readonly<{ artwork: Artwork; onClose: () => void; onMove: (stock: Stock, note: string) => void }>) {
    const settings = useInventorySettings();
    const stock = stockByLocation(artwork, settings);
    const holding = settings.locations.filter(l => stock[l.id]);
    const [from, setFrom] = useState(holding[0]?.id ?? '');
    const targets = settings.locations.filter(l => !l.archived && l.id !== from);
    const [to, setTo] = useState(targets[0]?.id ?? '');
    const [qtyText, setQtyText] = useState(String(stock[from] ?? 1));
    const [note, setNote] = useState('');
    const qty = Math.floor(Number(qtyText));
    const ok = !!from && !!to && from !== to && qty >= 1 && qty <= (stock[from] ?? 0);
    const name = (id: string) => settings.locations.find(l => l.id === id)?.name ?? '';
    const submit = () => {
        if (!ok) return;
        const next = { ...stock, [from]: stock[from] - qty, [to]: (stock[to] ?? 0) + qty };
        onMove(Object.fromEntries(Object.entries(next).filter(([, n]) => n > 0)), [`Moved ${qty} from ${name(from)} to ${name(to)}`, note.trim()].filter(Boolean).join(': '));
    };
    if (holding.length === 0 || settings.locations.filter(l => !l.archived).length < 2) {
        return (
            <Modal title="Move stock" onClose={onClose} footer={<Button onClick={onClose}>OK</Button>}>
                <p className="text-sm text-[var(--neu-text)]">{holding.length === 0 ? 'This piece has no stock to move.' : 'Add another location in Inventory settings first.'}</p>
            </Modal>
        );
    }
    return (
        <Modal title="Move stock" onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} onClick={submit}>Move</Button></>}>
            <div className="grid grid-cols-2 gap-3">
                <Field label="From" htmlFor="move-from">
                    <Select id="move-from" value={from} onChange={e => { setFrom(e.target.value); setQtyText(String(stock[e.target.value] ?? 1)); if (e.target.value === to) setTo(''); }}>
                        {holding.map(l => <option key={l.id} value={l.id}>{l.name} ({stock[l.id]})</option>)}
                    </Select>
                </Field>
                <Field label="To" htmlFor="move-to">
                    <Select id="move-to" value={to} onChange={e => setTo(e.target.value)}>
                        <option value="" disabled>Choose…</option>
                        {targets.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                </Field>
            </div>
            <Field label="How many" htmlFor="move-qty" hint={`${stock[from] ?? 0} at ${name(from)}`}>
                <Input id="move-qty" type="number" min={1} max={stock[from] ?? 1} step={1} inputMode="numeric" value={qtyText} onChange={e => setQtyText(e.target.value)} />
            </Field>
            <Field label="Note (optional)" htmlFor="move-note">
                <Input id="move-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. For the weekend show" maxLength={120} />
            </Field>
        </Modal>
    );
}

const when = (at: number) => new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The stock history: loading, nothing yet, or each change with who and when. */
function HistoryList({ history, name }: Readonly<{ history: StockHistoryEntry[] | null; name: (id: string) => string }>) {
    if (history === null) return <p className="text-[12px] text-[var(--neu-text-dim)]">Loading…</p>;
    if (history.length === 0) return <p className="text-[12px] text-[var(--neu-text-dim)]">No changes recorded yet (history starts with this update).</p>;
    return (
        <ul className="space-y-2">
            {history.map(h => (
                <li key={`${h.at}|${h.note}|${JSON.stringify(h.change)}`} className="text-[12.5px] text-[var(--neu-text)]">
                    <span className="tabular-nums">{Object.entries(h.change).map(([id, n]) => `${n > 0 ? '+' : ''}${n} ${name(id)}`).join(', ')}</span>
                    {h.note && <span className="text-[var(--neu-text-dim)]"> · {h.note}</span>}
                    <span className="block text-[11px] text-[var(--neu-text-dim)]">{when(h.at)}{h.byName ? ` · ${h.byName}` : ''}</span>
                </li>
            ))}
        </ul>
    );
}

/** On a piece: units by location, cost and margin (if the role sees them), Move, and the stock history. */
export function StockPanel({ artwork, onUpdateArtwork }: Readonly<{ artwork: Artwork; onUpdateArtwork: (a: Artwork) => void }>) {
    const settings = useInventorySettings();
    const { can } = useAppChrome();
    const stock = stockByLocation(artwork, settings);
    const [moving, setMoving] = useState(false);
    const [history, setHistory] = useState<StockHistoryEntry[] | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const name = (id: string) => settings.locations.find(l => l.id === id)?.name ?? 'Removed location';
    const margin = can('costs') ? marginOf(artwork.price, artwork.costPrice) : null;
    const stamp = `${artwork.quantity}|${JSON.stringify(artwork.stock)}`;

    useEffect(() => {
        if (!showHistory) return;
        let current = true;
        setHistory(null);
        getStockHistory(artwork.id).then(h => { if (current) setHistory(h); }).catch(() => { if (current) setHistory([]); });
        return () => { current = false; };
    }, [artwork.id, showHistory, stamp]);

    const rows = settings.locations.filter(l => stock[l.id]);
    const strays = Object.keys(stock).filter(id => !settings.locations.some(l => l.id === id));
    return (
        <div className="mt-7 pt-6 border-t border-[var(--neu-line)] space-y-3">
            <div className="flex items-center justify-between gap-2">
                <h2 className="text-[11px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">Stock · {totalOf(stock)}</h2>
                <IfCan section="inventory">
                    {totalOf(stock) > 0 && <Button icon={<ArrowRightLeft size={14} />} onClick={() => setMoving(true)}>Move</Button>}
                </IfCan>
            </div>
            {rows.length + strays.length === 0
                ? <p className="text-sm text-[var(--neu-text-dim)]">None in stock.</p>
                : (
                    <ul className="text-sm text-[var(--neu-text)] divide-y divide-[var(--neu-line)]">
                        {[...rows.map(l => [l.id, l.name] as const), ...strays.map(id => [id, 'Removed location'] as const)].map(([id, label]) => (
                            <li key={id} className="flex justify-between py-1.5"><span>{label}</span><span className="tabular-nums">{stock[id]}</span></li>
                        ))}
                    </ul>
                )}
            {can('costs') && (artwork.costPrice ?? 0) > 0 && (
                <p className="text-[12.5px] text-[var(--neu-text-dim)]">
                    Cost {rupees(artwork.costPrice!)}{margin && <> · margin {rupees(margin.amount)} ({margin.percent}%)</>}
                </p>
            )}
            <button type="button" onClick={() => setShowHistory(v => !v)} className="text-[12px] underline text-[var(--neu-text-dim)]" aria-expanded={showHistory}>
                {showHistory ? 'Hide stock history' : 'Stock history'}
            </button>
            {showHistory && <HistoryList history={history} name={name} />}
            {moving && (
                <MoveStockModal artwork={artwork} onClose={() => setMoving(false)} onMove={(next, note) => {
                    onUpdateArtwork({ ...artwork, stock: next, quantity: totalOf(next), stockNote: note, stockSeen: { status: artwork.status, quantity: artwork.quantity ?? totalOf(stock) } });
                    setMoving(false);
                    toast.success(note.split(':')[0]);
                }} />
            )}
        </div>
    );
}

// ── Bulk edit dialogs ───────────────────────────────────────────────────────

export function BulkMoveModal({ count, onClose, onMove }: Readonly<{ count: number; onClose: () => void; onMove: (locationId: string) => void }>) {
    const settings = useInventorySettings();
    const active = settings.locations.filter(l => !l.archived);
    const [to, setTo] = useState(active[0]?.id ?? '');
    return (
        <Modal title={`Move ${count} ${count === 1 ? 'piece' : 'pieces'}`} onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!to} onClick={() => onMove(to)}>Move</Button></>}>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">Every unit of each piece goes to this location.</p>
            <Field label="To" htmlFor="bulk-move-to">
                <Select id="bulk-move-to" value={to} onChange={e => setTo(e.target.value)}>
                    {active.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </Select>
            </Field>
        </Modal>
    );
}

export function BulkStatusModal({ count, onClose, onSet }: Readonly<{ count: number; onClose: () => void; onSet: (status: StatusDef) => void }>) {
    const settings = useInventorySettings();
    const choices = settings.statuses.filter(s => !s.archived);
    const [id, setId] = useState(choices[0]?.id ?? 'Available');
    const chosen = choices.find(s => s.id === id);
    return (
        <Modal title={`Status of ${count} ${count === 1 ? 'piece' : 'pieces'}`} onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!chosen} onClick={() => chosen && onSet(chosen)}>Change</Button></>}>
            <Field label="Status" htmlFor="bulk-status">
                <Select id="bulk-status" value={id} onChange={e => setId(e.target.value)}>
                    {choices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
            </Field>
            {chosen?.behaves === 'Sold' && <p className="text-[12.5px] text-[var(--neu-text-dim)]">Their stock goes to 0.</p>}
            {chosen?.behaves === 'Available' && <p className="text-[12.5px] text-[var(--neu-text-dim)]">Pieces with nothing in stock are left as they are.</p>}
        </Modal>
    );
}

export function BulkPriceModal({ count, onClose, onSet }: Readonly<{ count: number; onClose: () => void; onSet: (price: (old: number) => number) => void }>) {
    const [mode, setMode] = useState<'set' | 'percent'>('percent');
    const [text, setText] = useState('');
    const n = Number(text);
    const ok = text.trim() !== '' && Number.isFinite(n) && (mode === 'set' ? n >= 0 : n > -100);
    return (
        <Modal title={`Price of ${count} ${count === 1 ? 'piece' : 'pieces'}`} onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} onClick={() => onSet(mode === 'set' ? () => n : old => Math.max(0, Math.round(old * (1 + n / 100))))}>Change</Button></>}>
            <Field label="Change by" htmlFor="bulk-price-mode">
                <Select id="bulk-price-mode" value={mode} onChange={e => setMode(e.target.value as 'set' | 'percent')}>
                    <option value="percent">Percent (+10 raises, -10 lowers)</option>
                    <option value="set">Set one price for all (₹)</option>
                </Select>
            </Field>
            <Field label={mode === 'set' ? 'Price (₹)' : 'Percent'} htmlFor="bulk-price">
                <Input id="bulk-price" type="number" inputMode="decimal" value={text} onChange={e => setText(e.target.value)} placeholder={mode === 'set' ? 'e.g. 25000' : 'e.g. 10'} />
            </Field>
        </Modal>
    );
}

export function AddToCollectionModal({ count, collections, onClose, onAdd }: Readonly<{ count: number; collections: Collection[]; onClose: () => void; onAdd: (c: Collection) => void }>) {
    const [id, setId] = useState(collections[0]?.id ?? '');
    const chosen = collections.find(c => c.id === id);
    return (
        <Modal title={`Add ${count} to a collection`} onClose={onClose}
            footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!chosen} onClick={() => chosen && onAdd(chosen)}>Add</Button></>}>
            {collections.length === 0
                ? <p className="text-sm text-[var(--neu-text)]">There are no collections yet. Make one in Collections first.</p>
                : (
                    <Field label="Collection" htmlFor="bulk-collection">
                        <Select id="bulk-collection" value={id} onChange={e => setId(e.target.value)}>
                            {collections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.artworkIds.length})</option>)}
                        </Select>
                    </Field>
                )}
        </Modal>
    );
}
