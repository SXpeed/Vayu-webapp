import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowUp, Check, GripVertical, Loader2, Trash2, X } from 'lucide-react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { TypeDeleteDialog } from '../../components/TypeDeleteDialog';
import { ArtworkPicker } from '../../components/ArtworkPicker';
import { Field, Input, Pill, Textarea, ToggleRow } from '../../components/ui';
import { getThumbUrl } from '../../services/storageService';
import { rosterService, StaleSectionError, type RosterSectionInput } from '../../services/rosterService';
import type { Artwork, RosterBackdrop, RosterPriceDisplay, RosterSection } from '../../types';
import { BACKDROP_CLASS, BACKDROP_LABEL, PRICE_LABEL } from './rosterShared';

/** Mirrors MAX_SECTION_ARTWORKS on the server (roster.ts). */
const MAX_PIECES = 300;

interface RosterSectionEditorProps {
    /** Null for a new section. */
    section: RosterSection | null;
    artworks: Artwork[];
    onSaved: (section: RosterSection) => void;
    onDeleted: (id: string) => void;
    onClose: () => void;
}

const PRICE_OPTIONS: RosterPriceDisplay[] = ['request', 'price', 'hidden'];
const BACKDROPS: RosterBackdrop[] = ['studio', 'ivory', 'charcoal', 'none'];

/**
 * Creating or changing one Roster section: its name and note, how prices
 * read, the backdrop, and which pieces it shows in what order. Opened only
 * for people whose role can curate the Roster; the server checks again.
 */
export const RosterSectionEditor: React.FC<RosterSectionEditorProps> = ({ section, artworks, onSaved, onDeleted, onClose }) => {
    const [name, setName] = useState(section?.name ?? '');
    const [description, setDescription] = useState(section?.description ?? '');
    const [priceDisplay, setPriceDisplay] = useState<RosterPriceDisplay>(section?.priceDisplay ?? 'request');
    const [backdrop, setBackdrop] = useState<RosterBackdrop>(section?.backdrop ?? 'studio');
    const [hideSold, setHideSold] = useState(section?.hideSold ?? false);
    const byId = useMemo(() => new Map(artworks.map(a => [a.id, a])), [artworks]);
    // Pieces deleted from the inventory since are dropped from the list.
    const [chosen, setChosen] = useState<string[]>(() => (section?.artworkIds ?? []).filter(id => byId.has(id)));
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [dragFrom, setDragFrom] = useState<number | null>(null);
    // A newer version saved by someone else while this form was open.
    const [base, setBase] = useState<RosterSection | null>(section);

    const chosenSet = useMemo(() => new Set(chosen), [chosen]);

    const toggle = (id: string) => {
        setChosen(prev => {
            if (prev.includes(id)) return prev.filter(x => x !== id);
            if (prev.length >= MAX_PIECES) {
                toast.error(`A section can hold up to ${MAX_PIECES} pieces`);
                return prev;
            }
            return [...prev, id];
        });
    };

    const move = (from: number, to: number) => {
        if (to < 0 || to >= chosen.length || from === to) return;
        setChosen(prev => {
            const next = [...prev];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return next;
        });
    };

    const save = async () => {
        if (!name.trim()) { toast.error('Give the section a name'); return; }
        setSaving(true);
        const input: RosterSectionInput = { name: name.trim(), description: description.trim(), artworkIds: chosen, priceDisplay, backdrop, hideSold };
        try {
            const saved = base ? await rosterService.update(base, input) : await rosterService.create(input);
            toast.success(base ? 'Section saved' : 'Section added to the roster');
            onSaved(saved);
        } catch (e) {
            if (e instanceof StaleSectionError) {
                // Keep what was typed here; the next save goes on top of theirs.
                toast.error(`${e.message} Review and save again to keep yours.`, { duration: 7000 });
                if (e.latest) setBase(e.latest);
            } else {
                toast.error((e as Error).message || 'Could not save the section');
            }
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!section) return;
        setConfirmDelete(false);
        try {
            await rosterService.remove(section.id);
            toast.success('Section removed. The pieces stay in the inventory.');
            onDeleted(section.id);
        } catch (e) {
            toast.error((e as Error).message || 'Could not remove the section');
        }
    };

    return (
        <FullScreenPortal>
            <div className="neu-sheet-wide animate-fade-in-up" role="dialog" aria-modal="true" aria-label={section ? 'Edit roster section' : 'New roster section'}>
                <div className="flex justify-between items-center gap-3 px-3 pb-2" style={{ paddingTop: 'calc(0.75rem + var(--safe-top))' }}>
                    <button type="button" onClick={onClose} aria-label="Close" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale">
                        <X size={20} />
                    </button>
                    <h2 className="text-base font-serif text-gray-900 dark:text-white truncate">{section ? 'Edit section' : 'New section'}</h2>
                    <div className="flex items-center gap-2">
                        {section && (
                            <button type="button" onClick={() => setConfirmDelete(true)} aria-label="Remove section" className="neu-icon-btn text-red-500 active-scale">
                                <Trash2 size={17} />
                            </button>
                        )}
                        <button type="button" onClick={() => { void save(); }} disabled={saving}
                            className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale disabled:opacity-50 inline-flex items-center gap-1.5">
                            {saving && <Loader2 size={13} className="animate-spin" />} Save
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 lg:px-6 pb-[calc(2rem+var(--safe-bottom-ui))] lg:pb-6">
                    <div className="lg:grid lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-6 lg:items-start space-y-5 lg:space-y-0">
                        {/* Settings */}
                        <div className="space-y-5">
                            <div className="neu-card p-4 space-y-4">
                                <Field label="Section name" htmlFor="roster-name">
                                    <Input id="roster-name" value={name} maxLength={80} onChange={e => setName(e.target.value)}
                                        placeholder="e.g. Jenjum Gadi collection" className="font-serif text-base" />
                                </Field>
                                <Field label="Note (optional)" htmlFor="roster-note" hint="Shown under the name.">
                                    <Textarea id="roster-note" value={description} maxLength={500} rows={2} onChange={e => setDescription(e.target.value)}
                                        placeholder="Hand-chased brass from the Kerala workshop" className="resize-none" />
                                </Field>
                            </div>

                            <div className="neu-card p-4 space-y-4">
                                <div>
                                    <p className="neu-label">Prices</p>
                                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How prices show">
                                        {PRICE_OPTIONS.map(opt => (
                                            <Pill key={opt} active={priceDisplay === opt} onClick={() => setPriceDisplay(opt)}>{PRICE_LABEL[opt]}</Pill>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <p className="neu-label">Backdrop</p>
                                    <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Backdrop">
                                        {BACKDROPS.map(b => (
                                            <button key={b} type="button" role="radio" aria-checked={backdrop === b} onClick={() => setBackdrop(b)}
                                                className={`rounded-xl p-1.5 text-center active-scale ${backdrop === b ? 'neu-inset' : 'neu-raised-sm'}`}>
                                                <span className={`block aspect-square rounded-lg ${b === 'none' ? 'neu-inset' : BACKDROP_CLASS[b]} relative`}>
                                                    {backdrop === b && <Check size={14} className="absolute inset-0 m-auto text-gold-400" strokeWidth={3} />}
                                                </span>
                                                <span className="mt-1 block text-[9.5px] leading-tight uppercase tracking-wider text-[var(--neu-text-dim)]">{BACKDROP_LABEL[b]}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <ToggleRow title="Leave out sold pieces" description="They stay in the section and come back if the sale falls through."
                                    checked={hideSold} onChange={() => setHideSold(v => !v)} />
                            </div>

                            {/* Chosen pieces, in order */}
                            <div className="neu-card p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <p className="neu-label !mb-0">In this section · {chosen.length}</p>
                                    {chosen.length > 0 && (
                                        <button type="button" onClick={() => setChosen([])} className="text-[10.5px] uppercase tracking-wider text-[var(--neu-text-dim)] hover:text-red-500 active-scale">Clear</button>
                                    )}
                                </div>
                                {chosen.length === 0 ? (
                                    <p className="text-[12.5px] text-[var(--neu-text-dim)]">Choose pieces from the inventory. They show in the order listed here.</p>
                                ) : (
                                    <ol className="space-y-1.5 max-h-[22rem] overflow-y-auto no-scrollbar -mx-1 px-1 py-1">
                                        {chosen.map((id, i) => {
                                            const art = byId.get(id);
                                            if (!art) return null;
                                            return (
                                                <li key={id}
                                                    draggable
                                                    onDragStart={() => setDragFrom(i)}
                                                    onDragOver={e => e.preventDefault()}
                                                    onDrop={() => { if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}
                                                    onDragEnd={() => setDragFrom(null)}
                                                    className={`flex items-center gap-2 rounded-xl px-1.5 py-1 ${dragFrom === i ? 'opacity-50' : ''} neu-raised-sm`}>
                                                    <GripVertical size={14} className="shrink-0 text-[var(--neu-text-dim)] cursor-grab hidden md:block" aria-hidden="true" />
                                                    <span className="text-[10.5px] w-5 text-center tabular-nums text-[var(--neu-text-dim)]">{i + 1}</span>
                                                    <span className={`w-9 h-9 shrink-0 rounded-lg overflow-hidden ${BACKDROP_CLASS[backdrop]}`}>
                                                        {art.imageUrls[0] && <img src={getThumbUrl(art.imageUrls[0])} alt="" loading="lazy" className="w-full h-full object-contain" />}
                                                    </span>
                                                    <span className="flex-1 min-w-0 text-[12.5px] truncate text-[var(--neu-text)]">{art.title}</span>
                                                    <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${art.title} up`} className="neu-icon-btn-sm !w-7 !h-7 disabled:opacity-30 active-scale"><ArrowUp size={12} /></button>
                                                    <button type="button" onClick={() => move(i, i + 1)} disabled={i === chosen.length - 1} aria-label={`Move ${art.title} down`} className="neu-icon-btn-sm !w-7 !h-7 disabled:opacity-30 active-scale"><ArrowDown size={12} /></button>
                                                    <button type="button" onClick={() => toggle(id)} aria-label={`Take ${art.title} out`} className="neu-icon-btn-sm !w-7 !h-7 hover:text-red-500 active-scale"><X size={12} /></button>
                                                </li>
                                            );
                                        })}
                                    </ol>
                                )}
                            </div>
                        </div>

                        {/* Picker */}
                        <ArtworkPicker artworks={artworks} selected={chosenSet} onToggle={toggle} backdrop={backdrop}
                            searchPlaceholder="Search the inventory…"
                            onAddMany={ids => setChosen(prev => [...prev, ...ids].slice(0, MAX_PIECES))} />
                    </div>
                </div>
            </div>
            <TypeDeleteDialog
                isOpen={confirmDelete}
                onClose={() => setConfirmDelete(false)}
                title="Remove this section?"
                itemName={section?.name ?? ''}
                message="Only the section goes: its pieces stay in the inventory and in any other section. An admin can see it under Deleted."
                onConfirm={() => { void remove(); }}
            />
        </FullScreenPortal>
    );
};
