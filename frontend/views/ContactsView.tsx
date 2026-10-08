import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Contact, ContactTag, Inquiry, NewContact } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import toast from 'react-hot-toast';
import { Users, UserPlus, Trash2, X, Phone, Mail, Upload, Download, Loader2, Edit2, Copy, Plus, Tags, CheckSquare, Square, Search } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, GhostIconButton, EmptyState } from '../components/ui';
import { IfCan, useAppChrome } from '../components/Layout';
import { contactService } from '../services/contactService';
import { contactWithKey, emailKey, phoneKey } from '../contactKeys';
import { useInbox } from '../hooks/useInbox';
import { realtimeService } from '../services/realtimeService';
import { currentWorkspace } from '../services/workspace';

interface ContactsViewProps {
    contacts: Contact[];
    inquiries: Inquiry[];
    onAddContact: (contact: NewContact) => Promise<void>;
    onUpdateContact: (contact: Contact) => Promise<void>;
    onImportContacts: (list: NewContact[]) => Promise<number>;
    onDeleteContact: (id: string) => void;
}

type SourceFilter = 'all' | Contact['source'];
type SortOrder = 'name' | 'added' | 'contacted';

const isNonEmptyCell = (cell: string): boolean => cell !== '';

/** Minimal CSV parser — handles quoted cells with embedded commas/newlines. */
interface CsvState { inQuotes: boolean; cell: string; row: string[]; rows: string[][] }

function endCell(st: CsvState): void {
    st.row.push(st.cell.trim());
    st.cell = '';
}

function endRow(st: CsvState): void {
    endCell(st);
    if (st.row.some(isNonEmptyCell)) st.rows.push(st.row);
    st.row = [];
}

/** A quote: inside a quoted cell a doubled quote is an escaped quote; otherwise it opens or closes quoting. */
function takeQuote(st: CsvState, next: string): number {
    if (st.inQuotes && next === '"') {
        st.cell += '"';
        return 1;
    }
    st.inQuotes = !st.inQuotes;
    return 0;
}

/** One character of the file; gives how many following characters it used too (an escaped quote, or \r\n). */
function takeChar(st: CsvState, ch: string, next: string): number {
    if (ch === '"') return takeQuote(st, next);
    if (st.inQuotes) { st.cell += ch; return 0; }
    if (ch === ',') { endCell(st); return 0; }
    if (ch === '\r' || ch === '\n') {
        endRow(st);
        return ch === '\r' && next === '\n' ? 1 : 0;
    }
    st.cell += ch;
    return 0;
}

function parseCsv(text: string): string[][] {
    const st: CsvState = { inQuotes: false, cell: '', row: [], rows: [] };
    for (let i = 0; i < text.length; i++) i += takeChar(st, text[i], text[i + 1] ?? '');
    endRow(st);
    return st.rows;
}

function csvEscape(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replaceAll(/"/g, '""')}"` : value;
}

const SOURCE_LABELS: Record<Contact['source'], string> = { inquiry: 'Inquiry', manual: 'Added', import: 'Imported' };

type CsvColumnMap = { name: number; phone: number; email: number; notes: number };

/** Map CSV header labels to column indexes, falling back to Name,Phone,Email,Notes order. */
function detectCsvColumns(header: string[]): CsvColumnMap {
    const indexOf = (label: string, fallback: number) =>
        header.includes(label) ? header.indexOf(label) : fallback;
    return {
        name: indexOf('name', 0),
        phone: indexOf('phone', 1),
        email: indexOf('email', 2),
        notes: indexOf('notes', 3),
    };
}

/** Read contact rows from parsed CSV; skips the header row when present. A cell may hold several values split by ";". */
function readCsvContacts(rows: string[][]): NewContact[] {
    if (rows.length === 0) return [];
    const header = rows[0].map(c => c.toLowerCase());
    const hasHeader = header.includes('name') || header.includes('phone') || header.includes('email');
    const map = hasHeader ? detectCsvColumns(header) : { name: 0, phone: 1, email: 2, notes: 3 };
    const split = (cell: string | undefined) => (cell ?? '').split(';').map(v => v.trim()).filter(Boolean);
    const out: NewContact[] = [];
    for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
        const r = rows[i];
        const phones = split(r[map.phone]);
        const emails = split(r[map.email]);
        const name = r[map.name] || '';
        if (!name && phones.length === 0 && emails.length === 0) continue;
        out.push({ name: name || phones[0] || emails[0], phone: phones[0] ?? '', email: emails[0], phones, emails, notes: r[map.notes] || undefined, source: 'import' });
    }
    return out;
}

// Static class names, so Tailwind keeps them.
export const TAG_COLORS: Record<string, string> = {
    gray: 'bg-gray-500/15 text-gray-700 dark:text-gray-300',
    gold: 'bg-gold-500/15 text-gold-700 dark:text-gold-300',
    red: 'bg-red-500/15 text-red-700 dark:text-red-300',
    orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    green: 'bg-green-500/15 text-green-700 dark:text-green-300',
    teal: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
    blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    purple: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
    pink: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
};

const TagChip: React.FC<{ tag: ContactTag; onRemove?: () => void }> = ({ tag, onRemove }) => (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${TAG_COLORS[tag.color] ?? TAG_COLORS.gray}`}>
        {tag.name}
        {onRemove && (
            <button type="button" onClick={onRemove} aria-label={`Remove tag ${tag.name}`} className="-mr-1 opacity-70 hover:opacity-100">
                <X size={11} />
            </button>
        )}
    </span>
);

const phonesOf = (c: Contact) => c.phones ?? [c.phone].filter(Boolean);
const emailsOf = (c: Contact) => c.emails ?? [c.email ?? ''].filter(Boolean);
const displayName = (c: Contact) => c.name || phonesOf(c)[0] || emailsOf(c)[0] || 'No name';
const dateText = (at?: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error(`Couldn't copy the ${what.toLowerCase()}`));
};

const PAGE = 60;

/** Where numbers typed without a country code are from (the server uses the same). */
const country = () => currentWorkspace()?.country ?? undefined;

export const ContactsView: React.FC<ContactsViewProps> = ({ contacts, inquiries, onAddContact, onUpdateContact, onImportContacts, onDeleteContact }) => {
    const { can } = useAppChrome();
    const canEdit = can('contacts', 'edit');
    const [searchQuery, setSearchQuery] = useState('');
    const query = useDeferredValue(searchQuery);
    const [source, setSource] = useState<SourceFilter>('all');
    const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
    const [sort, setSort] = useState<SortOrder>('name');
    const [shown, setShown] = useState(PAGE);
    const [open, setOpen] = useState<Contact | 'new' | null>(null);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [showTags, setShowTags] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // The organisation's tags (server: /contact-tags).
    const [tags, setTags] = useState<ContactTag[]>([]);
    const loadTags = useCallback(() => {
        contactService.getTags().then(setTags).catch(() => { /* offline: tags show again once back */ });
    }, []);
    useEffect(() => {
        loadTags();
        // Someone else changed the tags, or the socket reconnected after missing some.
        return realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && (event.events.length === 0 || event.events.some(e => e.entity === 'contact_tag'))) loadTags();
        });
    }, [loadTags]);
    const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags]);
    const tagCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const c of contacts) for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
        return counts;
    }, [contacts]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const qKey = phoneKey(q, country());
        const list = contacts.filter(c => {
            if (source !== 'all' && c.source !== source) return false;
            for (const t of tagFilter) if (!c.tags?.includes(t)) return false;
            if (!q) return true;
            return c.name.toLowerCase().includes(q)
                || phonesOf(c).some(p => p.toLowerCase().includes(q) || (qKey !== null && phoneKey(p, country()) === qKey))
                || emailsOf(c).some(e => e.toLowerCase().includes(q))
                || (c.notes ?? '').toLowerCase().includes(q)
                || SOURCE_LABELS[c.source].toLowerCase().includes(q)
                || (c.tags ?? []).some(t => tagById.get(t)?.name.toLowerCase().includes(q));
        });
        const order: Record<SortOrder, (a: Contact, b: Contact) => number> = {
            name: (a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }),
            added: (a, b) => b.createdAt - a.createdAt,
            contacted: (a, b) => (b.lastInteractionAt ?? 0) - (a.lastInteractionAt ?? 0),
        };
        return list.sort(order[sort]);
    }, [contacts, query, source, tagFilter, sort, tagById]);

    useEffect(() => setShown(PAGE), [query, source, tagFilter, sort]);

    const toggle = (set: Set<string>, id: string) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    };

    const bulkTag = async (tagId: string, add: boolean) => {
        const ids = [...selected];
        try {
            await contactService.bulkTags(ids, add ? [tagId] : [], add ? [] : [tagId]);
            toast.success(`${add ? 'Tagged' : 'Untagged'} ${ids.length} contact${ids.length === 1 ? '' : 's'}`);
        } catch (e) {
            toast.error(`Tags not changed: ${(e as Error).message}`);
        }
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow re-selecting the same file
        if (!file) return;
        setIsImporting(true);
        try {
            const text = await file.text();
            const rows = parseCsv(text);
            if (rows.length === 0) {
                toast.error('The CSV file is empty');
                return;
            }
            const list = readCsvContacts(rows);
            if (list.length === 0) {
                toast.error('No valid rows — each row needs a name, phone or email');
                return;
            }
            const imported = await onImportContacts(list);
            toast.success(`Imported ${imported} contact${imported === 1 ? '' : 's'}`);
        } catch (err) {
            console.error('CSV import failed:', err);
            toast.error('Import failed — could not read the file as CSV');
        } finally {
            setIsImporting(false);
        }
    };

    const handleExport = () => {
        const header = 'Name,Phone,Email,Tags,Source,Notes';
        const lines = filtered.map(c => [
            c.name, phonesOf(c).join('; '), emailsOf(c).join('; '),
            (c.tags ?? []).map(t => tagById.get(t)?.name).filter(Boolean).join('; '),
            SOURCE_LABELS[c.source], c.notes || '',
        ].map(csvEscape).join(','));
        const blob = new Blob(['﻿' + header + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${filtered.length} contact${filtered.length === 1 ? '' : 's'}`);
    };

    const chip = (active: boolean) => `shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-colors active-scale ${active
        ? 'neu-inset text-gold-700 dark:text-gold-300'
        : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'}`;

    return (
        <PageRoot>
            <PageHeader
                title="Contacts"
                actions={(
                    <>
                        <GhostIconButton onClick={handleExport} label="Export these contacts as CSV" icon={<Download size={16} />} disabled={filtered.length === 0} />
                        <IfCan section="contacts"><GhostIconButton onClick={() => fileInputRef.current?.click()} label="Import contacts from CSV" icon={isImporting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} disabled={isImporting} /></IfCan>
                        <GhostIconButton onClick={() => setShowTags(true)} label="Tags" icon={<Tags size={16} />} />
                        <IfCan section="contacts"><PrimaryIconButton onClick={() => setOpen('new')} label="Add contact" icon={<UserPlus size={16} />} /></IfCan>
                        <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
                    </>
                )}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search name, phone, email, tag…" />
                <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                    {(['all', 'inquiry', 'manual', 'import'] as SourceFilter[]).map(id => (
                        <button key={id} onClick={() => setSource(id)} aria-pressed={source === id} className={chip(source === id)}>
                            {id === 'all' ? 'All' : SOURCE_LABELS[id]}
                        </button>
                    ))}
                    {tags.map(t => (
                        <button key={t.id} onClick={() => setTagFilter(prev => toggle(prev, t.id))} aria-pressed={tagFilter.has(t.id)} className={chip(tagFilter.has(t.id))}>
                            {t.name} <span className="font-normal opacity-70">{tagCounts.get(t.id) ?? 0}</span>
                        </button>
                    ))}
                </div>
            </PageHeader>

            <PageBody space="md">
                <div className="flex items-center gap-2 text-[11px] text-[var(--neu-text-dim)]">
                    <span className="flex-1">{filtered.length} contact{filtered.length === 1 ? '' : 's'}</span>
                    <label className="flex items-center gap-1.5">
                        <span className="sr-only">Sort</span>
                        <select value={sort} onChange={e => setSort(e.target.value as SortOrder)} className="w-auto bg-transparent text-[11px] uppercase tracking-wider text-gray-700 dark:text-gray-300">
                            <option value="name">A–Z</option>
                            <option value="added">Recently added</option>
                            <option value="contacted">Recently contacted</option>
                        </select>
                    </label>
                    {canEdit && (
                        <button type="button" onClick={() => { setSelecting(s => !s); setSelected(new Set()); }} className="uppercase tracking-wider text-gray-700 dark:text-gray-300 px-2 py-1">
                            {selecting ? 'Done' : 'Select'}
                        </button>
                    )}
                </div>

                {selecting && (
                    <div className="neu-card p-3 flex flex-wrap items-center gap-2 text-[12px]">
                        <button type="button" onClick={() => setSelected(new Set(filtered.map(c => c.id)))} className="underline-offset-2 hover:underline">Select all {filtered.length}</button>
                        <span className="text-[var(--neu-text-dim)]">· {selected.size} selected</span>
                        {selected.size > 0 && tags.length > 0 && (
                            <>
                                <select
                                    value=""
                                    onChange={e => { if (e.target.value) void bulkTag(e.target.value, true); }}
                                    className="neu-field !w-auto !py-1 text-[12px]"
                                    aria-label="Add a tag to the selected contacts"
                                >
                                    <option value="">Add tag…</option>
                                    {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                                <select
                                    value=""
                                    onChange={e => { if (e.target.value) void bulkTag(e.target.value, false); }}
                                    className="neu-field !w-auto !py-1 text-[12px]"
                                    aria-label="Remove a tag from the selected contacts"
                                >
                                    <option value="">Remove tag…</option>
                                    {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            </>
                        )}
                        {tags.length === 0 && <button type="button" onClick={() => setShowTags(true)} className="text-gold-700 dark:text-gold-300">Create a tag first</button>}
                    </div>
                )}

                <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                    {filtered.slice(0, shown).map(contact => {
                        const isSelected = selected.has(contact.id);
                        const phone = phonesOf(contact)[0];
                        const email = emailsOf(contact)[0];
                        return (
                            <li key={contact.id} className="neu-card relative p-3 flex items-center gap-3 min-h-[72px]">
                                <button
                                    type="button"
                                    onClick={() => (selecting ? setSelected(prev => toggle(prev, contact.id)) : setOpen(contact))}
                                    aria-label={selecting ? `${isSelected ? 'Unselect' : 'Select'} ${displayName(contact)}` : `Open ${displayName(contact)}`}
                                    className="absolute inset-0 rounded-[inherit]"
                                />
                                {selecting
                                    ? <span className="w-10 h-10 flex items-center justify-center shrink-0 text-gold-600 dark:text-gold-400">{isSelected ? <CheckSquare size={18} /> : <Square size={18} />}</span>
                                    : <span className="w-10 h-10 rounded-full neu-inset flex items-center justify-center font-serif text-base text-[var(--neu-gold)] shrink-0">{displayName(contact).charAt(0).toUpperCase()}</span>}
                                <div className="flex-1 min-w-0 pointer-events-none">
                                    <div className="flex items-baseline gap-2">
                                        <h3 className="flex-1 min-w-0 font-serif text-[14.5px] leading-snug text-[var(--neu-text)] truncate">{displayName(contact)}</h3>
                                        {contact.lastInteractionAt && <span className="shrink-0 text-[10.5px] text-[var(--neu-text-dim)] tabular-nums">{dateText(contact.lastInteractionAt)}</span>}
                                    </div>
                                    <p className="text-[11.5px] text-[var(--neu-text-dim)] truncate tabular-nums">
                                        {[phone, email].filter(Boolean).join(' · ') || SOURCE_LABELS[contact.source]}
                                    </p>
                                    {(contact.tags?.length ?? 0) > 0 && (
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {contact.tags!.map(t => tagById.get(t)).filter((t): t is ContactTag => !!t).map(t => <TagChip key={t.id} tag={t} />)}
                                        </div>
                                    )}
                                </div>
                                {!selecting && phone && (
                                    <a href={`tel:${phone}`} aria-label={`Call ${displayName(contact)}`} className="relative neu-icon-btn neu-btn active-scale text-[var(--neu-gold)] shrink-0">
                                        <Phone size={15} />
                                    </a>
                                )}
                            </li>
                        );
                    })}
                </ul>
                {filtered.length > shown && (
                    <button type="button" onClick={() => setShown(s => s + PAGE)} className="w-full py-3 text-[12px] uppercase tracking-wider text-gray-700 dark:text-gray-300">
                        Show more ({filtered.length - shown})
                    </button>
                )}
                {filtered.length === 0 && (
                    <EmptyState
                        icon={<Users size={22} strokeWidth={1.25} />}
                        title={contacts.length === 0 ? 'No contacts yet' : 'No matches'}
                        message={contacts.length === 0
                            ? 'People who send an inquiry are saved here by their phone or email. You can also add contacts or import a CSV.'
                            : 'No contacts match your search or filters.'}
                    />
                )}
            </PageBody>

            {open && (
                <ContactSheet
                    contact={open === 'new' ? null : contacts.find(c => c.id === open.id) ?? open}
                    contacts={contacts}
                    inquiries={inquiries}
                    tags={tags}
                    canEdit={canEdit}
                    onClose={() => setOpen(null)}
                    onOpenOther={c => setOpen(c)}
                    onAdd={onAddContact}
                    onUpdate={onUpdateContact}
                    onDelete={onDeleteContact}
                />
            )}
            {showTags && <TagManager tags={tags} counts={tagCounts} canEdit={canEdit} onChanged={loadTags} onClose={() => setShowTags(false)} />}
        </PageRoot>
    );
};

/**
 * A centred popup card over the page (as the Calendar's month), on phones
 * too; a tap outside it closes it like the ✕.
 */
const Popup = React.forwardRef<HTMLDivElement, { label: string; width: string; onClose: () => void; children: React.ReactNode }>(
    ({ label, width, onClose, children }, ref) => (
        <div
            className="absolute inset-0 flex items-center justify-center p-4 pt-[calc(1rem+var(--safe-top))] pb-[calc(1rem+var(--safe-bottom-ui,0px))]"
            style={{ backgroundColor: 'rgba(15, 17, 22, 0.45)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
            onClick={onClose}
        >
            <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-label={label}
                onClick={e => e.stopPropagation()}
                className="neu-raised rounded-3xl bg-[var(--neu-bg)] w-full max-h-full flex flex-col overflow-hidden animate-fade-in-up"
                style={{ maxWidth: width }}
            >
                {children}
            </div>
        </div>
    ),
);

/** Closes on Escape; focuses the sheet's first control. */
function useSheetKeys(onClose: () => void) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        ref.current?.querySelector<HTMLElement>('button, input')?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    return ref;
}

interface Draft { name: string; phones: string[]; emails: string[]; notes: string; tags: string[] }

const draftOf = (c: Contact | null): Draft => ({
    name: c?.name ?? '',
    phones: c ? [...phonesOf(c)] : [''],
    emails: c ? [...emailsOf(c)] : [''],
    notes: c?.notes ?? '',
    tags: [...(c?.tags ?? [])],
});

const clean = (list: string[]) => list.map(v => v.trim()).filter(Boolean);

/** One contact: its details and history, edited in place. `contact` null: a new one. */
const ContactSheet: React.FC<{
    contact: Contact | null;
    contacts: Contact[];
    inquiries: Inquiry[];
    tags: ContactTag[];
    canEdit: boolean;
    onClose: () => void;
    onOpenOther: (c: Contact) => void;
    onAdd: (c: NewContact) => Promise<void>;
    onUpdate: (c: Contact) => Promise<void>;
    onDelete: (id: string) => void;
}> = ({ contact, contacts, inquiries, tags, canEdit, onClose, onOpenOther, onAdd, onUpdate, onDelete }) => {
    const [editing, setEditing] = useState(contact === null);
    const [draft, setDraft] = useState<Draft>(() => draftOf(contact));
    const [confirmDelete, setConfirmDelete] = useState(false);
    const { openLink } = useInbox();
    const dirty = editing && JSON.stringify(draft) !== JSON.stringify(draftOf(contact));

    const requestClose = useCallback(() => {
        if (dirty && !globalThis.confirm('Discard your changes to this contact?')) return;
        onClose();
    }, [dirty, onClose]);
    const ref = useSheetKeys(requestClose);

    const related = useMemo(
        () => (contact ? inquiries.filter(i => i.contactId === contact.id).sort((a, b) => b.date - a.date) : []),
        [contact, inquiries],
    );
    const tagById = new Map(tags.map(t => [t.id, t]));

    // Problems shown before saving; the server checks the same again.
    const problems = useMemo(() => {
        const out: { text: string; other?: Contact }[] = [];
        if (!draft.name.trim()) out.push({ text: 'Add a name.' });
        if (clean(draft.phones).length === 0 && clean(draft.emails).length === 0) out.push({ text: 'Add a phone number or an email.' });
        for (const p of clean(draft.phones)) {
            if (!phoneKey(p, country())) { out.push({ text: `"${p}" doesn't look like a phone number.` }); continue; }
            const other = contactWithKey(contacts.filter(c => c.id !== contact?.id), phoneKey(p, country()), country());
            if (other) out.push({ text: `${displayName(other)} already has ${p}.`, other });
        }
        for (const e of clean(draft.emails)) {
            if (!emailKey(e)) { out.push({ text: `"${e}" doesn't look like an email address.` }); continue; }
            const other = contactWithKey(contacts.filter(c => c.id !== contact?.id), emailKey(e), country());
            if (other) out.push({ text: `${displayName(other)} already has ${e}.`, other });
        }
        return out;
    }, [draft, contacts, contact]);

    const save = async () => {
        if (problems.length > 0) return;
        const fields = { name: draft.name.trim(), phones: clean(draft.phones), emails: clean(draft.emails), notes: draft.notes.trim() || undefined, tags: draft.tags };
        const firsts = { phone: fields.phones[0] ?? '', email: fields.emails[0] };
        if (contact) {
            await onUpdate({ ...contact, ...fields, ...firsts });
            setEditing(false);
        } else {
            await onAdd({ ...fields, ...firsts, source: 'manual' });
            onClose();
        }
    };

    const setList = (field: 'phones' | 'emails', index: number, value: string | null) => setDraft(d => {
        const list = [...d[field]];
        if (value === null) list.splice(index, 1); else list[index] = value;
        return { ...d, [field]: list };
    });

    const listEditor = (field: 'phones' | 'emails', label: string, type: string, placeholder: string) => (
        <fieldset>
            <legend className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">{label}</legend>
            <div className="space-y-2">
                {draft[field].map((value, i) => (
                    <div key={i} className="flex gap-2">
                        <input type={type} value={value} onChange={e => setList(field, i, e.target.value)} placeholder={placeholder}
                            aria-label={`${label} ${i + 1}`} autoComplete="off" spellCheck={false} className="neu-field flex-1" />
                        <button type="button" onClick={() => setList(field, i, null)} aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} className="neu-icon-btn shrink-0 text-gray-500">
                            <X size={15} />
                        </button>
                    </div>
                ))}
                <button type="button" onClick={() => setDraft(d => ({ ...d, [field]: [...d[field], ''] }))} className="flex items-center gap-1.5 text-[12px] text-gold-700 dark:text-gold-300">
                    <Plus size={13} /> Add {field === 'phones' ? 'phone number' : 'email'}
                </button>
            </div>
        </fieldset>
    );

    const row = (icon: React.ReactNode, value: string, href: string, what: string) => (
        <div key={value} className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
            <a href={href} className="flex-1 min-w-0 flex items-center gap-3 truncate hover:text-gold-600 dark:hover:text-gold-400">{icon}<span className="truncate tabular-nums">{value}</span></a>
            <button type="button" onClick={() => copy(value, what)} aria-label={`Copy ${value}`} className="neu-icon-btn-sm shrink-0 text-gray-500"><Copy size={13} /></button>
        </div>
    );

    let title = 'New contact';
    if (contact) title = editing ? 'Edit contact' : displayName(contact);

    return (
        <FullScreenPortal>
            <Popup ref={ref} label={title} width="560px" onClose={requestClose}>
                <div className="flex justify-between items-center gap-2 p-3">
                    <button onClick={editing && contact ? () => { setDraft(draftOf(contact)); setEditing(false); } : requestClose}
                        className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale shrink-0" aria-label={editing && contact ? 'Cancel editing' : 'Close'}>
                        <X size={20} />
                    </button>
                    <h2 className="flex-1 min-w-0 text-center text-base font-serif text-gray-900 dark:text-white truncate">{title}</h2>
                    {editing ? (
                        <button type="button" onClick={() => void save()} disabled={problems.length > 0}
                            className="shrink-0 text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs disabled:opacity-40">
                            Save
                        </button>
                    ) : (
                        canEdit && <button type="button" onClick={() => setEditing(true)} aria-label="Edit contact" className="neu-icon-btn text-gray-700 dark:text-gray-300 shrink-0"><Edit2 size={17} /></button>
                    )}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 pt-1 space-y-5">
                    {editing ? (
                        <>
                            <div>
                                <label htmlFor="contact-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Name</label>
                                <input id="contact-name" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} placeholder="Full name" autoComplete="off" spellCheck={false} className="neu-field" />
                            </div>
                            {listEditor('phones', 'Phone', 'tel', '+91 98765 43210')}
                            {listEditor('emails', 'Email', 'email', 'name@example.com')}
                            <div>
                                <label htmlFor="contact-notes" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Notes</label>
                                <textarea id="contact-notes" value={draft.notes} onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))} rows={3} className="neu-field" />
                            </div>
                            {tags.length > 0 && (
                                <fieldset>
                                    <legend className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Tags</legend>
                                    <div className="flex flex-wrap gap-1.5">
                                        {tags.map(t => {
                                            const on = draft.tags.includes(t.id);
                                            return (
                                                <button key={t.id} type="button" aria-pressed={on}
                                                    onClick={() => setDraft(d => ({ ...d, tags: on ? d.tags.filter(x => x !== t.id) : [...d.tags, t.id] }))}
                                                    className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium ${on ? TAG_COLORS[t.color] ?? TAG_COLORS.gray : 'neu-raised-sm neu-btn text-gray-600 dark:text-gray-300'}`}>
                                                    {t.name}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </fieldset>
                            )}
                            {problems.length > 0 && dirty && (
                                <ul className="text-[12px] text-red-700 dark:text-red-300 space-y-1" aria-live="polite">
                                    {problems.map(p => (
                                        <li key={p.text}>
                                            {p.text} {p.other && <button type="button" onClick={() => onOpenOther(p.other!)} className="underline">Open {displayName(p.other)}</button>}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </>
                    ) : contact && (
                        <>
                            <section className="space-y-2.5">
                                {phonesOf(contact).map(p => row(<Phone size={14} className="text-gold-500 shrink-0" />, p, `tel:${p}`, 'Phone number'))}
                                {emailsOf(contact).map(e => row(<Mail size={14} className="text-gold-500 shrink-0" />, e, `mailto:${e}`, 'Email'))}
                            </section>
                            {(contact.tags?.length ?? 0) > 0 && (
                                <div className="flex flex-wrap gap-1.5">
                                    {contact.tags!.map(t => tagById.get(t)).filter((t): t is ContactTag => !!t).map(t => <TagChip key={t.id} tag={t} />)}
                                </div>
                            )}
                            {contact.notes && <p className="text-[13px] whitespace-pre-wrap text-gray-700 dark:text-gray-300">{contact.notes}</p>}
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-[var(--neu-text-dim)]">
                                <dt>Source</dt><dd>{SOURCE_LABELS[contact.source]}</dd>
                                <dt>Added</dt><dd>{dateText(contact.createdAt)}{contact.createdByName ? ` by ${contact.createdByName}` : ''}</dd>
                                {contact.lastInteractionAt && <><dt>Last inquiry</dt><dd>{dateText(contact.lastInteractionAt)}</dd></>}
                            </dl>
                            <section>
                                <h3 className="text-[11px] font-bold uppercase tracking-widest text-gray-900 dark:text-gray-100 mb-2">Inquiries ({related.length})</h3>
                                {related.length === 0 && <p className="text-[12px] text-[var(--neu-text-dim)]">None yet.</p>}
                                <ul className="space-y-1.5">
                                    {related.map(i => (
                                        <li key={i.id}>
                                            <button type="button" onClick={() => { onClose(); openLink({ view: 'inquiry', inquiryId: i.id }); }}
                                                className="w-full neu-raised-sm neu-btn rounded-xl px-3 py-2 flex items-center gap-2 text-left text-[12.5px]">
                                                <Search size={12} className="shrink-0 text-gold-600 dark:text-gold-400" />
                                                <span className="flex-1 min-w-0 truncate">{i.inquiryNumber} · {i.status}</span>
                                                <span className="shrink-0 text-[11px] text-[var(--neu-text-dim)]">{dateText(i.date)}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                            {canEdit && (
                                <button type="button" onClick={() => setConfirmDelete(true)} className="neu-button neu-button-danger w-full">
                                    <Trash2 size={14} /> Delete contact
                                </button>
                            )}
                        </>
                    )}
                </div>
            </Popup>
            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete contact"
                itemName={contact ? displayName(contact) : ''}
                message="it will be archived for admin review; its inquiries stay"
                onClose={() => setConfirmDelete(false)}
                onConfirm={() => {
                    if (contact) onDelete(contact.id);
                    setConfirmDelete(false);
                    onClose();
                    toast.success('Contact deleted');
                }}
            />
        </FullScreenPortal>
    );
};

/** The organisation's tags: create, rename, recolour, delete. */
const TagManager: React.FC<{
    tags: ContactTag[];
    counts: Map<string, number>;
    canEdit: boolean;
    onChanged: () => void;
    onClose: () => void;
}> = ({ tags, counts, canEdit, onChanged, onClose }) => {
    const ref = useSheetKeys(onClose);
    const [name, setName] = useState('');
    const [color, setColor] = useState('gold');
    const [busy, setBusy] = useState(false);
    const [deleting, setDeleting] = useState<ContactTag | null>(null);

    const run = async (work: () => Promise<unknown>, done: string) => {
        setBusy(true);
        try {
            await work();
            toast.success(done);
            onChanged();
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <FullScreenPortal>
            <Popup ref={ref} label="Tags" width="480px" onClose={onClose}>
                <div className="flex justify-between items-center p-3">
                    <button onClick={onClose} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale" aria-label="Close"><X size={20} /></button>
                    <h2 className="text-base font-serif text-gray-900 dark:text-white">Tags</h2>
                    <div className="w-9" />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 pt-1 space-y-4">
                    {canEdit && (
                        <form className="neu-card p-3 space-y-3" onSubmit={e => {
                            e.preventDefault();
                            if (name.trim()) void run(() => contactService.saveTag({ name, color }).then(() => setName('')), 'Tag created');
                        }}>
                            <div className="flex gap-2">
                                <input value={name} onChange={e => setName(e.target.value)} maxLength={40} placeholder="New tag, e.g. Architect" aria-label="New tag name" className="neu-field flex-1" />
                                <button type="submit" disabled={busy || !name.trim()} className="neu-raised-sm neu-btn rounded-xl px-4 text-[12px] uppercase tracking-wider text-gold-700 dark:text-gold-300 disabled:opacity-40">Add</button>
                            </div>
                            <ColorPicker value={color} onChange={setColor} />
                        </form>
                    )}
                    <ul className="space-y-2">
                        {tags.map(t => (
                            <TagRow key={t.id} tag={t} count={counts.get(t.id) ?? 0} canEdit={canEdit} busy={busy}
                                onSave={(n, c) => run(() => contactService.saveTag({ id: t.id, name: n, color: c }), 'Tag saved')}
                                onDelete={() => setDeleting(t)} />
                        ))}
                        {tags.length === 0 && <li className="py-10 text-center text-sm text-[var(--neu-text-dim)]">No tags yet. Tags like "VIP Client" or "Architect" help you find people later.</li>}
                    </ul>
                </div>
            </Popup>
            <TypeDeleteDialog
                isOpen={!!deleting}
                title="Delete tag"
                itemName={deleting?.name ?? ''}
                message="it comes off every contact; the contacts stay"
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    const tag = deleting;
                    setDeleting(null);
                    if (tag) void run(() => contactService.deleteTag(tag.id), 'Tag deleted');
                }}
            />
        </FullScreenPortal>
    );
};

const ColorPicker: React.FC<{ value: string; onChange: (c: string) => void }> = ({ value, onChange }) => (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Tag colour">
        {Object.keys(TAG_COLORS).map(c => (
            <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} onClick={() => onChange(c)}
                className={`w-7 h-7 rounded-full ${TAG_COLORS[c]} ${value === c ? 'ring-2 ring-offset-2 ring-gold-500 ring-offset-[var(--neu-bg)]' : ''}`} />
        ))}
    </div>
);

const TagRow: React.FC<{
    tag: ContactTag; count: number; canEdit: boolean; busy: boolean;
    onSave: (name: string, color: string) => Promise<void>; onDelete: () => void;
}> = ({ tag, count, canEdit, busy, onSave, onDelete }) => {
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(tag.name);
    const [color, setColor] = useState(tag.color);
    if (editing) {
        return (
            <li className="neu-card p-3 space-y-3">
                <input value={name} onChange={e => setName(e.target.value)} maxLength={40} aria-label="Tag name" className="neu-field" />
                <ColorPicker value={color} onChange={setColor} />
                <div className="flex justify-end gap-3 text-[12px] uppercase tracking-wider">
                    <button type="button" onClick={() => { setEditing(false); setName(tag.name); setColor(tag.color); }}>Cancel</button>
                    <button type="button" disabled={busy || !name.trim()} onClick={() => void onSave(name, color).then(() => setEditing(false))} className="text-gold-700 dark:text-gold-300 disabled:opacity-40">Save</button>
                </div>
            </li>
        );
    }
    return (
        <li className="neu-card px-3 py-2.5 flex items-center gap-2">
            <TagChip tag={tag} />
            <span className="flex-1 text-[11.5px] text-[var(--neu-text-dim)]">{count} contact{count === 1 ? '' : 's'}</span>
            {canEdit && (
                <>
                    <button type="button" onClick={() => setEditing(true)} aria-label={`Edit tag ${tag.name}`} className="neu-icon-btn-sm text-gray-500"><Edit2 size={13} /></button>
                    <button type="button" onClick={onDelete} aria-label={`Delete tag ${tag.name}`} className="neu-icon-btn-sm text-gray-500"><Trash2 size={13} /></button>
                </>
            )}
        </li>
    );
};
