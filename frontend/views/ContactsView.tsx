import React, { useMemo, useRef, useState } from 'react';
import { Contact, Inquiry, NewContact } from '../types';
import { FullScreenPortal } from '../components/FullScreenPortal';
import { TypeDeleteDialog } from '../components/TypeDeleteDialog';
import toast from 'react-hot-toast';
import { Search, Users, UserPlus, Trash2, X, Phone, Mail, Upload, Download, Loader2, Briefcase, Edit2 } from 'lucide-react';

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
    inquiry: { label: 'Inquiry', cls: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' },
    manual: { label: 'Manual', cls: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400' },
    import: { label: 'Imported', cls: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400' },
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
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="bg-white dark:bg-[#1a1a1a] px-[6px] pt-[calc(1.75rem+env(safe-area-inset-top,0px))] pb-[6px] shadow-sm z-10 border-b border-gray-100 dark:border-gray-800">
                <div className="flex justify-between items-center mb-[6px]">
                    <h1 className="text-xl font-serif text-gray-900 dark:text-white">Contacts</h1>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleExport}
                            disabled={allContacts.length === 0}
                            className="bg-gray-100 dark:bg-[#2a2a2a] text-gray-600 dark:text-gray-300 p-1.5 rounded-full shadow-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale disabled:opacity-40"
                            aria-label="Export contacts as CSV"
                            title="Export CSV"
                        >
                            <Download size={16} />
                        </button>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isImporting}
                            className="bg-gray-100 dark:bg-[#2a2a2a] text-gray-600 dark:text-gray-300 p-1.5 rounded-full shadow-sm hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale disabled:opacity-40"
                            aria-label="Import contacts from CSV"
                            title="Import CSV"
                        >
                            {isImporting ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                        </button>
                        <button
                            onClick={() => setShowAdd(true)}
                            className="bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 p-1.5 rounded-full shadow-md hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale"
                            aria-label="Add contact"
                        >
                            <UserPlus size={18} />
                        </button>
                        <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
                    </div>
                </div>
                <div className="relative mb-[6px]">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
                    <input
                        type="text"
                        placeholder="Search name, phone or email..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                    />
                </div>
                <div className="flex gap-[6px] overflow-x-auto no-scrollbar pb-1">
                    {FILTERS.map(f => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            className={`shrink-0 px-3 py-1.5 rounded-full text-[9px] font-bold uppercase tracking-widest transition-all active-scale ${filter === f.id
                                ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 shadow-sm'
                                : 'bg-gray-100 dark:bg-[#2a2a2a] text-gray-500 dark:text-gray-400'
                                }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-[6px] space-y-2 no-scrollbar pb-20">
                {filteredContacts.map((contact, index) => {
                    const badge = SOURCE_BADGES[contact.source];
                    const initial = contact.name.trim().charAt(0).toUpperCase() || '?';
                    return (
                        <div
                            key={contact.id}
                            className="relative w-full bg-white dark:bg-[#1e1e1e] rounded-[6px] shadow-sm p-[6px] flex items-center gap-[6px] border border-gray-100 dark:border-gray-800 animate-fade-in-up"
                            style={{ animationDelay: `${index * 25}ms` }}
                        >
                            <div className="w-11 h-11 rounded-full bg-gray-50 dark:bg-gray-800 flex items-center justify-center text-brand-900 dark:text-gold-400 font-serif text-base shrink-0">
                                {initial}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <h3 className="font-serif text-gray-900 dark:text-gray-100 text-sm truncate">{contact.name}</h3>
                                    <span className={`text-[7px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider shrink-0 ${badge.cls}`}>{badge.label}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                    {contact.phone && (
                                        <a href={`tel:${contact.phone}`} className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors">
                                            <Phone size={10} /> {contact.phone}
                                        </a>
                                    )}
                                    {contact.email && (
                                        <a href={`mailto:${contact.email}`} className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400 hover:text-gold-600 dark:hover:text-gold-400 transition-colors min-w-0">
                                            <Mail size={10} className="shrink-0" /> <span className="truncate max-w-[150px]">{contact.email}</span>
                                        </a>
                                    )}
                                </div>
                                {contact.notes && <p className="text-[10px] text-gray-400 dark:text-gray-500 font-light line-clamp-1 mt-0.5">{contact.notes}</p>}
                            </div>
                            {contact.source !== 'inquiry' && (
                                <button
                                    type="button"
                                    onClick={() => openEditContact(contact)}
                                    aria-label={`Edit contact ${contact.name}`}
                                    className="p-1.5 text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale shrink-0"
                                >
                                    <Edit2 size={14} />
                                </button>
                            )}
                        </div>
                    );
                })}
                {filteredContacts.length === 0 && (
                    <div className="text-center py-12 px-6 bg-white dark:bg-[#1e1e1e] rounded-[6px] border border-gray-100 dark:border-gray-800 mt-2">
                        <Users size={28} strokeWidth={1.25} className="mx-auto text-gray-300 dark:text-gray-600 mb-3" />
                        {allContacts.length === 0 ? (
                            <>
                                <p className="text-sm font-serif text-gray-700 dark:text-gray-200 mb-1.5">No contacts yet</p>
                                <p className="text-xs text-gray-400 dark:text-gray-500 font-light leading-relaxed">
                                    Contacts from inquiries appear here automatically. You can also add contacts manually or import a CSV.
                                </p>
                            </>
                        ) : (
                            <p className="text-xs text-gray-400 dark:text-gray-500 font-light">
                                No contacts match your search or filter.
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Add Contact Modal */}
            {showAdd && (
                <FullScreenPortal>
                    <div className="absolute inset-0 bg-[#faf9f6] dark:bg-[#121212] z-50 flex flex-col animate-fade-in-up">
                        <div className="bg-white dark:bg-[#1a1a1a] flex justify-between items-center p-[6px] border-b border-gray-100 dark:border-gray-800 pt-[calc(1.75rem+env(safe-area-inset-top,0px))] shadow-sm z-10">
                            <button
                                onClick={() => { setShowAdd(false); setEditingContact(null); }}
                                className="p-2 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors active-scale"
                                aria-label="Close"
                            >
                                <X size={20} />
                            </button>
                            <h2 className="text-base font-serif text-gray-900 dark:text-white">{editingContact ? 'Edit Contact' : 'Add Contact'}</h2>
                            <div className="w-9"></div>
                        </div>
                        <div className="flex-1 overflow-y-auto p-[6px] space-y-5 no-scrollbar">
                            <div>
                                <label htmlFor="contact-name" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Name *</label>
                                <input
                                    id="contact-name"
                                    value={form.name}
                                    onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                                    placeholder="Full name"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label htmlFor="contact-phone" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Phone</label>
                                <input
                                    id="contact-phone"
                                    type="tel"
                                    value={form.phone}
                                    onChange={(e) => setForm(prev => ({ ...prev, phone: e.target.value }))}
                                    placeholder="+91 98765 43210"
                                    autoComplete="off"
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>

                            <div>
                                <label htmlFor="contact-email" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Email</label>
                                <input
                                    id="contact-email"
                                    type="email"
                                    value={form.email}
                                    onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
                                    placeholder="name@example.com"
                                    autoComplete="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                                />
                            </div>
                            <div>
                                <label htmlFor="contact-notes" className="block text-[9px] font-medium text-gray-500 dark:text-gray-400 mb-1.5 uppercase tracking-wider">Notes</label>
                                <textarea
                                    id="contact-notes"
                                    value={form.notes}
                                    onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
                                    rows={3}
                                    placeholder="Any details (optional)"
                                    className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[6px] py-2.5 px-3.5 text-sm text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors resize-none"
                                />
                            </div>
                            <p className="text-[9px] text-gray-400 dark:text-gray-500 font-light flex items-center gap-1.5">
                                <Briefcase size={10} /> Name is required, plus a phone or email.
                            </p>
                            {editingContact && (
                                <button
                                    type="button"
                                    onClick={() => setConfirmDelete(true)}
                                    className="w-full rounded-[6px] py-2.5 text-sm font-medium tracking-wide transition-colors active-scale flex items-center justify-center gap-2 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                    <Trash2 size={14} /> Delete Contact
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={!canSave || isSaving}
                                className={`w-full rounded-[6px] py-3 text-sm font-medium tracking-wide transition-colors shadow-md active-scale flex items-center justify-center gap-2 ${canSave
                                    ? 'bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 hover:bg-brand-800 dark:hover:bg-gold-400'
                                    : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600'
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
        </div>
    );
};