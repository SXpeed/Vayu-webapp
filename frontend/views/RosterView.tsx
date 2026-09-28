import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
    ArrowDown, ArrowRight, ArrowUp, Grid2x2, Grid3x3, Heart, LayoutGrid, Loader2, MonitorPlay, Pencil, Plus, ShoppingBag,
} from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { Button, EmptyState, GhostIconButton, PageBody, PageHeader, PageRoot, Pill, PrimaryIconButton } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { realtimeService } from '../services/realtimeService';
import { rosterService, type RosterData } from '../services/rosterService';
import type { Artwork, Collection, Inquiry, RosterBackdrop, RosterPriceDisplay, RosterSection } from '../types';
import { RosterCard } from './roster/RosterCard';
import { RosterPresent } from './roster/RosterPresent';
import { RosterQuickView } from './roster/RosterQuickView';
import { RosterSectionEditor } from './roster/RosterSectionEditor';
import { RosterSelectionSheet } from './roster/RosterSelectionSheet';
import {
    GRID_CLASS, SORT_LABEL, matchesQuery, sectionPieces, sortPieces, usePreference, useSelection,
    type Density, type RosterSort,
} from './roster/rosterShared';

interface RosterViewProps {
    artworks: Artwork[];
    userId: string;
    onArtworkClick: (artwork: Artwork) => void;
    onAddInquiry: (inquiry: Omit<Inquiry, 'id' | 'date'>) => Promise<void>;
    onAddCollection: (collection: Omit<Collection, 'id'>) => Promise<void>;
}

type Filter = 'all' | 'favorites' | 'available';
const SORTS = Object.keys(SORT_LABEL) as RosterSort[];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
/** A tab coming back into view refetches if its copy is older than this. */
const STALE_MS = 30_000;

interface Display { priceDisplay: RosterPriceDisplay; backdrop: RosterBackdrop }
const PREVIEW: Record<Density, Record<'phone' | 'tablet' | 'wide', number>> = {
    comfortable: { phone: 4, tablet: 6, wide: 8 },
    compact: { phone: 6, tablet: 8, wide: 12 },
};
const DEFAULT_DISPLAY: Display = { priceDisplay: 'request', backdrop: 'studio' };

/**
 * The Roster: the inventory as a client would see it in a gallery — curated
 * sections of pieces on a studio backdrop, each with "View all". Everyone
 * whose role can browse it can search, sort, heart pieces, gather a selection
 * (then share it, start an inquiry or keep it as a collection) and present a
 * section full screen. People whose role can curate it arrange the sections.
 */
export const RosterView: React.FC<RosterViewProps> = ({ artworks, userId, onArtworkClick, onAddInquiry, onAddCollection }) => {
    const { can } = useAppChrome();
    const [data, setData] = useState<RosterData | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const loadedAt = useRef(0);

    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [sort, setSort] = usePreference<RosterSort>('vayu.roster.sort', 'curated', SORTS);
    const [density, setDensity] = usePreference<Density>('vayu.roster.density', 'comfortable', DENSITIES);
    const [openSectionId, setOpenSectionId] = useState<string | null>(null);

    const [quick, setQuick] = useState<{ pieces: Artwork[]; index: number; section: RosterSection | null } | null>(null);
    const [present, setPresent] = useState<RosterSection | null>(null);
    const [editing, setEditing] = useState<RosterSection | 'new' | null>(null);
    const [showSelection, setShowSelection] = useState(false);
    const selection = useSelection(userId);

    const isMd = useMediaQuery('(min-width: 768px)');
    const isXl = useMediaQuery('(min-width: 1280px)');

    // ── Data ──────────────────────────────────────────────────────────────
    const load = useCallback(async () => {
        try {
            const next = await rosterService.get();
            setData(next);
            setLoadError(null);
            loadedAt.current = Date.now();
        } catch (e) {
            const error = e as Error & { code?: string };
            setLoadError(error.code === 'module_off'
                ? 'The Roster isn’t part of this workspace’s plan.'
                : error.message || 'Could not load the roster');
        }
    }, []);

    useEffect(() => {
        void load();
        // A curator's change elsewhere is signalled over the realtime socket.
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'roster') && document.visibilityState === 'visible') {
                void load();
            }
        });
        const onVisible = () => {
            if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > STALE_MS) void load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible); };
    }, [load]);

    const byId = useMemo(() => new Map(artworks.map(a => [a.id, a])), [artworks]);
    const sections = data?.sections ?? [];
    const favorites = useMemo(() => new Set(data?.favorites ?? []), [data?.favorites]);
    // The server decides; the role on this device is the fallback before it answers.
    const canEdit = data ? data.canEdit : can('roster', 'edit');
    const openSection = sections.find(s => s.id === openSectionId) ?? null;

    // A section closed or removed elsewhere: back to the overview.
    useEffect(() => {
        if (openSectionId && data && !openSection) setOpenSectionId(null);
    }, [openSectionId, data, openSection]);

    /** How a piece shows: its section's choice, or the first section that holds it. */
    const displayFor = useCallback((art: Artwork, within?: RosterSection | null): Display => {
        const home = within ?? sections.find(s => s.artworkIds.includes(art.id));
        return home ? { priceDisplay: home.priceDisplay, backdrop: home.backdrop } : DEFAULT_DISPLAY;
    }, [sections]);

    // ── Favourites (optimistic, rolled back on failure) ───────────────────
    const toggleFavorite = useCallback(async (id: string) => {
        const on = !favorites.has(id);
        const apply = (add: boolean) => setData(prev => prev && ({
            ...prev,
            favorites: add ? [id, ...prev.favorites.filter(x => x !== id)] : prev.favorites.filter(x => x !== id),
        }));
        apply(on);
        try {
            await rosterService.setFavorite(id, on);
        } catch (e) {
            apply(!on);
            toast.error((e as Error).message || 'Could not update your favourites');
        }
    }, [favorites]);

    // ── Section order (curators) ──────────────────────────────────────────
    const moveSection = async (id: string, by: -1 | 1) => {
        const ids = sections.map(s => s.id);
        const from = ids.indexOf(id);
        const to = from + by;
        if (from < 0 || to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        setData(prev => prev && ({ ...prev, sections: ids.map(x => prev.sections.find(s => s.id === x)!).filter(Boolean) }));
        try {
            const next = await rosterService.reorder(ids);
            setData(prev => prev && ({ ...prev, sections: next }));
        } catch (e) {
            toast.error((e as Error).message || 'Could not move the section');
            void load();
        }
    };

    // ── What's on screen ──────────────────────────────────────────────────
    const q = query.trim().toLowerCase();
    const searching = q.length > 0 || filter !== 'all';

    const passes = useCallback((art: Artwork) => {
        if (filter === 'favorites' && !favorites.has(art.id)) return false;
        if (filter === 'available' && art.status !== 'Available') return false;
        return matchesQuery(art, q);
    }, [filter, favorites, q]);

    /** Search / filters across the whole roster (or the open section). */
    const results = useMemo(() => {
        if (!searching) return [];
        let pool: Artwork[];
        if (openSection) pool = sectionPieces(openSection, byId);
        else if (filter === 'favorites') pool = (data?.favorites ?? []).map(id => byId.get(id)).filter((a): a is Artwork => !!a);
        else {
            const seen = new Set<string>();
            pool = [];
            for (const s of sections) {
                for (const art of sectionPieces(s, byId)) {
                    if (!seen.has(art.id)) { seen.add(art.id); pool.push(art); }
                }
            }
        }
        return sortPieces(pool.filter(passes), sort);
    }, [searching, openSection, filter, data?.favorites, sections, byId, passes, sort]);

    const totalPieces = useMemo(() => new Set(sections.flatMap(s => sectionPieces(s, byId).map(a => a.id))).size, [sections, byId]);
    const selectedPieces = useMemo(() => selection.ids.map(id => byId.get(id)).filter((a): a is Artwork => !!a), [selection.ids, byId]);

    // Two rows of the grid on the overview, whatever the screen.
    let screen: 'phone' | 'tablet' | 'wide' = 'phone';
    if (isXl) screen = 'wide';
    else if (isMd) screen = 'tablet';
    const previewCount = PREVIEW[density][screen];

    const card = (art: Artwork, i: number, list: Artwork[], section: RosterSection | null) => {
        const display = displayFor(art, section);
        return (
            <RosterCard
                key={art.id}
                art={art}
                index={i}
                density={density}
                backdrop={display.backdrop}
                priceDisplay={display.priceDisplay}
                favorite={favorites.has(art.id)}
                selected={selection.has(art.id)}
                onOpen={() => setQuick({ pieces: list, index: i, section })}
                onToggleFavorite={() => { void toggleFavorite(art.id); }}
                onToggleSelect={() => selection.toggle(art.id)}
            />
        );
    };

    // ── Header ────────────────────────────────────────────────────────────
    const title = openSection ? openSection.name : 'Roster';
    let subtitle: string | undefined;
    if (openSection) subtitle = `${sectionPieces(openSection, byId).length} pieces`;
    else if (data) subtitle = `${sections.length} ${sections.length === 1 ? 'section' : 'sections'} · ${totalPieces} pieces`;

    const bag = (
        <span className="relative">
            <GhostIconButton onClick={() => setShowSelection(true)} label={`Your selection (${selectedPieces.length})`}
                icon={<ShoppingBag size={16} className="text-brand-900 dark:text-gold-400" />} />
            {selectedPieces.length > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full neu-accent text-white text-[10px] font-bold flex items-center justify-center pointer-events-none">
                    {selectedPieces.length}
                </span>
            )}
        </span>
    );

    const actions = (
        <>
            {openSection && openSection.artworkIds.length > 0 && (
                <GhostIconButton onClick={() => setPresent(openSection)} label="Present this section"
                    icon={<MonitorPlay size={16} className="text-brand-900 dark:text-gold-400" />} />
            )}
            {openSection && canEdit && (
                <GhostIconButton onClick={() => setEditing(openSection)} label="Edit this section"
                    icon={<Pencil size={15} className="text-brand-900 dark:text-gold-400" />} />
            )}
            {bag}
            {!openSection && canEdit && (
                <PrimaryIconButton onClick={() => setEditing('new')} label="New section" icon={<Plus size={16} />} />
            )}
        </>
    );

    // ── Body ──────────────────────────────────────────────────────────────
    let body: React.ReactNode;
    if (!data && !loadError) {
        body = (
            <div className="py-24 flex justify-center text-[var(--neu-text-dim)]">
                <Loader2 size={22} className="animate-spin" />
            </div>
        );
    } else if (loadError && !data) {
        body = (
            <EmptyState icon={<LayoutGrid size={22} strokeWidth={1.5} />} title="The roster didn’t load" message={loadError}
                action={<Button onClick={() => { void load(); }}>Try again</Button>} />
        );
    } else if (searching) {
        body = results.length === 0 ? (
            <EmptyState
                icon={filter === 'favorites' ? <Heart size={22} strokeWidth={1.5} /> : <LayoutGrid size={22} strokeWidth={1.5} />}
                title={filter === 'favorites' && !q ? 'No favourites yet' : 'Nothing matches'}
                message={filter === 'favorites' && !q ? 'Tap the heart on a piece to keep it here.' : 'Try another word or clear the filters.'}
            />
        ) : (
            <>
                <p className="px-1 mb-3 text-[11px] uppercase tracking-[0.16em] text-[var(--neu-text-dim)]">{results.length} {results.length === 1 ? 'piece' : 'pieces'}</p>
                <div className={GRID_CLASS[density]}>{results.map((art, i) => card(art, i, results, openSection))}</div>
            </>
        );
    } else if (openSection) {
        const pieces = sortPieces(sectionPieces(openSection, byId), sort);
        body = (
            <>
                {openSection.description && <p className="px-1 mb-4 max-w-2xl text-[13.5px] leading-relaxed text-[var(--neu-text-dim)]">{openSection.description}</p>}
                {pieces.length === 0 ? (
                    <EmptyState icon={<LayoutGrid size={22} strokeWidth={1.5} />} title="No pieces in this section yet"
                        action={canEdit ? <Button onClick={() => setEditing(openSection)} icon={<Pencil size={14} />}>Choose pieces</Button> : undefined} />
                ) : (
                    <div className={GRID_CLASS[density]}>{pieces.map((art, i) => card(art, i, pieces, openSection))}</div>
                )}
            </>
        );
    } else if (sections.length === 0) {
        body = canEdit ? (
            <EmptyState icon={<LayoutGrid size={22} strokeWidth={1.5} />} title="Build your roster"
                message="Group pieces into sections — a collection, a new arrival, a client’s brief — and show them the way a gallery would."
                action={<Button variant="primary" onClick={() => setEditing('new')} icon={<Plus size={14} />}>New section</Button>} />
        ) : (
            <EmptyState icon={<LayoutGrid size={22} strokeWidth={1.5} />} title="The roster is being put together"
                message="Sections show here once someone curates them." />
        );
    } else {
        body = (
            <div className="space-y-9 lg:space-y-12">
                {sections.map((section, sIndex) => {
                    const pieces = sortPieces(sectionPieces(section, byId), sort);
                    const preview = pieces.slice(0, previewCount);
                    return (
                        <section key={section.id} aria-labelledby={`roster-${section.id}`} className="animate-fade-in-up" style={{ animationDelay: `${Math.min(sIndex, 6) * 60}ms` }}>
                            <div className="flex items-end justify-between gap-3 mb-3 lg:mb-4 px-1">
                                <div className="min-w-0">
                                    <h2 id={`roster-${section.id}`} className="text-[12.5px] md:text-sm font-semibold uppercase tracking-[0.22em] text-[var(--neu-text)] truncate">
                                        {section.name}
                                    </h2>
                                    {section.description && <p className="mt-1 text-[12px] text-[var(--neu-text-dim)] line-clamp-1">{section.description}</p>}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    {canEdit && (
                                        <>
                                            <button type="button" onClick={() => { void moveSection(section.id, -1); }} disabled={sIndex === 0}
                                                aria-label={`Move ${section.name} up`} className="neu-icon-btn-sm disabled:opacity-30 active-scale"><ArrowUp size={12} /></button>
                                            <button type="button" onClick={() => { void moveSection(section.id, 1); }} disabled={sIndex === sections.length - 1}
                                                aria-label={`Move ${section.name} down`} className="neu-icon-btn-sm disabled:opacity-30 active-scale"><ArrowDown size={12} /></button>
                                            <button type="button" onClick={() => setEditing(section)} aria-label={`Edit ${section.name}`}
                                                className="neu-icon-btn-sm active-scale"><Pencil size={12} /></button>
                                        </>
                                    )}
                                    {pieces.length > 0 && (
                                        <button type="button" onClick={() => setPresent(section)} aria-label={`Present ${section.name}`} title="Present"
                                            className="neu-icon-btn-sm active-scale"><MonitorPlay size={13} /></button>
                                    )}
                                    <button type="button" onClick={() => setOpenSectionId(section.id)}
                                        className="ml-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold-700 dark:text-gold-300 active-scale">
                                        View all <ArrowRight size={13} />
                                    </button>
                                </div>
                            </div>
                            {preview.length === 0 ? (
                                <p className="neu-card p-5 text-[13px] text-[var(--neu-text-dim)]">
                                    {canEdit ? 'No pieces yet. Edit the section to choose some.' : 'No pieces here yet.'}
                                </p>
                            ) : (
                                <div className={GRID_CLASS[density]}>{preview.map((art, i) => card(art, i, pieces, section))}</div>
                            )}
                        </section>
                    );
                })}
            </div>
        );
    }

    return (
        <PageRoot width="wide">
            <PageHeader title={title} subtitle={subtitle} actions={actions}
                onBack={openSection ? () => setOpenSectionId(null) : undefined}>
                <SearchBar value={query} onChange={setQuery} placeholder={openSection ? `Search ${openSection.name}…` : 'Search the roster…'} />
                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-1">
                    <Pill active={filter === 'all'} onClick={() => setFilter('all')} className="shrink-0">All</Pill>
                    <Pill active={filter === 'favorites'} onClick={() => setFilter('favorites')} className="shrink-0">
                        <span className="inline-flex items-center gap-1.5"><Heart size={11} fill={filter === 'favorites' ? 'currentColor' : 'none'} /> Favourites{favorites.size ? ` · ${favorites.size}` : ''}</span>
                    </Pill>
                    <Pill active={filter === 'available'} onClick={() => setFilter('available')} className="shrink-0">Available</Pill>
                    <span className="flex-1" />
                    <label className="sr-only" htmlFor="roster-sort">Sort by</label>
                    <select id="roster-sort" value={sort} onChange={e => setSort(e.target.value as RosterSort)}
                        className="neu-field !w-auto !py-1.5 !pl-3 !pr-8 !text-[11px] !rounded-full shrink-0">
                        {SORTS.map(s => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
                    </select>
                    <button type="button" onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
                        aria-label={density === 'compact' ? 'Show larger pieces' : 'Show more pieces at once'}
                        title={density === 'compact' ? 'Larger pieces' : 'More at once'}
                        className="neu-icon-btn-sm shrink-0 active-scale">
                        {density === 'compact' ? <Grid2x2 size={13} /> : <Grid3x3 size={13} />}
                    </button>
                </div>
            </PageHeader>

            <PageBody space="none">{body}</PageBody>

            {quick && (
                <RosterQuickView
                    pieces={quick.pieces}
                    index={quick.index}
                    onIndex={index => setQuick(prev => prev && { ...prev, index })}
                    displayFor={art => displayFor(art, quick.section)}
                    isFavorite={id => favorites.has(id)}
                    isSelected={selection.has}
                    onToggleFavorite={id => { void toggleFavorite(id); }}
                    onToggleSelect={selection.toggle}
                    onOpenRecord={can('inventory') ? art => { setQuick(null); onArtworkClick(art); } : undefined}
                    onClose={() => setQuick(null)}
                />
            )}

            {present && (
                <RosterPresent
                    title={present.name}
                    pieces={sortPieces(sectionPieces(present, byId), sort)}
                    priceDisplay={present.priceDisplay}
                    onClose={() => setPresent(null)}
                />
            )}

            {editing && (
                <RosterSectionEditor
                    section={editing === 'new' ? null : editing}
                    artworks={artworks}
                    onSaved={saved => {
                        setData(prev => prev && ({
                            ...prev,
                            sections: prev.sections.some(s => s.id === saved.id)
                                ? prev.sections.map(s => (s.id === saved.id ? saved : s))
                                : [...prev.sections, saved],
                        }));
                        setEditing(null);
                    }}
                    onDeleted={id => {
                        setData(prev => prev && ({ ...prev, sections: prev.sections.filter(s => s.id !== id) }));
                        setEditing(null);
                        if (openSectionId === id) setOpenSectionId(null);
                    }}
                    onClose={() => setEditing(null)}
                />
            )}

            {showSelection && (
                <RosterSelectionSheet
                    pieces={selectedPieces}
                    onRemove={selection.remove}
                    onClear={selection.clear}
                    onOpenPiece={art => setQuick({ pieces: selectedPieces, index: selectedPieces.indexOf(art), section: null })}
                    onAddInquiry={onAddInquiry}
                    onAddCollection={onAddCollection}
                    onClose={() => setShowSelection(false)}
                />
            )}
        </PageRoot>
    );
};
