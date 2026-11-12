// My Space → My Notes: private notes only their author can see (notes.ts).
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, NotebookPen, Pin, Plus, Trash2 } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, PrimaryIconButton, Button, Field, Input, Textarea, ToggleRow, EmptyState } from '../components/ui';
import { MAX_BODY, MAX_TITLE, parseNote, type Note } from '../noteRules';
import { noteService } from '../services/noteService';

const when = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const firstLine = (s: string) => s.trim().split('\n')[0];

export const NotesView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [notes, setNotes] = useState<Note[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [editing, setEditing] = useState<Note | 'new' | null>(null);

    const load = useCallback(async () => {
        setFailed(false);
        try { setNotes(await noteService.list()); } catch { setFailed(true); }
    }, []);
    useEffect(() => { void load(); }, [load]);

    if (editing) return <NoteForm note={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void load(); }} />;

    let body: React.ReactNode = <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    if (failed) {
        body = <EmptyState icon={<NotebookPen size={22} strokeWidth={1.5} />} title="Notes didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (notes?.length === 0) {
        body = <EmptyState icon={<NotebookPen size={22} strokeWidth={1.5} />} title="No notes yet" message="Only you can see your notes, not even admins."
            action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New note</Button>} />;
    } else if (notes) {
        body = (
            <ul className="neu-card px-2 py-1">
                {notes.map(n => (
                    <li key={n.id} className="task-row">
                        <button type="button" onClick={() => setEditing(n)} className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-xl active-scale">
                            <span className="flex-1 min-w-0">
                                <span className="block font-serif text-[15px] text-gray-900 dark:text-white truncate">{n.title || firstLine(n.body)}</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">
                                    {when(n.updatedAt)}{n.title && n.body.trim() ? ` · ${firstLine(n.body)}` : ''}
                                </span>
                            </span>
                            {n.pinned && <Pin size={14} className="shrink-0 text-gold-700 dark:text-gold-400" aria-label="Pinned" />}
                        </button>
                    </li>
                ))}
            </ul>
        );
    }

    return (
        <PageRoot>
            <PageHeader title="My Notes" subtitle="Yours only" onBack={onBack}
                actions={<PrimaryIconButton onClick={() => setEditing('new')} label="New note" icon={<Plus size={16} />} />} />
            <PageBody>{body}</PageBody>
        </PageRoot>
    );
};

const NoteForm: React.FC<{ note: Note | null; onDone: () => void }> = ({ note, onDone }) => {
    const [title, setTitle] = useState(note?.title ?? '');
    const [text, setText] = useState(note?.body ?? '');
    const [pinned, setPinned] = useState(note?.pinned ?? false);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [problem, setProblem] = useState('');
    const dirty = title !== (note?.title ?? '') || text !== (note?.body ?? '') || pinned !== (note?.pinned ?? false);

    const save = async () => {
        const input = parseNote({ title, body: text, pinned });
        if ('problem' in input) { setProblem(input.problem); return; }
        setBusy(true);
        try {
            if (note) await noteService.update(note.id, input); else await noteService.create(input);
            toast.success(note ? 'Note saved' : 'Note added');
            onDone();
        } catch (e) {
            setProblem((e as Error).message || 'Could not save. Please try again.');
            setBusy(false);
        }
    };

    // Back keeps what was typed: an empty new note just closes, anything else saves first.
    const back = () => {
        if (busy) return;
        if (!dirty || (!note && !title.trim() && !text.trim())) onDone(); else void save();
    };
    useBackClose(true, back);

    const remove = async () => {
        if (!note) return;
        if (!confirmDelete) { setConfirmDelete(true); return; }
        setBusy(true);
        try { await noteService.remove(note.id); toast.success('Note deleted'); onDone(); } catch { setProblem('Could not delete. Please try again.'); setBusy(false); }
    };

    return (
        <PageRoot>
            <PageHeader title={note ? 'Edit note' : 'New note'} subtitle="Only you can see this" onBack={back} />
            <PageBody>
                <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => setProblem('')} onSubmit={e => { e.preventDefault(); void save(); }}>
                    <Field label="Title (optional)" htmlFor="note-title">
                        <Input id="note-title" maxLength={MAX_TITLE} autoComplete="off" value={title} onChange={e => setTitle(e.target.value)} />
                    </Field>
                    <Field label="Note" htmlFor="note-body" hint={text.length > MAX_BODY * 0.9 ? `${text.length.toLocaleString('en-IN')} of ${MAX_BODY.toLocaleString('en-IN')} characters` : undefined}>
                        <Textarea id="note-body" rows={12} maxLength={MAX_BODY} value={text} onChange={e => setText(e.target.value)} autoFocus={!note} />
                    </Field>
                    <ToggleRow icon={<Pin size={16} />} title="Pin to top" checked={pinned} onChange={() => { setPinned(p => !p); setProblem(''); }} />
                    {problem && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{problem}</p>}
                    <Button type="submit" variant="primary" block disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
                    {note && (
                        <Button type="button" variant="danger" block disabled={busy} icon={<Trash2 size={15} />} onClick={() => { void remove(); }}>
                            {confirmDelete ? 'Tap again to delete' : 'Delete note'}
                        </Button>
                    )}
                </form>
            </PageBody>
        </PageRoot>
    );
};
