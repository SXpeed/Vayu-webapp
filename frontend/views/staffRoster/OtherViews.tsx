import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Check, Leaf, Loader2, Plus } from 'lucide-react';
import { Button, EmptyState, Field, Input, Select, Textarea } from '../../components/ui';
import { LEAVE_TYPES, addDays, isIsoDate, mondayOf, toTs, weekDates, weekdayIdx, type StaffLeave, type StaffShift } from '../../staffRosterRules';
import { staffRosterService, type StaffRosterData } from '../../services/staffRosterService';
import { ShiftCard } from './WeekViews';
import { DOW, MONTHS, dayLabel, dayOfMonth, dm, matchesPerson, matchesStore, todayIso, type Derived, type Filters } from './shared';

/** Month: staff on shift each day, and what needs attention. Choosing a day opens it. */
export const MonthView: React.FC<{ data: StaffRosterData; d: Derived; monthOf: string; filters: Filters; onPickDay: (date: string) => void }> = ({ data, d, monthOf, filters, onPickDay }) => {
    const m = new Date(toTs(monthOf));
    const y = m.getUTCFullYear(), mo = m.getUTCMonth();
    const first = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, mo + 1, 0)).toISOString().slice(0, 10);
    const start = mondayOf(first), end = addDays(mondayOf(last), 6);
    const today = todayIso();
    const people = new Set(data.people.filter(p => matchesPerson(p, filters)).map(p => p.id));
    const days: string[] = [];
    for (let x = start; x <= end; x = addDays(x, 1)) days.push(x);
    return (
        <div className="neu-card p-3 lg:p-4">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3 px-1">
                <h2 className="font-serif text-xl text-gray-900 dark:text-white">{MONTHS[mo]} {y}</h2>
                <p className="text-[12px] text-[var(--neu-text-dim)]">Staff on shift each day. Choose a day to open it.</p>
            </div>
            <div className="grid grid-cols-7 gap-1.5 lg:gap-2">
                {DOW.map(x => <span key={x} className="px-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--neu-text-dim)]">{x}</span>)}
                {days.map(date => {
                    const list = data.shifts.filter(s => s.date === date && s.kind === 'shift' && matchesStore(s, filters));
                    const staff = new Set(list.filter(s => s.employeeId && people.has(s.employeeId)).map(s => s.employeeId)).size;
                    const open = list.filter(s => !s.employeeId).length;
                    const bad = list.filter(s => d.conflicts.has(s.id)).length;
                    const onLeave = data.leaves.filter(l => l.status === 'approved' && date >= l.from && date <= l.to).length;
                    const out = date < first || date > last;
                    return (
                        <button key={date} type="button" onClick={() => onPickDay(date)}
                            aria-label={`${dayLabel(date)}: ${staff} on shift${open ? ', ' + open + ' open' : ''}${bad ? ', ' + bad + ' conflicts' : ''}${onLeave ? ', ' + onLeave + ' on leave' : ''}. Open this day`}
                            className={`min-h-[68px] lg:min-h-[92px] rounded-2xl p-1.5 lg:p-2.5 flex flex-col items-start gap-0.5 text-left active-scale ${date === today ? 'neu-inset' : 'neu-raised-sm'} ${out ? 'opacity-45' : ''}`}>
                            <span className={`text-[13px] lg:text-[14px] font-semibold tabular-nums ${date === today ? 'text-[var(--neu-gold)]' : ''}`}>{dayOfMonth(date)}</span>
                            <span className="text-[10px] lg:text-[11.5px] text-[var(--neu-text-dim)] tabular-nums">{staff} staff</span>
                            {open > 0 && <span className="text-[10px] lg:text-[11px] font-semibold sr-open-text">{open} open</span>}
                            {bad > 0 && <span className="text-[10px] lg:text-[11px] font-semibold sr-bad-text">{bad} conflict{bad > 1 ? 's' : ''}</span>}
                            {onLeave > 0 && <span className="hidden lg:inline text-[11px] font-semibold text-[var(--sr-leave-ink)]">{onLeave} on leave</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

/** By store: each store's week, with the shifts still needing someone easy to spot. */
export const ByStoreView: React.FC<{ data: StaffRosterData; d: Derived; weekStart: string; filters: Filters; onEdit?: (s: StaffShift) => void; onNew?: (employeeId: string | null, date: string, storeId: string) => void }> = ({ data, d, weekStart, filters, onEdit, onNew }) => {
    const dates = weekDates(weekStart);
    const stores = data.stores.filter(s => filters.storeId === 'all' || s.id === filters.storeId);
    const people = new Set(data.people.filter(p => matchesPerson(p, filters)).map(p => p.id));
    if (!stores.length) return <EmptyState title="No stores yet" message="Add your stores under Attendance → Stores, then plan shifts for them here." />;
    return (
        <div className="grid gap-4 xl:grid-cols-2 items-start">
            {stores.map(store => {
                const week = data.shifts.filter(s => s.kind === 'shift' && s.storeId === store.id && dates.includes(s.date));
                const open = week.filter(s => !s.employeeId).length;
                return (
                    <section key={store.id} className="neu-card p-4" aria-labelledby={`store-${store.id}`}>
                        <h2 id={`store-${store.id}`} className="font-serif text-lg text-gray-900 dark:text-white flex items-center gap-2">
                            <span className={`w-3.5 h-3.5 rounded border ${d.storeClass(store.id)}`} aria-hidden="true" />{store.name}
                        </h2>
                        <p className="text-[12px] text-[var(--neu-text-dim)] mb-2">
                            {week.filter(s => s.employeeId).length} assigned shifts · <span className={open ? 'sr-open-text font-semibold' : 'text-green-700 dark:text-green-400 font-semibold'}>{open ? `${open} open` : 'fully covered'}</span>
                        </p>
                        {dates.map(date => {
                            const list = week.filter(s => s.date === date && (s.employeeId ? people.has(s.employeeId) : filters.title === 'all' || s.role === filters.title))
                                .sort((a, b) => (a.employeeId ? 1 : 0) - (b.employeeId ? 1 : 0) || a.startMin - b.startMin);
                            const staff = new Set(list.filter(s => s.employeeId).map(s => s.employeeId)).size;
                            return (
                                <div key={date} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2.5 py-2.5 border-t border-[var(--neu-line)]">
                                    <div className="text-[12.5px] font-semibold">{DOW[weekdayIdx(date)]} {dayOfMonth(date)}<span className="block text-[11px] font-normal text-[var(--neu-text-dim)] tabular-nums">{staff} staff</span></div>
                                    <div className="flex flex-wrap gap-1.5">
                                        {list.map(s => <div key={s.id} className="flex-[1_1_9.5rem] max-w-[15rem]"><ShiftCard s={s} d={d} data={data} showName onEdit={onEdit} /></div>)}
                                        {!list.length && <span className="text-[12px] text-[var(--neu-text-dim)] py-1.5">No shifts</span>}
                                        {onNew && (
                                            <button type="button" onClick={() => onNew(null, date, store.id)} aria-label={`Add a shift at ${store.name} on ${dayLabel(date)}`}
                                                className="px-2.5 min-h-[36px] rounded-[11px] border border-dashed border-[var(--neu-line)] text-[var(--neu-text-dim)] hover:text-[var(--neu-gold)] active-scale"><Plus size={14} /></button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </section>
                );
            })}
        </div>
    );
};

/** What a manager should know about the shifts inside a request. */
function affNote(l: StaffLeave, n: number, list: string): string {
    if (!n) return '';
    const many = n > 1;
    if (l.status === 'pending') return `${n} shift${many ? 's' : ''} in these dates (${list}). Approving keeps ${many ? 'them' : 'it'} and marks ${many ? 'them' : 'it'} for reassigning.`;
    if (l.status === 'approved') return `${n} shift${many ? 's' : ''} in this leave need${many ? '' : 's'} reassigning (${list}).`;
    return '';
}

const STATUS_PILL: Record<StaffLeave['status'], string> = {
    pending: 'sr-warn-box', approved: 'neu-inset text-green-700 dark:text-green-400', declined: 'sr-off',
};

/** Requests: leave waiting for a decision (managers), and your own leave (everyone). */
export const RequestsView: React.FC<{ data: StaffRosterData; d: Derived; onChanged: () => void; onReview: () => void }> = ({ data, d, onChanged, onReview }) => {
    const [busy, setBusy] = useState<string | null>(null);
    const [form, setForm] = useState({ employeeId: data.me, from: todayIso(), to: todayIso(), type: 'Annual leave', reason: '' });
    const [saving, setSaving] = useState(false);

    const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
        setBusy(id);
        try { await fn(); toast.success(done); onChanged(); } catch (e) { toast.error((e as Error).message || 'That didn’t work'); } finally { setBusy(null); }
    };
    const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!isIsoDate(form.from) || !isIsoDate(form.to)) { toast.error('Choose the first and last day'); return; }
        if (form.to < form.from) { toast.error('The last day is before the first day'); return; }
        setSaving(true);
        try {
            const forOther = form.employeeId !== data.me;
            await staffRosterService.requestLeave({ ...form, employeeId: forOther ? form.employeeId : undefined });
            toast.success(forOther ? 'Leave recorded' : 'Request sent. A manager will decide on it.');
            setForm(f => ({ ...f, reason: '' }));
            onChanged();
        } catch (err) { toast.error((err as Error).message || 'Could not send the request'); } finally { setSaving(false); }
    };

    const affected = (l: StaffLeave) => data.shifts.filter(s => s.kind === 'shift' && s.employeeId === l.employeeId && s.date >= l.from && s.date <= l.to);
    const days = (l: StaffLeave) => Math.round((toTs(l.to) - toTs(l.from)) / 86_400_000) + 1;

    const card = (l: StaffLeave) => {
        const who = d.person(l.employeeId);
        const former = who ? undefined : d.formerName(l.employeeId);
        const aff = affected(l);
        const affText = aff.map(s => `${DOW[weekdayIdx(s.date)]} ${dm(s.date)} ${d.storeName(s.storeId)}`).join('; ');
        const mine = l.employeeId === data.me;
        return (
            <article key={l.id} className="neu-card p-4 space-y-2.5">
                <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <p className="font-semibold text-[14px] truncate">{who?.name ?? former ?? 'Former team member'}{mine && <span className="font-normal text-[var(--neu-text-dim)]"> (you)</span>}</p>
                        <p className="text-[12px] text-[var(--neu-text-dim)]">{who ? who.title : 'No longer in this workspace’s member list'}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_PILL[l.status]}`}>{{ pending: 'Waiting', approved: 'Approved', declined: 'Declined' }[l.status]}</span>
                </div>
                <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                    <dt className="text-[var(--neu-text-dim)]">Dates</dt><dd className="tabular-nums">{dayLabel(l.from)}{l.to !== l.from ? ` – ${dayLabel(l.to)}` : ''} · {days(l)} day{days(l) > 1 ? 's' : ''}</dd>
                    <dt className="text-[var(--neu-text-dim)]">Type</dt><dd>{l.type}</dd>
                    {l.reason && <><dt className="text-[var(--neu-text-dim)]">Reason</dt><dd>{l.reason}</dd></>}
                    {l.decidedAt && <><dt className="text-[var(--neu-text-dim)]">Decided</dt><dd>{new Date(l.decidedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}{l.decidedByName ? ` by ${l.decidedByName}` : ''}</dd></>}
                </dl>
                {data.canManage && affNote(l, aff.length, affText) && (
                    <p className="sr-warn-box rounded-xl px-3 py-2 text-[12.5px]">{affNote(l, aff.length, affText)}</p>
                )}
                <div className="flex flex-wrap gap-2">
                    {data.canManage && l.status === 'pending' && (
                        <>
                            <Button variant="primary" disabled={busy === l.id} onClick={() => { void act(l.id, () => staffRosterService.decideLeave(l.id, 'approved'), 'Leave approved'); }} icon={busy === l.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}>Approve</Button>
                            <Button disabled={busy === l.id} onClick={() => { void act(l.id, () => staffRosterService.decideLeave(l.id, 'declined'), 'Request declined'); }}>Decline</Button>
                        </>
                    )}
                    {data.canManage && l.status === 'approved' && aff.length > 0 && <Button onClick={onReview}>Review affected shifts</Button>}
                    {mine && l.status === 'pending' && !data.canManage && (
                        <Button disabled={busy === l.id} onClick={() => { void act(l.id, () => staffRosterService.deleteLeave(l.id), 'Request withdrawn'); }}>Withdraw</Button>
                    )}
                </div>
            </article>
        );
    };

    const pending = data.leaves.filter(l => l.status === 'pending' && (data.canManage || l.employeeId === data.me));
    const decided = data.leaves.filter(l => l.status !== 'pending' && (data.canManage || l.employeeId === data.me));
    const grid = 'grid gap-3 md:grid-cols-2 2xl:grid-cols-3 items-start';

    return (
        <div className="space-y-5">
            <form onSubmit={submit} className="neu-card p-4 space-y-3" aria-labelledby="leave-form-title">
                <h2 id="leave-form-title" className="font-serif text-lg text-gray-900 dark:text-white flex items-center gap-2"><Leaf size={16} className="text-[var(--neu-gold)]" />{data.canManage ? 'Ask for or record leave' : 'Ask for leave'}</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
                    {data.canManage && (
                        <Field label="Person" htmlFor="lv-person">
                            <Select id="lv-person" value={form.employeeId} onChange={e => setForm(f => ({ ...f, employeeId: e.target.value }))}>
                                {data.people.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === data.me ? ' (you)' : ''}</option>)}
                            </Select>
                        </Field>
                    )}
                    <Field label="First day" htmlFor="lv-from"><Input id="lv-from" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value, to: f.to < e.target.value ? e.target.value : f.to }))} /></Field>
                    <Field label="Last day" htmlFor="lv-to"><Input id="lv-to" type="date" value={form.to} min={form.from} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} /></Field>
                    <Field label="Type" htmlFor="lv-type"><Select id="lv-type" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>{LEAVE_TYPES.map(t => <option key={t}>{t}</option>)}</Select></Field>
                </div>
                <Field label="Reason (optional)" htmlFor="lv-reason" hint={data.canManage && form.employeeId !== data.me ? 'Leave you record for someone is approved straight away.' : 'Only you and managers see the reason.'}>
                    <Textarea id="lv-reason" rows={2} maxLength={300} value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="resize-none" />
                </Field>
                <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto" icon={saving ? <Loader2 size={14} className="animate-spin" /> : undefined}>
                    {data.canManage && form.employeeId !== data.me ? 'Record leave' : 'Send request'}
                </Button>
            </form>

            <section className="space-y-2.5">
                <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{data.canManage ? 'Waiting for a decision' : 'Your requests waiting'} · {pending.length}</h2>
                {pending.length ? <div className={grid}>{pending.map(card)}</div> : <p className="neu-card p-4 text-[13px] text-[var(--neu-text-dim)]">Nothing is waiting.</p>}
            </section>
            {decided.length > 0 && (
                <section className="space-y-2.5">
                    <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">Decided</h2>
                    <div className={grid}>{decided.map(card)}</div>
                </section>
            )}
        </div>
    );
};

