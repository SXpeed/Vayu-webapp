import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Plus, Image as ImageIcon, X, Trash2, Loader2, Camera, Folder, Download, Upload, CheckSquare, Check } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, GhostIconButton, EmptyState, Button, Select } from '../components/ui';
import { Artwork, Collection, Edition, stockOf } from '../types';
import toast from 'react-hot-toast';
import storageService, { getThumbUrl } from '../services/storageService';
import { fileKeyOf } from '../services/workspace';
import { IfCan, useAppChrome } from '../components/Layout';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import { downloadCsv } from './attendance/attendanceUtils';
import { inventoryRows, planImport, readInventoryCsv, readInventoryTable, skippedNote, type ImportedArtwork } from './inventoryCsv';
import { readXlsx } from './inventoryXlsx';
import { useBackClose } from '../hooks/useBackClose';
import { useInventorySettings } from '../services/inventorySettingsService';
import { defaultLocation, marginOf, statusOf, stockByLocation, stockLabel, totalOf, type StatusDef } from '../inventoryRules';
import { AddToCollectionModal, BulkMoveModal, BulkPriceModal, BulkStatusModal, STATUS_TEXT } from './inventoryTools';


interface ArtworksViewProps {
    artworks: Artwork[];
    onAddArtwork: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => unknown;
    onUpdateArtwork: (artwork: Artwork) => unknown;
    onArtworkClick: (artwork: Artwork) => void;
    onDeleteArtwork?: (id: string) => unknown;
    collections?: Collection[];
    onUpdateCollection?: (collection: Collection) => unknown;
}

/** An .xlsx import waiting for a yes: each new or changed artwork with the photos it brings. */
interface PendingImport {
    items: { key: string; row: ImportedArtwork | Artwork; isNew: boolean; photos: File[] }[];
    notes: string[];
}

const SORTS = {
    newest: { label: 'Newest first', by: (a: Artwork, b: Artwork) => b.createdAt - a.createdAt },
    oldest: { label: 'Oldest first', by: (a: Artwork, b: Artwork) => a.createdAt - b.createdAt },
    priceHigh: { label: 'Price: high to low', by: (a: Artwork, b: Artwork) => b.price - a.price },
    priceLow: { label: 'Price: low to high', by: (a: Artwork, b: Artwork) => a.price - b.price },
    stock: { label: 'Most in stock', by: (a: Artwork, b: Artwork) => stockOf(b) - stockOf(a) },
    title: { label: 'Title A–Z', by: (a: Artwork, b: Artwork) => a.title.localeCompare(b.title) },
} as const;
type SortKey = keyof typeof SORTS;
type BulkDialog = 'move' | 'status' | 'price' | 'collection' | 'delete' | null;

export const ArtworksView: React.FC<ArtworksViewProps> = ({ artworks, onAddArtwork, onUpdateArtwork, onArtworkClick, onDeleteArtwork, collections = [], onUpdateCollection }) => {
    const settings = useInventorySettings();
    const { can } = useAppChrome();
    const [isAdding, setIsAdding] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
    const importInputRef = useRef<HTMLInputElement>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('All');
    const [locationFilter, setLocationFilter] = useState('All');
    const [sort, setSort] = useState<SortKey>('newest');
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [dialog, setDialog] = useState<BulkDialog>(null);
    useBackClose(selecting && !dialog, () => { setSelecting(false); setSelected(new Set()); });

    const activeLocations = settings.locations.filter(l => !l.archived);
    const q = searchQuery.trim().toLowerCase();
    const filteredArtworks = useMemo(() => artworks.filter(art => {
        if (statusFilter !== 'All' && statusOf(art, settings).id !== statusFilter) return false;
        if (locationFilter !== 'All' && !stockByLocation(art, settings)[locationFilter]) return false;
        if (!q) return true;
        const where = stockLabel(stockByLocation(art, settings), settings, false);
        return [art.title, art.customId, art.artist, art.medium, where].some(v => v?.toLowerCase().includes(q));
    }).sort(SORTS[sort].by), [artworks, statusFilter, locationFilter, q, sort, settings]);
    const unitsShown = filteredArtworks.reduce((n, a) => n + (locationFilter === 'All' ? stockOf(a) : stockByLocation(a, settings)[locationFilter] ?? 0), 0);
    const picked = artworks.filter(a => selected.has(a.id));

    const handleExport = () => downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, inventoryRows(selecting && picked.length ? picked : filteredArtworks, settings, can('costs')));

    const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // the same file can be chosen again
        if (!file) return;
        setIsImporting(true);
        try {
            if (/\.xlsx$/i.test(file.name)) { await previewXlsx(file); return; }
            const { artworks: rows, skipped, unknownLocations } = readInventoryCsv(await file.text(), settings);
            const { adds, updates } = planImport(artworks, rows, [], settings);
            const note = skippedNote(skipped) + unknownNote(unknownLocations);
            if (adds.length + updates.length === 0) {
                toast.error(`Nothing to import: no new or changed artworks.${note}`);
                return;
            }
            const existing = updates.length === 1 ? 'artwork' : 'artworks';
            if (!globalThis.confirm(`Add ${adds.length} new and update ${updates.length} existing ${existing}?${note}`)) return;
            for (const row of adds) await onAddArtwork({ ...row, imageUrls: [] }); // NOSONAR: in file order
            for (const art of updates) await onUpdateArtwork(art); // NOSONAR
            toast.success(`Imported: ${adds.length} added, ${updates.length} updated`);
        } catch (err) {
            toast.error((err as Error).message || 'Could not read the file as CSV');
        } finally {
            setIsImporting(false);
        }
    };

    const previewXlsx = async (file: File) => {
        const sheet = await readXlsx(await file.arrayBuffer());
        const { artworks: rows, skipped, rows: rowNumbers, unknownLocations } = readInventoryTable(sheet.table, sheet.rowNumbers, settings);
        const photos = rowNumbers.map(n => sheet.pictures.get(n) ?? []);
        const { adds, updates, addFrom, updateFrom, takesPhotos } = planImport(artworks, rows, photos.map(p => p.length), settings);
        const items = [
            ...adds.map((row, i) => ({ key: `add${i}`, row, isNew: true, photos: photos[addFrom[i]] })),
            ...updates.map((row, i) => ({ key: `update${i}`, row, isNew: false, photos: takesPhotos[i] ? photos[updateFrom[i]] : [] })),
        ];
        const used = new Set(rowNumbers);
        const offRows = [...sheet.pictures].filter(([n]) => !used.has(n)).reduce((sum, [, p]) => sum + p.length, 0);
        const kept = updates.filter((_, i) => !takesPhotos[i] && photos[updateFrom[i]].length).length;
        const noPhoto = adds.filter((_, i) => !photos[addFrom[i]].length).length;
        const notes = [
            skippedNote(skipped).trim(),
            unknownNote(unknownLocations).trim(),
            noPhoto ? `${count(noPhoto, 'new artwork has', 'new artworks have')} no photo in the sheet.` : '',
            offRows ? `${count(offRows, "picture isn't", "pictures aren't")} on an artwork's row and will be left out.` : '',
            sheet.unusable ? `${count(sheet.unusable, 'picture is', 'pictures are')} in a format the app can't show (use JPG or PNG).` : '',
            kept ? `${count(kept, 'existing artwork already has', 'existing artworks already have')} photos; theirs are kept.` : '',
        ].filter(Boolean);
        if (items.length === 0) { toast.error(`Nothing to import: no new or changed artworks. ${notes.join(' ')}`); return; }
        setPendingImport({ items, notes });
    };

    const runImport = async ({ items }: PendingImport) => {
        setPendingImport(null);
        setIsImporting(true);
        const total = items.reduce((n, it) => n + it.photos.length, 0);
        const progress = toast.loading(total ? `Uploading photos 0 of ${total}` : 'Importing…');
        let done = 0, failed = 0;
        try {
            // Photos upload three at a time; each artwork keeps its photos in sheet order (a failed one is left out).
            const urls: (string | null)[][] = items.map(it => it.photos.map(() => null));
            const queue = items.flatMap((it, i) => it.photos.map((photo, j) => ({ photo, i, j })));
            const worker = async () => {
                for (let next = queue.shift(); next; next = queue.shift()) {
                    try { urls[next.i][next.j] = (await storageService.upload(next.photo)).url; } catch { failed++; } // NOSONAR: each of the three workers uploads one photo at a time
                    toast.loading(`Uploading photos ${++done} of ${total}`, { id: progress });
                }
            };
            await Promise.all([worker(), worker(), worker()]);
            for (const [i, { row, isNew }] of items.entries()) {
                const imageUrls = urls[i].filter((u): u is string => !!u);
                if (isNew) await onAddArtwork({ ...row, imageUrls }); // NOSONAR: saved in file order
                else await onUpdateArtwork(imageUrls.length ? { ...(row as Artwork), imageUrls } : row as Artwork); // NOSONAR: saved in file order
            }
            const adds = items.filter(it => it.isNew).length;
            const lost = failed ? lostNote(failed) : '';
            toast[failed ? 'error' : 'success'](`Imported: ${adds} added, ${items.length - adds} updated, ${done - failed} photos.${lost}`, { id: progress });
        } catch (err) {
            toast.error((err as Error).message || 'The import stopped part way', { id: progress });
        } finally {
            setIsImporting(false);
        }
    };

    // ── Bulk edit: each piece goes through the same save as an edit ────────
    const endSelect = () => { setSelecting(false); setSelected(new Set()); setDialog(null); };
    const toggle = (id: string) => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    });
    const seen = (a: Artwork) => ({ status: a.status, quantity: stockOf(a) });
    const applyAll = async (change: (a: Artwork) => Artwork | null, done: (changed: number, skipped: number) => string) => {
        let changed = 0, skipped = 0;
        for (const a of picked) {
            const next = change(a);
            if (next) { await onUpdateArtwork(next); changed++; } else skipped++; // NOSONAR: one at a time, like an import
        }
        toast.success(done(changed, skipped));
        endSelect();
    };
    const pieces = (n: number) => count(n, 'piece', 'pieces');
    const bulkMove = (to: string) => {
        const name = settings.locations.find(l => l.id === to)?.name ?? '';
        void applyAll(a => {
            const total = totalOf(stockByLocation(a, settings));
            if (total === 0 || stockByLocation(a, settings)[to] === total) return null;
            return { ...a, stock: { [to]: total }, quantity: total, stockNote: `Moved to ${name}`, stockSeen: seen(a) };
        }, (n, s) => `Moved ${pieces(n)} to ${name}${aside(s, 'had nothing to move')}`);
    };
    const bulkStatus = (st: StatusDef) => void applyAll(a => {
        const stock = st.behaves === 'Sold' ? {} : stockByLocation(a, settings);
        if (st.behaves === 'Available' && totalOf(stock) === 0) return null;
        return { ...a, status: st.behaves, statusLabel: st.id === st.behaves ? '' : st.id, stock, quantity: totalOf(stock), stockSeen: seen(a) };
    }, (n, s) => `${pieces(n)} now ${st.name}${aside(s, 'left: nothing in stock')}`);
    const bulkPrice = (price: (old: number) => number) => void applyAll(a => ({ ...a, price: price(a.price), stockSeen: seen(a) }), n => `Price changed on ${pieces(n)}`);
    const bulkCollection = (c: Collection) => {
        const ids = [...new Set([...c.artworkIds, ...picked.map(a => a.id)])];
        void onUpdateCollection?.({ ...c, artworkIds: ids });
        toast.success(`Added to ${c.name}`);
        endSelect();
    };
    const bulkDelete = async () => {
        for (const a of picked) await onDeleteArtwork?.(a.id); // NOSONAR: one at a time
        toast.success(`Deleted ${pieces(picked.length)}`);
        endSelect();
    };

    return (
        <PageRoot>
            <PageHeader
                title="Inventory"
                subtitle={`${unitsShown} in stock · ${filteredArtworks.length} ${filteredArtworks.length === 1 ? 'piece' : 'pieces'}`}
                actions={<>
                    <GhostIconButton onClick={handleExport} label="Export these artworks as CSV" icon={<Download size={16} />} disabled={filteredArtworks.length === 0} />
                    <IfCan section="inventory">
                        <GhostIconButton onClick={() => (selecting ? endSelect() : setSelecting(true))} label={selecting ? 'Stop selecting' : 'Select artworks to edit together'} icon={<CheckSquare size={16} />} />
                        <GhostIconButton onClick={() => importInputRef.current?.click()} label="Import artworks from CSV or Excel (.xlsx, with photos)" icon={isImporting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} disabled={isImporting} />
                        <input ref={importInputRef} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" aria-label="CSV or Excel file to import" onChange={e => { void handleImport(e); }} />
                        <PrimaryIconButton onClick={() => setIsAdding(true)} label="Add artwork" icon={<Plus size={16} />} />
                    </IfCan>
                </>}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search title, artist, code, medium, location..." />
                <div className="flex items-center gap-2">
                    <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status" className="flex-1 min-w-0 !text-[13px] !py-2">
                        <option value="All">All statuses</option>
                        {settings.statuses.filter(s => !s.archived).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    {activeLocations.length > 1 && (
                        <Select value={locationFilter} onChange={e => setLocationFilter(e.target.value)} aria-label="Filter by location" className="flex-1 min-w-0 !text-[13px] !py-2">
                            <option value="All">All locations</option>
                            {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                        </Select>
                    )}
                    <Select value={sort} onChange={e => setSort(e.target.value as SortKey)} aria-label="Sort artworks" className="flex-1 min-w-0 sm:flex-none sm:!w-40 !text-[13px] !py-2">
                        {Object.entries(SORTS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}
                    </Select>
                </div>
            </PageHeader>

            {/* List */}
            <PageBody columns="gallery">
                {filteredArtworks.map((artwork: Artwork, index: number) => {
                    const status = statusOf(artwork, settings);
                    const stock = stockByLocation(artwork, settings);
                    const where = activeLocations.length > 1 ? stockLabel(stock, settings) : '';
                    const meta = [artwork.artist, artwork.customId, artwork.medium].filter(Boolean).join(' · ');
                    const imageCount = artwork.imageUrls.length;
                    const isPicked = selected.has(artwork.id);

                    return (
                        <button
                            key={artwork.id}
                            type="button"
                            onClick={() => (selecting ? toggle(artwork.id) : onArtworkClick(artwork))}
                            aria-pressed={selecting ? isPicked : undefined}
                            className={`neu-tile neu-tile-interactive w-full animate-fade-in-up cursor-pointer active-scale ${isPicked ? 'ring-2 ring-[var(--neu-gold)]' : ''}`}
                            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                        >
                            {/* Photo, set into the card */}
                            <div className="neu-picture-well neu-picture-well-sm tile-backdrop w-full aspect-[4/3] rounded-[1rem]">
                                {imageCount > 0 ? (
                                    <img data-art-thumb={artwork.id} loading="lazy" decoding="async" src={getThumbUrl(artwork.imageUrls[0])} alt={artwork.title} className="w-full h-full object-contain p-2" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-[var(--neu-text-dim)]">
                                        <ImageIcon size={28} strokeWidth={1} />
                                    </div>
                                )}
                                <span className={`neu-chip-float top-2 left-2 ${STATUS_TEXT[status.color]}`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                    {status.name}
                                </span>
                                {selecting && (
                                    <span className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center ${isPicked ? 'bg-[var(--neu-gold)] text-white' : 'neu-chip-float !static border border-[var(--neu-line)]'}`} aria-hidden="true">
                                        {isPicked && <Check size={14} />}
                                    </span>
                                )}
                                <span className="neu-chip-float bottom-2 left-2 text-[var(--neu-text)] tracking-normal tabular-nums">Qty {stockOf(artwork)}</span>
                                {imageCount > 1 && (
                                    <span className="neu-chip-float bottom-2 right-2 text-[var(--neu-text)] tracking-normal">
                                        <ImageIcon size={11} /> {imageCount}
                                    </span>
                                )}
                            </div>

                            <div className="flex-1 flex flex-col px-1.5 pt-3 pb-1 min-w-0">
                                <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] line-clamp-2">{artwork.title}</h3>
                                {meta && <p className="mt-1 text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)] truncate">{meta}</p>}
                                {where && <p className="mt-0.5 text-[10.5px] text-[var(--neu-text-dim)] truncate">{where}</p>}
                                <div className="mt-auto pt-2.5 flex items-baseline justify-between gap-2">
                                    <p className="text-sm font-semibold text-[var(--neu-gold)] whitespace-nowrap">
                                        ₹{artwork.price.toLocaleString('en-IN')}
                                        {artwork.plusGst && <span className="ml-1 text-[10px] font-medium text-[var(--neu-text-dim)]">+GST</span>}
                                    </p>
                                    {artwork.dimensions && <p className="text-[10.5px] text-[var(--neu-text-dim)] truncate min-w-0">{artwork.dimensions}</p>}
                                </div>
                            </div>
                        </button>
                    );
                })}
                {/* Room to scroll the last row out from under the selection toolbar. */}
                {selecting && <div className="col-span-full h-36" aria-hidden="true" />}
                {filteredArtworks.length === 0 && (
                    <EmptyState
                        icon={<ImageIcon size={22} strokeWidth={1.25} />}
                        title="No artworks found"
                        message={artworks.length === 0 ? 'Add your first artwork with the + button above.' : 'Try another search or filter.'}
                    />
                )}
            </PageBody>

            {selecting && (
                <div role="toolbar" aria-label="Edit selected artworks" className="fixed inset-x-0 z-40 px-3 bottom-[calc(5.5rem+var(--safe-bottom-ui))] lg:bottom-6 flex justify-center pointer-events-none">
                    <div className="neu-raised rounded-2xl p-2 flex flex-wrap items-center justify-center gap-1.5 pointer-events-auto max-w-3xl">
                        <span className="px-2 text-sm text-[var(--neu-text)] tabular-nums">{selected.size} selected</span>
                        <Button onClick={() => setSelected(selected.size === filteredArtworks.length ? new Set() : new Set(filteredArtworks.map(a => a.id)))}>
                            {selected.size === filteredArtworks.length && selected.size > 0 ? 'None' : 'All'}
                        </Button>
                        <Button disabled={!selected.size} onClick={() => setDialog('move')}>Move</Button>
                        <Button disabled={!selected.size} onClick={() => setDialog('status')}>Status</Button>
                        <Button disabled={!selected.size} onClick={() => setDialog('price')}>Price</Button>
                        {onUpdateCollection && can('collections', 'edit') && <Button disabled={!selected.size} onClick={() => setDialog('collection')}>Collection</Button>}
                        <Button disabled={!selected.size} onClick={handleExport}>Export</Button>
                        {onDeleteArtwork && <Button variant="danger" disabled={!selected.size} onClick={() => setDialog('delete')}>Delete</Button>}
                        <Button onClick={endSelect} aria-label="Stop selecting"><X size={14} /></Button>
                    </div>
                </div>
            )}
            {dialog === 'move' && <BulkMoveModal count={picked.length} onClose={() => setDialog(null)} onMove={bulkMove} />}
            {dialog === 'status' && <BulkStatusModal count={picked.length} onClose={() => setDialog(null)} onSet={bulkStatus} />}
            {dialog === 'price' && <BulkPriceModal count={picked.length} onClose={() => setDialog(null)} onSet={bulkPrice} />}
            {dialog === 'collection' && <AddToCollectionModal count={picked.length} collections={collections} onClose={() => setDialog(null)} onAdd={bulkCollection} />}
            <TypeDeleteDialog isOpen={dialog === 'delete'} onClose={() => setDialog(null)} title="Delete artworks" itemName={pieces(picked.length)}
                message="They go to the deleted items, where an admin can restore them." onConfirm={() => { void bulkDelete(); }} />

            {/* Add Modal */}
            {isAdding && (
                <ArtworkFormModal
                    onClose={() => setIsAdding(false)}
                    onSave={(newArt) => {
                        onAddArtwork(newArt);
                        setIsAdding(false);
                    }}
                />
            )}
            {pendingImport && <ImportPreview pending={pendingImport} onCancel={() => setPendingImport(null)} onConfirm={() => { void runImport(pendingImport); }} />}
        </PageRoot>
    );
};

/** "3 pictures are", "1 picture is". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** " (2 had nothing to move)", or nothing. */
const aside = (n: number, why: string) => (n ? ` (${n} ${why})` : '');
const lostNote = (n: number) => {
    const them = n === 1 ? 'it' : 'them';
    return ` ${count(n, 'photo', 'photos')} couldn't be uploaded; add ${them} by hand.`;
};

/** " "Qty: Garage" names no location and was left out." */
function unknownNote(names: string[]): string {
    if (!names.length) return '';
    const one = names.length === 1;
    const columns = names.map(n => '"Qty: ' + n + '"').join(', ');
    return ` ${columns} ${one ? 'names no location and was' : 'name no location and were'} left out. Add ${one ? 'it' : 'them'} in Inventory settings first.`;
}

/** Each row with the photo(s) it brings, so a picture on the wrong row is caught before anything is saved. */
const ImportPreview: React.FC<{ pending: PendingImport; onCancel: () => void; onConfirm: () => void }> = ({ pending, onCancel, onConfirm }) => {
    useBackClose(true, onCancel);
    const thumbs = useMemo(() => new Map(pending.items.map(it => [it, it.photos.map(f => URL.createObjectURL(f))])), [pending]);
    useEffect(() => () => thumbs.forEach(urls => urls.forEach(u => URL.revokeObjectURL(u))), [thumbs]);
    const adds = pending.items.filter(it => it.isNew).length;
    return (
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="flex justify-between items-center p-3" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                <button onClick={onCancel} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Cancel import">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">Check the import</h2>
                <button onClick={onConfirm} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                    Import
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 no-scrollbar space-y-3">
                <p className="text-sm text-[var(--neu-text)]">{adds} new, {pending.items.length - adds} updated. Check each photo is on the right artwork.</p>
                {pending.notes.map(n => <p key={n} className="text-xs text-[var(--neu-text-dim)]">{n}</p>)}
                <ul className="space-y-2">
                    {pending.items.map(it => (
                        <li key={it.key} className="neu-card flex items-center gap-3 p-2">
                            <div className="flex gap-1 shrink-0">
                                {thumbs.get(it)?.length
                                    ? thumbs.get(it)!.slice(0, 3).map(u => <img key={u} src={u} alt="" className="w-12 h-12 object-cover rounded-md" />)
                                    : <div className="w-12 h-12 rounded-md flex items-center justify-center text-[var(--neu-text-dim)]" aria-label="No photo"><ImageIcon size={18} /></div>}
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm text-[var(--neu-text)] truncate">{it.row.title}</p>
                                <p className="text-[11px] text-[var(--neu-text-dim)] truncate">
                                    {[it.row.customId, it.isNew ? 'New' : 'Update', it.photos.length > 3 ? `${it.photos.length} photos` : ''].filter(Boolean).join(' · ')}
                                </p>
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

export interface ArtworkFormModalProps {
    initialData?: Artwork;
    onClose: () => void;
    onSave: (artwork: Omit<Artwork, 'id' | 'createdAt'>) => void;
    onDelete?: () => void;
}

export const ArtworkFormModal: React.FC<ArtworkFormModalProps> = ({ initialData, onClose, onSave, onDelete }) => {
    useBackClose(true, onClose);
    const [formData, setFormData] = useState({
        title: initialData?.title || '',
        artist: initialData?.artist || '',
        artworkYear: initialData?.artworkYear || '',
        customId: initialData?.customId || '',
        descriptionTitle: initialData?.descriptionTitle || '',
        description: initialData?.description || '',
        dimensions: initialData?.dimensions || '',
        medium: initialData?.medium || '',
        price: initialData?.price?.toString() || '',
        plusGst: initialData?.plusGst || false,
        imageUrls: initialData?.imageUrls ?? []
    });
    const settings = useInventorySettings();
    const { can } = useAppChrome();
    const [statusId, setStatusId] = useState(() => (initialData ? statusOf(initialData, settings).id : 'Available'));
    // Units per location as typed; a new piece starts with one at the default location.
    const [units, setUnits] = useState<Record<string, string>>(() => {
        const stock = initialData ? stockByLocation(initialData, settings) : { [defaultLocation(settings).id]: 1 };
        return Object.fromEntries(Object.entries(stock).map(([id, n]) => [id, String(n)]));
    });
    const [costText, setCostText] = useState(initialData?.costPrice ? String(initialData.costPrice) : '');
    const status = settings.statuses.find(s => s.id === statusId) ?? statusOf({ status: 'Available' }, settings);
    const shownLocations = settings.locations.filter(l => !l.archived || Number(units[l.id]) > 0);
    const stock = Object.fromEntries(Object.entries(units).map(([id, t]) => [id, Math.max(0, Math.floor(Number(t) || 0))]).filter(([, n]) => (n as number) > 0)) as Record<string, number>;
    const total = status.behaves === 'Sold' ? 0 : totalOf(stock);
    // initialData follows sync while the form is open; this keeps what it opened with.
    const [stockSeen] = useState(() => initialData && { status: initialData.status, quantity: stockOf(initialData) });
    const [isEdition, setIsEdition] = useState(!!initialData?.edition);
    const [edition, setEdition] = useState<Edition>(initialData?.edition ?? { size: '' });
    const editionField = (key: keyof Edition) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setEdition(prev => ({ ...prev, [key]: e.target.value }));
    const [showUploadOptions, setShowUploadOptions] = useState(false);

    const [isUploading, setIsUploading] = useState(false);

    const cameraInputRef = useRef<HTMLInputElement>(null);
    const galleryInputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (status.behaves === 'Available' && total === 0) {
            toast.error(`Add how many are in stock, or choose a status other than ${status.name}.`);
            return;
        }
        // Sold holds no stock.
        const saved = status.behaves === 'Sold' ? {} : stock;
        onSave({
            ...formData,
            status: status.behaves,
            statusLabel: status.id === status.behaves ? '' : status.id,
            stock: saved,
            quantity: totalOf(saved),
            location: stockLabel(saved, settings, false),
            price: Number(formData.price) || 0,
            // Without "change" the server keeps the stored cost; the copy on this device keeps it too.
            costPrice: can('costs', 'edit') ? Math.max(0, Number(costText) || 0) : initialData?.costPrice,
            edition: isEdition ? edition : undefined,
            stockSeen,
        });
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        const { name, value, type } = e.target;
        if (type === 'checkbox') {
            const checked = (e.target as HTMLInputElement).checked;
            setFormData(prev => ({ ...prev, [name]: checked }));
        } else {
            setFormData(prev => ({ ...prev, [name]: value }));
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) {
            e.target.value = '';
            return;
        }
        setIsUploading(true);
        storageService.upload(file)
            .then((result) => {
                setFormData(prev => ({
                    ...prev,
                    imageUrls: [...prev.imageUrls, result.url]
                }));
            })
            .catch((error) => {
                console.error('Upload failed:', error);
                toast.error('Failed to upload image. Please try again.');
            })
            .finally(() => {
                setIsUploading(false);
                // Reset input value so the same file can be selected again if needed
                e.target.value = '';
            });
    };

    const handleRemoveImage = async (indexToRemove: number) => {
        const urlToRemove = formData.imageUrls[indexToRemove];
        // Only attempt R2 deletion for R2-hosted files (not legacy data URLs)
        const key = urlToRemove ? fileKeyOf(urlToRemove) : null;
        if (key) {
            try {
                await storageService.delete(key);
            } catch (error) {
                console.error('Failed to delete from R2:', error);
            }
        }
        setFormData(prev => ({
            ...prev,
            imageUrls: prev.imageUrls.filter((_, index) => index !== indexToRemove)
        }));
    };

    const handleSetAsCover = (indexToCover: number) => {
        if (indexToCover === 0) return;
        setFormData(prev => {
            const newImageUrls = [...prev.imageUrls];
            const coverImage = newImageUrls.splice(indexToCover, 1)[0];
            newImageUrls.unshift(coverImage);
            return {
                ...prev,
                imageUrls: newImageUrls
            };
        });
    };

    return (
        <div className="neu-sheet z-50 animate-fade-in-up">
            <div className="flex justify-between items-center p-3" style={{ paddingTop: 'calc(1rem + var(--safe-top))' }}>
                <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                    <X size={20} />
                </button>
                <h2 className="text-base font-serif text-gray-900 dark:text-white">{initialData ? 'Edit Artwork' : 'New Artwork'}</h2>
                <div className="flex items-center gap-2">
                    {initialData && onDelete && (
                        <button onClick={onDelete} className="neu-icon-btn text-red-500 active-scale">
                            <Trash2 size={18} />
                        </button>
                    )}
                    <button type="submit" form="add-art-form" className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale">
                        Save
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 no-scrollbar relative">
                <form id="add-art-form" onSubmit={handleSubmit} className="space-y-6">

                    {/* Multiple Image Upload Area */}
                    <div>
                        <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Photos ({formData.imageUrls.length})</label>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-2 snap-x">
                            {formData.imageUrls.map((url: string, idx: number) => (
                                <div key={url} className="relative w-32 h-32 shrink-0 rounded-lg overflow-hidden snap-start shadow-sm animate-scale-in tile-backdrop" style={{ animationDelay: `${idx * 50}ms` }}>
                                    <img loading="lazy" decoding="async" src={getThumbUrl(url)} alt={`Preview ${idx + 1}`} className="w-full h-full object-contain p-1" />
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveImage(idx)}
                                        className="absolute top-1.5 right-1.5 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 backdrop-blur-sm transition-colors active-scale"
                                    >
                                        <X size={14} />
                                    </button>
                                    {idx === 0 ? (
                                        <div className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider">
                                            Cover
                                        </div>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() => handleSetAsCover(idx)}
                                            className="absolute bottom-1.5 left-1.5 bg-black/40 hover:bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-[3px] backdrop-blur-sm uppercase tracking-wider transition-colors active-scale"
                                        >
                                            Set Cover
                                        </button>
                                    )}
                                </div>
                            ))}

                            <button
                                type="button"
                                onClick={() => setShowUploadOptions(true)}
                                disabled={isUploading}
                                className="w-32 h-32 shrink-0 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 hover:border-gold-400 dark:hover:border-gold-500 transition-colors snap-start active-scale disabled:opacity-60"
                            >
                                {isUploading ? (
                                    <>
                                        <Loader2 size={24} className="mb-1 animate-spin" strokeWidth={1.5} />
                                        <span className="text-[11px] font-medium uppercase tracking-wider">Uploading...</span>
                                    </>
                                ) : (
                                    <>
                                        <Plus size={24} className="mb-1" strokeWidth={1.5} />
                                        <span className="text-[11px] font-medium uppercase tracking-wider">Add Photo</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    <div className="space-y-5 neu-card p-5 animate-fade-in-up" style={{ animationDelay: '100ms' }}>
                        <div>
                            <label htmlFor="artwork-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Title *</label>
                            <input id="artwork-title" required name="title" value={formData.title} onChange={handleChange} className="neu-field text-base font-serif" placeholder="e.g. Starry Night" />
                        </div>

                        <div className="flex gap-3">
                            <div className="flex-[2]">
                                <label htmlFor="artwork-artist" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Artist</label>
                                <input id="artwork-artist" name="artist" value={formData.artist} onChange={handleChange} className="neu-field" placeholder="e.g. Vincent van Gogh" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-year" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Year</label>
                                <input id="artwork-year" name="artworkYear" value={formData.artworkYear} onChange={handleChange} className="neu-field" placeholder="e.g. 1889" />
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label htmlFor="artwork-customid" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Inventory ID</label>
                                <input id="artwork-customid" name="customId" value={formData.customId} onChange={handleChange} className="neu-field" placeholder="ART-001" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-price" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Price (₹)</label>
                                <div className="flex items-center gap-2">
                                    <input id="artwork-price" required type="number" name="price" value={formData.price} onChange={handleChange} className="neu-field" placeholder="0.00" />
                                </div>
                                <div className="mt-2 flex items-center gap-1.5">
                                    <input type="checkbox" id="plusGst" name="plusGst" checked={formData.plusGst} onChange={handleChange} className="accent-gold-500 w-3 h-3" />
                                    <label htmlFor="plusGst" className="text-[11px] text-gray-600 dark:text-gray-400 cursor-pointer">+ GST</label>
                                </div>
                            </div>
                        </div>

                        {can('costs', 'edit') && (
                            <div>
                                <label htmlFor="artwork-cost" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Cost price (₹)</label>
                                <input id="artwork-cost" type="number" min="0" inputMode="decimal" value={costText} onChange={e => setCostText(e.target.value)} className="neu-field" placeholder="What it cost you" />
                                {marginOf(Number(formData.price), Number(costText)) && (
                                    <p className="mt-1 text-[11px] text-[var(--neu-text-dim)]">
                                        Margin ₹{marginOf(Number(formData.price), Number(costText))!.amount.toLocaleString('en-IN')} ({marginOf(Number(formData.price), Number(costText))!.percent}%)
                                    </p>
                                )}
                            </div>
                        )}

                        <div>
                            <label htmlFor="artwork-status" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Status</label>
                            <select id="artwork-status" value={status.id} onChange={e => setStatusId(e.target.value)} className="neu-field">
                                {settings.statuses.filter(s => !s.archived || s.id === status.id).map(s => (
                                    <option key={s.id} value={s.id} className="dark:bg-gray-800">{s.name}{s.id === s.behaves ? '' : ` (like ${settings.statuses.find(b => b.id === s.behaves)?.name ?? s.behaves})`}</option>
                                ))}
                            </select>
                        </div>

                        <fieldset>
                            <legend className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">
                                Quantity in stock{status.behaves === 'Sold' ? '' : ` · ${total} in all`}
                            </legend>
                            {status.behaves === 'Sold' ? (
                                <p className="text-[12px] text-[var(--neu-text-dim)]">A sold piece holds no stock.</p>
                            ) : (
                                <div className="grid grid-cols-2 gap-2">
                                    {shownLocations.map(l => (
                                        <label key={l.id} className="flex items-center gap-2 min-w-0">
                                            <span className="text-[12px] text-[var(--neu-text)] truncate flex-1">{l.name}</span>
                                            <input type="number" min="0" step="1" inputMode="numeric" value={units[l.id] ?? ''} placeholder="0"
                                                onChange={e => setUnits(prev => ({ ...prev, [l.id]: e.target.value }))} className="neu-field w-20 text-right" aria-label={`Units at ${l.name}`} />
                                        </label>
                                    ))}
                                </div>
                            )}
                        </fieldset>

                        <div className="flex gap-3">
                            <div className="flex-1">
                                <label htmlFor="artwork-dimensions" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Dimensions</label>
                                <input id="artwork-dimensions" name="dimensions" value={formData.dimensions} onChange={handleChange} className="neu-field" placeholder="e.g. 24x36 in" />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="artwork-medium" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Medium</label>
                                <input id="artwork-medium" name="medium" value={formData.medium} onChange={handleChange} className="neu-field" placeholder="e.g. Oil on Canvas" />
                            </div>
                        </div>

                        <div>
                            <label htmlFor="artwork-edition" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Edition</label>
                            <select id="artwork-edition" value={isEdition ? 'edition' : 'unique'} onChange={e => setIsEdition(e.target.value === 'edition')} className="neu-field">
                                <option value="unique" className="dark:bg-gray-800">Unique work</option>
                                <option value="edition" className="dark:bg-gray-800">Edition</option>
                            </select>
                            {isEdition && (
                                <div className="flex gap-3 mt-3">
                                    <div className="flex-1">
                                        <label htmlFor="edition-number" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">This copy</label>
                                        <input id="edition-number" value={edition.number ?? ''} onChange={editionField('number')} className="neu-field" placeholder="e.g. 3 or AP 1" />
                                    </div>
                                    <div className="flex-1">
                                        <label htmlFor="edition-size" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Edition size *</label>
                                        <input id="edition-size" required type="number" min="1" inputMode="numeric" value={edition.size} onChange={editionField('size')} className="neu-field" placeholder="e.g. 10" />
                                    </div>
                                    <div className="flex-1">
                                        <label htmlFor="edition-proofs" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Artist proofs</label>
                                        <input id="edition-proofs" type="number" min="0" inputMode="numeric" value={edition.proofs ?? ''} onChange={editionField('proofs')} className="neu-field" placeholder="e.g. 2" />
                                    </div>
                                </div>
                            )}
                        </div>

                        <div>
                            <label htmlFor="artwork-description-title" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1 uppercase tracking-wider">Description Title</label>
                            <input id="artwork-description-title" name="descriptionTitle" value={formData.descriptionTitle} onChange={handleChange} className="neu-field mb-3" placeholder="e.g. Provenance or Exhibition History" />

                            <label htmlFor="artwork-description" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-2 uppercase tracking-wider">Description</label>
                            <textarea id="artwork-description" name="description" value={formData.description} onChange={handleChange} rows={3} className="w-full bg-transparent border border-gray-300 dark:border-gray-700 rounded-lg p-2 text-gray-900 dark:text-white focus:outline-none focus:border-[var(--ink-focus)] transition-colors resize-none text-sm" placeholder="Details about the artwork..."></textarea>
                        </div>
                    </div>
                    <div className="h-10"></div> {/* Spacer */}
                </form>
            </div>

            {/* Upload Options Action Sheet */}
            {showUploadOptions && (
                <div className="absolute inset-0 z-[100] flex flex-col justify-end overflow-hidden">
                    <button
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setShowUploadOptions(false); }}
                        className="absolute inset-0 neu-scrim animate-fade-in"
                        onClick={() => setShowUploadOptions(false)}
                    ></button>
                    <div className="neu-raised p-6 relative z-10 animate-fade-in-up shadow-2xl pb-28 lg:pb-8">
                        <div className="w-12 h-1.5 bg-gray-300 dark:bg-gray-700 rounded-full mx-auto mb-6"></div>
                        <h3 className="text-sm font-bold text-gray-900 dark:text-white uppercase tracking-widest mb-6 text-center">Upload Photo</h3>

                        <div className="flex flex-col gap-3">
                            <button
                                type="button"
                                onClick={() => { cameraInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Camera size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Take Photo</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { galleryInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <ImageIcon size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Choose from Gallery</span>
                            </button>

                            <button
                                type="button"
                                onClick={() => { fileInputRef.current?.click(); setShowUploadOptions(false); }}
                                className="w-full flex items-center gap-3 p-3 rounded-lg neu-inset hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors active-scale border border-gray-100 dark:border-gray-700"
                            >
                                <div className="text-brand-900 dark:text-gold-400">
                                    <Folder size={24} strokeWidth={1.5} />
                                </div>
                                <span className="font-medium text-gray-900 dark:text-white text-sm tracking-wide">Browse Files</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Hidden Inputs MOVED OUTSIDE THE CONDITIONAL RENDER */}
            <input type="file" accept="image/*" capture="environment" ref={cameraInputRef} className="hidden" onChange={handleFileChange} />
            <input type="file" accept="image/*" ref={galleryInputRef} className="hidden" onChange={handleFileChange} />
            <input type="file" accept="*" ref={fileInputRef} className="hidden" onChange={handleFileChange} />
        </div>
    );
};
