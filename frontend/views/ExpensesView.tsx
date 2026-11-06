// My Space → Expenses: record your own expenses with receipt photos, a month
// at a time, and share the month as a PDF (accounts team, or anyone).
import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, Loader2, Paperclip, Plus, Share2, Trash2, Wallet } from 'lucide-react';
import { useBackClose } from '../hooks/useBackClose';
import { PageRoot, PageHeader, PageBody, GhostIconButton, PrimaryIconButton, Button, Field, Input, Select, Textarea, EmptyState } from '../components/ui';
import { PhotoAttachments } from '../components/PhotoAttachments';
import { EXPENSE_CATEGORIES, MAX_NOTE, MAX_RECEIPTS, parseExpense, type Expense } from '../expenseRules';
import { rupeesText, toPaise } from '../gstRules';
import { monthRange, shiftMonth, todayIso } from '../salesRules';
import { expenseService } from '../services/expenseService';
import { saveBlob } from '../services/saveFile';

const monthLabel = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const thisMonth = () => monthRange(todayIso())[0];

export const ExpensesView: React.FC<{ person: string; workspace: string; onBack: () => void }> = ({ person, workspace, onBack }) => {
    const [month, setMonth] = useState(thisMonth);
    const [expenses, setExpenses] = useState<Expense[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [editing, setEditing] = useState<Expense | 'new' | null>(null);
    const [sharing, setSharing] = useState(false);
    useBackClose(editing !== null, () => setEditing(null));

    const load = useCallback(async () => {
        setFailed(false);
        try { setExpenses(await expenseService.month(month)); } catch { setFailed(true); }
    }, [month]);
    useEffect(() => { setExpenses(null); void load(); }, [load]);

    const total = (expenses ?? []).reduce((s, e) => s + e.amountPaise, 0);

    const share = async () => {
        if (!expenses?.length || sharing) return;
        setSharing(true);
        try {
            const { buildExpensePdf, expenseFileName } = await import('../services/expensePdf');
            const blob = await buildExpensePdf(expenses, { person, workspace, monthLabel: monthLabel(month) });
            const file = new File([blob], expenseFileName(person, monthLabel(month)), { type: 'application/pdf' });
            const title = `Expenses, ${monthLabel(month)}`;
            if (!navigator.canShare?.({ files: [file] })) { await saveBlob(blob, file.name); return; }
            try {
                await navigator.share({ files: [file], title });
            } catch (e) {
                if ((e as Error).name !== 'NotAllowedError') throw e;
                // Safari allows the share sheet only right after a tap; building the PDF used that up.
                toast(t => <button type="button" className="font-semibold underline" onClick={() => { toast.dismiss(t.id); navigator.share({ files: [file], title }).catch(() => { /* closed */ }); }}>Tap to share the PDF</button>, { duration: 20_000 });
            }
        } catch (e) {
            if ((e as Error).name !== 'AbortError') toast.error('Could not make the PDF. Please try again.');
        } finally {
            setSharing(false);
        }
    };

    if (editing) {
        return <ExpenseForm expense={editing === 'new' ? null : editing} defaultDate={month === thisMonth() ? todayIso() : monthRange(month)[1]}
            onDone={(changedMonth) => { setEditing(null); if (changedMonth && changedMonth !== month) setMonth(changedMonth); else void load(); }} />;
    }

    let body: React.ReactNode = <div className="py-16 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    if (failed) {
        body = <EmptyState icon={<Wallet size={22} strokeWidth={1.5} />} title="Expenses didn’t load" message="Check your connection and try again." action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (expenses?.length === 0) {
        body = <EmptyState icon={<Wallet size={22} strokeWidth={1.5} />} title={`Nothing recorded in ${monthLabel(month)}`} message="Add an expense with a photo of its receipt. Share the month as a PDF when it’s done."
            action={<Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>Add expense</Button>} />;
    } else if (expenses) {
        body = (
            <ul className="neu-card px-2 py-1">
                {expenses.map(e => (
                    <li key={e.id} className="task-row">
                        <button type="button" onClick={() => setEditing(e)} className="w-full flex items-center gap-3 px-2 py-3 text-left rounded-xl active-scale">
                            <span className="w-11 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-[var(--neu-text-dim)]">{dayLabel(e.date)}</span>
                            <span className="flex-1 min-w-0">
                                <span className="block text-[14.5px] text-gray-900 dark:text-white truncate">{e.category}</span>
                                {e.note && <span className="block mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{e.note}</span>}
                            </span>
                            {e.receipts.length > 0 && <Paperclip size={14} className="shrink-0 text-[var(--neu-text-dim)]" aria-label={`${e.receipts.length} receipt photos`} />}
                            <span className="shrink-0 font-serif tabular-nums text-[15px] text-gray-900 dark:text-white">{rupeesText(e.amountPaise)}</span>
                        </button>
                    </li>
                ))}
            </ul>
        );
    }

    const arrow = 'w-8 h-8 rounded-full flex items-center justify-center text-gold-700 dark:text-gold-300 active-scale disabled:opacity-30 disabled:pointer-events-none';
    return (
        <PageRoot>
            <PageHeader title="Expenses" subtitle="Yours only" onBack={onBack} actions={<>
                <GhostIconButton onClick={() => { void share(); }} disabled={!expenses?.length || sharing} label="Share this month as a PDF"
                    icon={sharing ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} className="text-brand-900 dark:text-gold-400" />} />
                <PrimaryIconButton onClick={() => setEditing('new')} label="Add expense" icon={<Plus size={16} />} />
            </>} />
            <PageBody>
                <div className="neu-card p-3 lg:p-4 flex items-center gap-2 text-[var(--neu-text)]">
                    <button type="button" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label="Previous month" className={arrow}><ChevronLeft size={16} /></button>
                    <div className="flex-1 min-w-0 text-center">
                        <p className="text-[11px] font-medium uppercase tracking-widest text-gray-700 dark:text-gray-300" aria-live="polite">{monthLabel(month)}</p>
                        <p className="text-xl font-serif tabular-nums text-gray-900 dark:text-white">{expenses ? rupeesText(total) : '…'}</p>
                    </div>
                    <button type="button" onClick={() => setMonth(m => shiftMonth(m, 1))} disabled={month >= thisMonth()} aria-label="Next month" className={arrow}><ChevronRight size={16} /></button>
                </div>
                {body}
            </PageBody>
        </PageRoot>
    );
};

const ExpenseForm: React.FC<{ expense: Expense | null; defaultDate: string; onDone: (month?: string) => void }> = ({ expense, defaultDate, onDone }) => {
    const [date, setDate] = useState(expense?.date ?? defaultDate);
    const [amount, setAmount] = useState(expense ? String(expense.amountPaise / 100) : '');
    const [category, setCategory] = useState(expense?.category ?? '');
    const [note, setNote] = useState(expense?.note ?? '');
    const [receipts, setReceipts] = useState<string[]>(expense?.receipts ?? []);
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [problem, setProblem] = useState('');

    const save = async () => {
        const input = parseExpense({ date, amountPaise: toPaise(amount), category, note, receipts });
        if ('problem' in input) { setProblem(input.problem); return; }
        if (input.date > todayIso()) { setProblem('The date is in the future.'); return; }
        setBusy(true);
        try {
            if (expense) await expenseService.update(expense.id, input); else await expenseService.create(input);
            toast.success(expense ? 'Expense saved' : 'Expense added');
            onDone(monthRange(input.date)[0]);
        } catch (e) {
            setProblem((e as Error).message || 'Could not save. Please try again.');
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!expense) return;
        if (!confirmDelete) { setConfirmDelete(true); return; }
        setBusy(true);
        try { await expenseService.remove(expense.id); toast.success('Expense deleted'); onDone(); } catch { setProblem('Could not delete. Please try again.'); setBusy(false); }
    };

    let saveLabel = expense ? 'Save' : 'Add expense';
    if (busy) saveLabel = 'Saving…';
    if (uploading) saveLabel = 'Uploading photo…';

    return (
        <PageRoot>
            <PageHeader title={expense ? 'Edit expense' : 'New expense'} onBack={() => onDone()} />
            <PageBody>
                <form className="neu-card p-4 lg:p-5 space-y-4 text-[var(--neu-text)]" onChange={() => setProblem('')} onSubmit={e => { e.preventDefault(); void save(); }}>
                    <Field label="Date" htmlFor="exp-date"><Input id="exp-date" type="date" value={date} max={todayIso()} onChange={e => setDate(e.target.value)} /></Field>
                    <Field label="Amount (₹)" htmlFor="exp-amount">
                        <Input id="exp-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
                    </Field>
                    <Field label="Category" htmlFor="exp-cat">
                        <Select id="exp-cat" value={category} onChange={e => setCategory(e.target.value)}>
                            <option value="" disabled>Choose…</option>
                            {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </Select>
                    </Field>
                    <Field label="Note (optional)" htmlFor="exp-note" hint="What it was for, who you met, the vendor.">
                        <Textarea id="exp-note" rows={2} maxLength={MAX_NOTE} value={note} onChange={e => setNote(e.target.value)} />
                    </Field>
                    <Field label={`Receipt photos (up to ${MAX_RECEIPTS})`}>
                        <PhotoAttachments urls={receipts} onUploadingChange={setUploading}
                            onAdd={urls => setReceipts(r => [...r, ...urls].slice(0, MAX_RECEIPTS))}
                            onRemove={url => setReceipts(r => r.filter(u => u !== url))} />
                    </Field>
                    {problem && <p role="alert" className="text-[13px] text-red-600 dark:text-red-400">{problem}</p>}
                    <Button type="submit" variant="primary" block disabled={busy || uploading}>
                        {saveLabel}
                    </Button>
                    {expense && (
                        <Button type="button" variant="danger" block disabled={busy} icon={<Trash2 size={15} />} onClick={() => { void remove(); }}>
                            {confirmDelete ? 'Tap again to delete' : 'Delete expense'}
                        </Button>
                    )}
                </form>
            </PageBody>
        </PageRoot>
    );
};
