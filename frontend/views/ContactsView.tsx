import React, { useMemo, useRef, useState } from 'react';
import { Contact, Inquiry, NewContact } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import toast from 'react-hot-toast';
import { Users, UserPlus, Trash2, X, Phone, Mail, Upload, Download, Loader2, Briefcase, Edit2 } from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, GhostIconButton, EmptyState } from '../components/ui';
import { IfCan } from '../components/Layout';

interface ContactsViewProps {
    contacts: Contact[];
    inquiries: Inquiry[];
    onAddContact: (contact: NewContact) => Promise<void>;
    onUpdateContact: (contact: Contact) => Promise<void>;
    onImportContacts: (list: NewContact[]) => Promise<number>;
    onDeleteContact: (id: string) => void;
}

type ContactFilter = 'all' | 'inquiry' | 'manual' | 'import';

const isNonEmptyCell = (cell: string): boolean => cell !== '';

/** Minimal CSV parser — handles quoted cells with embedded commas/newlines. */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    const state = { inQuotes: false, cell: '', row: [] as string[] };

    const endCell = () => {
        state.row.push(state.cell.trim());
        state.cell = '';
    };
    const endRow = () => {
        endCell();
        if (state.row.some(isNonEmptyCell)) rows.push(state.row);
        state.row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1] ?? '';
        if (ch === '"') {
            // Inside a quoted cell, a doubled quote is an escaped quote.
            if (state.inQuotes && next === '"') {
                state.cell += '"';
                i++;
                continue;
            }
            state.inQuotes = !state.inQuotes;
            continue;
        }
        if (state.inQuotes) {
            state.cell += ch;
            continue;
        }
        if (ch === ',') {
            endCell();
            continue;
        }
        if (ch === '\r') {
            if (next === '\n') i++;
            endRow();
            continue;
        }
        if (ch === '\n') {
            endRow();
            continue;
        }
        state.cell += ch;
    }
    endRow();
    return rows;
}

function csvEscape(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replaceAll(/"/g, '""')}"` : value;
}

const SOURCE_BADGES: Record<Contact['source'], { label: string; cls: string }> = {
    inquiry: { label: 'Inquiry', cls: 'text-blue-600 dark:text-blue-400' },
    manual: { label: 'Manual', cls: 'text-green-700 dark:text-green-400' },
    import: { label: 'Imported', cls: 'text-purple-600 dark:text-purple-400' },
};

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

/** Read contact rows from parsed CSV; skips the header row when present. */
function readCsvContacts(rows: string[][]): NewContact[] {
    if (rows.length === 0) return [];
    const header = rows[0].map(c => c.toLowerCase());
    const hasHeader = header.includes('name') || header.includes('phone') || header.includes('email');
    const map = hasHeader ? detectCsvColumns(header) : { name: 0, phone: 1, email: 2, notes: 3 };
    const out: NewContact[] = [];
    for (let i = hasHeader ? 1 : 0; i < rows.length; i++) {
        const r = rows[i];
        const name = r[map.name] || '';
        const phone = r[map.phone] || '';
        const email = r[map.email] || '';
        if (!name && !phone && !email) continue;
        out.push({ name: name || phone || email, phone, email, notes: r[map.notes] || undefined, source: 'import' });
    }
    return out;
}

export const ContactsView: React.FC<ContactsViewProps> = ({ contacts, inquiries, onAddContact, onUpdateContact, onImportContacts, onDeleteContact }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [filter, setFilter] = useState<ContactFilter>('all');
    const [showAdd, setShowAdd] = useState(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '' });
    const [isSaving, setIsSaving] = useState(false);
    const [isImporting, setIsImporting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Contacts derived from inquiries (name, phone, email) — read-only mirror.
    const inquiryContacts = useMemo(() => {
        const seen = new Set<string>();
        const out: Contact[] = [];
        for (const inq of inquiries) {
            const name = inq.customerName?.trim() || '';
            const phone = inq.customerPhone?.trim() || '';
            const email = inq.customerEmail?.trim() || '';
            if (!name && !phone && !email) continue;
            const key = (phone || email || name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                id: `inq_contact_${inq.id}`,
                name: name || phone || email,
                phone, email,
                source: 'inquiry',
                createdAt: inq.date,
                inquiryId: inq.id,
            } as Contact);
        }
        return out;
    }, [inquiries]);

    // Merged list: manual/imported first (newest first), then inquiry-derived
    // contacts not already present (deduped by phone/email/name).
    const allContacts = useMemo(() => {
        const seen = new Set<string>();
        const out: Contact[] = [];
        for (const c of [...contacts, ...inquiryContacts]) {
            const key = (c.phone || c.email || c.name).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(c);
        }
        return out;
    }, [contacts, inquiryContacts]);

    const filteredContacts = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return allContacts.filter(c => {
            if (filter !== 'all' && c.source !== filter) return false;
            if (!q) return true;
            return c.name.toLowerCase().includes(q)
                || c.phone.toLowerCase().includes(q)
                || (c.email || '').toLowerCase().includes(q)
                || (c.notes || '').toLowerCase().includes(q);
        });
    }, [allContacts, filter, searchQuery]);

    const counts = useMemo(() => ({
        all: allContacts.length,
        inquiry: allContacts.filter(c => c.source === 'inquiry').length,
        manual: allContacts.filter(c => c.source === 'manual').length,
        import: allContacts.filter(c => c.source === 'import').length,
    }), [allContacts]);

    const canSave = form.name.trim().length > 0 && (form.phone.trim().length > 0 || form.email.trim().length > 0);

    const handleSave = async () => {
        if (!canSave || isSaving) return;
        setIsSaving(true);
        try {
            if (editingContact) {
                await onUpdateContact({
                    ...editingContact,
                    name: form.name.trim(),
                    phone: form.phone.trim(),
                    email: form.email.trim() || undefined,
                    notes: form.notes.trim() || undefined,
                });
                toast.success('Contact updated');
            } else {
                await onAddContact({
                    name: form.name.trim(),
                    phone: form.phone.trim(),
                    email: form.email.trim() || undefined,
                    notes: form.notes.trim() || undefined,
                    source: 'manual',
                });
                toast.success('Contact added');
            }
            setForm({ name: '', phone: '', email: '', notes: '' });
            setEditingContact(null);
            setShowAdd(false);
        } finally {
            setIsSaving(false);
        }
    };

    const openEditContact = (contact: Contact) => {
        setEditingContact(contact);
        setForm({ name: contact.name, phone: contact.phone, email: contact.email || '', notes: contact.notes || '' });
        setShowAdd(true);
    };

    const confirmDeleteContact = () => {
        if (!editingContact) return;
        onDeleteContact(editingContact.id);
        setConfirmDelete(false);
        setEditingContact(null);
        setForm({ name: '', phone: '', email: '', notes: '' });
        setShowAdd(false);
        toast.success('Contact deleted');
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
        const header = 'Name,Phone,Email,Source,Notes';
        const lines = allContacts.map(c => [c.name, c.phone, c.email || '', SOURCE_BADGES[c.source].label, c.notes || ''].map(csvEscape).join(','));
        const blob = new Blob(['\uFEFF' + header + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(`Exported ${allContacts.length} contact${allContacts.length === 1 ? '' : 's'}`);
    };

    const FILTERS: Array<{ id: ContactFilter; label: string }> = [
        { id: 'all', label: `All (${counts.all})` },
        { id: 'inquiry', label: `Inquiries (${counts.inquiry})` },
        { id: 'manual', label: `Manual (${counts.manual})` },
        { id: 'import', label: `Imported (${counts.import})` },
    ];

    return (
        <PageRoot>
            <PageHeader
                title="Contacts"
                actions={(
                    <>
                        <GhostIconButton onClick={handleExport} label="Export contacts as CSV" icon={<Download size={16} />} disabled={allContacts.length === 0} />
                        <IfCan section="contacts"><GhostIconButton onClick={() => fileInputRef.current?.click()} label="Import contacts from CSV" icon={isImporting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} disabled={isImporting} /></IfCan>
                        <IfCan section="contacts"><PrimaryIconButton onClick={() => setShowAdd(true)} label="Add contact" icon={<UserPlus size={16} />} /></IfCan>
                        <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
                    </>
                )}
            >
                <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search contacts..." />
                <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1">
                    {FILTERS.map(f => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-widest transition-all active-scale ${filter === f.id
                                ? 'neu-inset text-gold-700 dark:text-gold-300'
                                : 'neu-raised-sm neu-btn text-gray-700 dark:text-gray-300'
                                }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </PageHeader>

            {/* List */}
            <PageBody columns={3}>
                {filteredContacts.map((contact, index) => {
                    const badge = SOURCE_BADGES[contact.source];
                    const initial = contact.name.trim().charAt(0).toUpperCase() || '?';
                    return (
                        <div
                            key={contact.id}
                            className="neu-card w-full p-3.5 min-h-[88px] flex items-center gap-3.5 animate-fade-in-up"
                            style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
                        >
                            <span className="w-12 h-12 rounded-full neu-inset flex items-center justify-center font-serif text-lg text-[var(--neu-gold)] shrink-0">
                                {initial}
                            </span>
                            <div className="flex-1 min-w-0">
                                <h3 className="font-serif text-[15px] leading-snug text-[var(--neu-text)] truncate">{contact.name}</h3>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 min-w-0">
                                    <span className={`neu-status shrink-0 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${badge.cls}`}>
                                        <span className="w-1 h-1 rounded-full bg-current" />
                                        {badge.label}
                                    </span>
                                    {contact.phone && (
                                        <span className="text-[11.5px] text-[var(--neu-text-dim)] tabular-nums whitespace-nowrap">{contact.phone}</span>
                                    )}
                                </div>
                                {contact.email && (
                                    <a href={`mailto:${contact.email}`} className="mt-1 flex items-center gap-1 text-[11px] text-[var(--neu-text-dim)] hover:text-gold-600 dark:hover:text-gold-400 transition-colors min-w-0">
                                        <Mail size={11} className="shrink-0" /> <span className="truncate">{contact.email}</span>
                                    </a>
                                )}
                                {contact.notes && <p className="text-[11px] text-[var(--neu-text-dim)] line-clamp-1 mt-1">{contact.notes}</p>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {contact.phone && (
                                    <a
                                        href={`tel:${contact.phone}`}
                                        aria-label={`Call ${contact.name}`}
                                        title="Call"
                                        className="neu-icon-btn neu-btn active-scale text-[var(--neu-gold)]"
                                    >
                                        <Phone size={15} />
                                    </a>
                                )}
                                {contact.source !== 'inquiry' && (
                                    <IfCan section="contacts">
                                        <button
                                            type="button"
                                            onClick={() => openEditContact(contact)}
                                            aria-label={`Edit contact ${contact.name}`}
                                            title="Edit"
                                            className="neu-icon-btn neu-btn active-scale"
                                        >
                                            <Edit2 size={14} />
                                        </button>
                                    </IfCan>
                                )}
                            </div>
                        </div>
                    );
                })}
                {filteredContacts.length === 0 && (
                    <EmptyState
                        icon={<Users size={22} strokeWidth={1.25} />}
                        title={allContacts.length === 0 ? 'No contacts yet' : 'No matches'}
                        message={allContacts.length === 0
                            ? 'Contacts from inquiries appear here automatically. You can also add contacts manually or import a CSV.'
                            : 'No contacts match your search or filter.'}
                    />
                )}
            </PageBody>

            {/* Add Contact Modal */}
            {showAdd && (
                <FullScreenPortal>
                    <div className="neu-sheet z-50 animate-fade-in-up">
                        <div className="flex justify-between items-center p-3 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] z-10">
                            <button
                                onClick={() => { setShowAdd(false); setEditingContact(null); }}
                                className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale"
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">{editingContact ? 'Edit Contact' : 'Add Contact'}</h2>
                            <div className="w-9"></div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-5 no-scrollbar">
                            <div>
                                <label htmlFor="contact-name" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Name *</label>
                                <input
                                    id="contact-name"
                                    value={form.name}
                                    onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                                    placeholder="Full name"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="contact-phone" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Phone</label>
                                <input
                                    id="contact-phone"
                                    type="tel"
                                    value={form.phone}
                                    onChange={(e) => setForm(prev => ({ ...prev, phone: e.target.value }))}
                                    placeholder="+91 98765 43210"
                                    autoComplete="off"
                                    className="neu-field"
                                />
                            </div>

                            <div>
                                <label htmlFor="contact-email" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Email</label>
                                <input
                                    id="contact-email"
                                    type="email"
                                    value={form.email}
                                    onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
                                    placeholder="name@example.com"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="neu-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="contact-notes" className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1.5 uppercase tracking-wider">Notes</label>
                                <textarea
                                    id="contact-notes"
                                    value={form.notes}
                                    onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
                                    rows={3}
                                    placeholder="Any details (optional)"
                                    className="neu-field"
                                />
                            </div>
                            <p className="text-[11px] text-gray-600 dark:text-gray-300 font-light flex items-center gap-1.5">
                                <Briefcase size={10} /> Name is required, plus a phone or email.
                            </p>
                            {editingContact && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(true)}
                                    className="neu-button neu-button-danger w-full"
                                >
                                    <Trash2 size={14} /> Delete Contact
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!canSave || isSaving}
                                className={`w-full rounded-lg py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 ${canSave
                                    ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300'
                                    : 'bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                                    }`}
                            >
                                {isSaving && <Loader2 size={14} className="animate-spin" />}
                                {editingContact ? 'Save Changes' : 'Add Contact'}
                            </button>
                        </div>
                    </div>
                </FullScreenPortal>
            )}

            {/* Delete confirmation — must type "Delete" */}
            <TypeDeleteDialog
                isOpen={confirmDelete}
                title="Delete contact"
                itemName={editingContact?.name || ''}
                message="it will be archived for admin review"
                onClose={() => setConfirmDelete(false)}
                onConfirm={confirmDeleteContact}
            />
        </PageRoot>
    );
};