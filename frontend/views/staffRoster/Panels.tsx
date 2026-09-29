import React, { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, Copy, Download, Loader2, Send, X } from 'lucide-react';
import { FullScreenPortal } from '../../components/FullScreenPortal';
import { Button, Field, Input, Select, Textarea, Toggle } from '../../components/ui';
import {
    addDays, defaultBreakMin, endsNextDay, findConflicts, leaveOn, minToTime, mondayOf, paidMin, shiftFieldErrors, shiftLengthMin,
    timeToMin, weekDates, weekdayIdx, type Conflict, type StaffShift,
} from '../../staffRosterRules';
import { staffRosterService, type ShiftInput, type StaffRosterData } from '../../services/staffRosterService';
import { DOW, dayLabel, dayOfMonth, hoursText, inWeek, rangeLabel, timeRange, type Derived } from './shared';

/** A panel on the right on desktop, the whole screen on a phone. Focus stays inside; Escape closes. */

function editorHeading(dayOff: boolean, isNew: boolean, duplicate: boolean): string {
    if (dayOff) return isNew ? 'Mark a day off' : 'Day off';
    if (!isNew) return 'Edit shift';
    return duplicate ? 'Duplicate shift' : 'New shift';
}

const publishedNote = (n: number): string => `Published. ${n} ${n === 1 ? 'person was' : 'people were'} notified.`;
export const Drawer: React.FC<{ title: string; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode }> = ({ title, onClose, footer, children }) => {
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const back = document.activeElement as HTMLElement | null;
        const first = box.current?.querySelector<HTMLElement>('[data-autofocus], select, input, textarea, button');
        first?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
            if (e.key !== 'Tab' || !box.current) return;
            const f = [...box.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea')];
            if (!f.length) return;
            if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
            else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
        };
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('keydown', onKey); back?.focus?.(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
        <FullScreenPortal>
            <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 w-full h-full cursor-default neu-scrim hidden lg:block" tabIndex={-1} />
            <div ref={box} role="dialog" aria-modal="true" aria-label={title}
                className="absolute inset-0 lg:left-auto lg:w-[440px] bg-[var(--neu-bg)] flex flex-col lg:shadow-[-18px_0_40px_var(--neu-shadow-dark)] animate-fade-in-up lg:animate-fade-in">
                <div className="flex items-center justify-between gap-3 px-4 pb-2" style={{ paddingTop: 'calc(0.9rem + var(--safe-top))' }}>
                    <h2 className="font-serif text-xl text-gray-900 dark:text-white truncate">{title}</h2>
                    <button type="button" onClick={onClose} aria-label="Close" className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale"><X size={18} /></button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pb-4 space-y-4">{children}</div>
                {footer && <div className="flex flex-wrap items-center gap-2 px-4 pt-3 border-t border-[var(--neu-line)]" style={{ paddingBottom: 'calc(0.9rem + var(--safe-bottom-ui))' }}>{footer}</div>}
            </div>
        </FullScreenPortal>
    );
};

const MSG_TONE = { error: 'sr-bad-box', warn: 'sr-warn-box', info: 'neu-inset text-[var(--neu-text-dim)]' } as const;

export const Msg: React.FC<{ kind: keyof typeof MSG_TONE; children: React.ReactNode }> = ({ kind, children }) => (
    <p className={`rounded-xl px-3 py-2 text-[12.5px] flex gap-2 items-start ${MSG_TONE[kind]}`}>
        {kind !== 'info' && <AlertTriangle size={14} className="shrink-0 mt-px" />}<span>{children}</span>
    </p>
);

type Person = StaffRosterData['people'][number];

/**
 * What saving would run into for this person: overlapping shifts and approved
 * leave (both block publishing), leave still waiting for a decision, and a
 * day off that the shift would replace. One line per problem, per day.
 */
function personWarnings(s: ShiftInput, first: string, repeat: string[], data: StaffRosterData, d: Derived, editingId: string | null): string[] {
    const warns: string[] = [];
    const candidates = [...repeat, s.date].map((date, i) => ({ ...s, date, id: `__new${i}` }));
    const others = data.shifts.filter(x => x.id !== editingId);
    const conflicts = findConflicts([...others, ...candidates], data.leaves);
    for (const c of candidates) {
        for (const hit of conflicts.get(c.id) ?? []) {
            if (hit.type === 'overlap') {
                const o = others.find(x => x.id === hit.otherId);
                if (o) warns.push(`Overlaps ${first}’s ${timeRange(o)} at ${d.storeName(o.storeId)} on ${dayLabel(o.date)}. Overlapping shifts block publishing.`);
            } else {
                const l = data.leaves.find(x => x.id === hit.leaveId);
                warns.push(`${first} is on approved ${l?.type.toLowerCase() ?? 'leave'} on ${dayLabel(c.date)}. Shifts during approved leave block publishing.`);
            }
        }
        if (leaveOn(data.leaves, s.employeeId as string, c.date, 'pending')) warns.push(`${first} has asked for leave on ${dayLabel(c.date)} (waiting for a decision).`);
        if (data.shifts.some(x => x.kind === 'off' && x.employeeId === s.employeeId && x.date === c.date)) warns.push(`${dayLabel(c.date)} is ${first}’s day off. Saving replaces it with this shift.`);
    }
    return warns;
}

/** Notes on a shift being edited: errors block saving; warnings and notes explain. */
function shiftChecks({ s, repeat, data, d, editingId, person, timesValid }: {
    s: ShiftInput; repeat: string[]; data: StaffRosterData; d: Derived; editingId: string | null; person: Person | undefined; timesValid: boolean;
}): { errors: string[]; warns: string[]; infos: string[] } {
    const errors = timesValid ? shiftFieldErrors(s) : ['Enter a start and an end time.'];
    const warns: string[] = [], infos: string[] = [];
    if (s.kind === 'shift' && !errors.length) {
        if (endsNextDay(s)) infos.push(`Ends the next day (+1 day), at ${minToTime(s.endMin)} on ${dayLabel(addDays(s.date, 1))}.`);
        if (s.employeeId) {
            const first = (person?.name ?? 'This person').split(' ')[0];
            warns.push(...personWarnings(s, first, repeat, data, d, editingId));
            if (person?.title && s.role && person.title !== s.role) infos.push(`${first} is a ${person.title.toLowerCase()}; this shift asks for a ${s.role.toLowerCase()}.`);
        } else infos.push('No one is assigned. It shows as an open shift that needs cover, and can be published that way.');
    }
    const busyThatDay = s.kind === 'off' && !!s.employeeId && data.shifts.some(x => x.kind === 'shift' && x.employeeId === s.employeeId && x.date === s.date && x.id !== editingId);
    if (busyThatDay) errors.push(`${person?.name ?? 'This person'} has a shift that day. Remove it first.`);
    if (repeat.length) infos.push(`Also adds this on ${repeat.map(x => DOW[weekdayIdx(x)]).join(', ')}.`);
    return { errors, warns: [...new Set(warns)], infos };
}

/** A shift's status in the export. */
function csvStatus(s: StaffShift, d: Derived): string {
    const c = d.conflicts.get(s.id) ?? [];
    if (s.kind === 'off') return 'Day off';
    if (!s.employeeId) return 'Open';
    if (c.some(x => x.type === 'overlap')) return 'Overlap';
    return c.length ? 'During leave' : 'Scheduled';
}

/** A shift's row in the export; a day off leaves the work columns empty. */
function csvRow(s: StaffShift, d: Derived): string[] {
    const person = s.employeeId ? d.personName(s.employeeId) : '';
    if (s.kind !== 'shift') return [s.date, DOW[weekdayIdx(s.date)], person, '', '', '', '', '', '', '', csvStatus(s, d), s.note];
    return [s.date, DOW[weekdayIdx(s.date)], person, s.role, d.storeName(s.storeId), minToTime(s.startMin), minToTime(s.endMin),
        endsNextDay(s) ? 'Yes' : '', String(s.breakMin), hoursText(paidMin(s)), csvStatus(s, d), s.note];
}

export interface EditorState { id: string | null; draft: ShiftInput; duplicate?: boolean }

const BREAKS = [0, 15, 30, 45, 60, 90];

/** Add or change a shift or a day off. Managers only; the server checks again. */
export const ShiftEditor: React.FC<{ data: StaffRosterData; d: Derived; start: EditorState; onClose: () => void; onSaved: () => void }> = ({ data, d, start, onClose, onSaved }) => {
    const [state, setState] = useState(start);
    const [s, setS] = useState<ShiftInput>(start.draft);
    const [startText, setStartText] = useState(minToTime(start.draft.startMin));
    const [endText, setEndText] = useState(minToTime(start.draft.endMin));
    const [repeat, setRepeat] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [breakTouched, setBreakTouched] = useState(!!start.id);
    const [title, setTitle] = useState('');
    const isNew = !state.id;
    const person = d.person(s.employeeId);

    useEffect(() => { setTitle(person?.title ?? ''); }, [person?.title, s.employeeId]);

    const set = (patch: Partial<ShiftInput>) => setS(prev => ({ ...prev, ...patch }));
    const setTimes = (a: string, b: string) => {
        setStartText(a); setEndText(b);
        const sm = timeToMin(a), em = timeToMin(b);
        if (sm === null || em === null) return;
        set({ startMin: sm, endMin: em, ...(breakTouched || sm === em ? {} : { breakMin: defaultBreakMin(sm, em) }) });
    };
    const timesValid = timeToMin(startText) !== null && timeToMin(endText) !== null;

    const { errors, warns, infos } = useMemo(
        () => shiftChecks({ s, repeat, data, d, editingId: state.id, person, timesValid }),
        [s, repeat, data, d, state.id, person, timesValid],
    );

    const save = async () => {
        if (errors.length) return;
        setBusy(true);
        try {
            if (state.id) await staffRosterService.updateShift(state.id, s);
            else await staffRosterService.createShifts([s, ...repeat.map(date => ({ ...s, date }))]);
            const days = repeat.length ? ' on ' + (repeat.length + 1) + ' days' : '';
            const saved = state.id ? 'Shift saved' : 'Shift added';
            toast.success(s.kind === 'off' ? 'Day off saved' : saved + days);
            onSaved();
        } catch (e) {
            toast.error((e as Error).message || 'Could not save');
        } finally { setBusy(false); }
    };

    const remove = async () => {
        if (!state.id) return;
        if (!confirmDelete) { setConfirmDelete(true); return; }
        setBusy(true);
        try { await staffRosterService.deleteShift(state.id); toast.success(s.kind === 'off' ? 'Day off removed' : 'Shift deleted'); onSaved(); }
        catch (e) { toast.error((e as Error).message || 'Could not delete'); setBusy(false); }
    };

    const saveTitle = async () => {
        if (!s.employeeId) return;
        try { await staffRosterService.setTitle(s.employeeId, title); toast.success('Job title saved'); onSaved(); }
        catch (e) { toast.error((e as Error).message || 'Could not save the job title'); }
    };

    const weekOfDate = weekDates(mondayOf(s.date));
    const heading = editorHeading(s.kind === 'off', isNew, !!state.duplicate);
    const roles = [...new Set([...data.jobTitles, s.role].filter(Boolean))];

    return (
        <Drawer title={heading} onClose={onClose} footer={
            <>
                {!isNew && <Button variant="danger" onClick={() => { void remove(); }} disabled={busy}>{confirmDelete ? 'Confirm delete' : 'Delete'}</Button>}
                {!isNew && s.kind === 'shift' && (
                    <Button onClick={() => { setState({ id: null, draft: s, duplicate: true }); setConfirmDelete(false); toast('Copy ready. Change the day or person, then save.'); }}>Duplicate</Button>
                )}
                <span className="flex-1" />
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={() => { void save(); }} disabled={busy || errors.length > 0} aria-describedby="shift-msgs"
                    icon={busy ? <Loader2 size={14} className="animate-spin" /> : undefined}>
                    {s.kind === 'off' ? 'Save day off' : 'Save shift'}
                </Button>
            </>
        }>
            {isNew && (
                <div className="flex gap-2" role="radiogroup" aria-label="What to add">
                    {(['shift', 'off'] as const).map(k => (
                        <button key={k} type="button" role="radio" aria-checked={s.kind === k}
                            onClick={() => set({ kind: k, employeeId: k === 'off' ? (s.employeeId ?? data.people[0]?.id ?? null) : s.employeeId })}
                            className={`flex-1 rounded-full py-2 text-[12px] font-semibold uppercase tracking-wider ${s.kind === k ? 'neu-inset text-gold-700 dark:text-gold-300' : 'neu-raised-sm text-gray-700 dark:text-gray-300'}`}>
                            {k === 'shift' ? 'Shift' : 'Day off'}
                        </button>
                    ))}
                </div>
            )}
            <Field label="Employee" htmlFor="sh-emp">
                <Select id="sh-emp" data-autofocus value={s.employeeId ?? ''} onChange={e => {
                    const id = e.target.value || null;
                    const p = d.person(id);
                    set({ employeeId: id, ...(p?.title && isNew ? { role: p.title } : {}) });
                }}>
                    {s.kind === 'shift' && <option value="">Unassigned (open shift)</option>}
                    {data.people.map(p => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
                </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
                {s.kind === 'shift' && (
                    <Field label="Store" htmlFor="sh-store">
                        <Select id="sh-store" value={s.storeId ?? ''} onChange={e => set({ storeId: e.target.value || null })}>
                            <option value="">Choose a store</option>
                            {data.stores.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                        </Select>
                    </Field>
                )}
                <Field label="Date" htmlFor="sh-date" className={s.kind === 'off' ? 'col-span-2' : ''}>
                    <Input id="sh-date" type="date" value={s.date} onChange={e => { if (e.target.value) { set({ date: e.target.value }); setRepeat([]); } }} />
                </Field>
            </div>
            {s.kind === 'shift' && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <Field label="Start" htmlFor="sh-start"><Input id="sh-start" type="time" step={900} value={startText} onChange={e => setTimes(e.target.value, endText)} className="tabular-nums" /></Field>
                        <Field label="End" htmlFor="sh-end"><Input id="sh-end" type="time" step={900} value={endText} onChange={e => setTimes(startText, e.target.value)} className="tabular-nums" /></Field>
                        <Field label="Unpaid break" htmlFor="sh-break" className="col-span-2 sm:col-span-1">
                            <Select id="sh-break" value={s.breakMin} onChange={e => { setBreakTouched(true); set({ breakMin: Number(e.target.value) }); }}>
                                {[...new Set([...BREAKS, s.breakMin])].sort((a, b) => a - b).map(b => <option key={b} value={b}>{b} min</option>)}
                            </Select>
                        </Field>
                    </div>
                    {timesValid && s.startMin !== s.endMin && (
                        <p className="text-[12.5px] text-[var(--neu-text-dim)] tabular-nums">
                            {hoursText(shiftLengthMin(s))} h − {s.breakMin} min unpaid break = <strong className="text-[var(--neu-text)]">{hoursText(paidMin(s))} paid hours</strong>{endsNextDay(s) ? ' · ends +1 day' : ''}
                        </p>
                    )}
                    <Field label="Role needed" htmlFor="sh-role">
                        <Select id="sh-role" value={s.role} onChange={e => set({ role: e.target.value })}>
                            <option value="">Choose a role</option>
                            {roles.map(r => <option key={r}>{r}</option>)}
                        </Select>
                    </Field>
                </>
            )}
            <Field label="Note (optional)" htmlFor="sh-note">
                <Textarea id="sh-note" rows={2} maxLength={200} value={s.note} onChange={e => set({ note: e.target.value })} placeholder={s.kind === 'off' ? 'e.g. Swapped with Priya' : 'e.g. Opening; receive the Kerala shipment'} className="resize-none" />
            </Field>
            {isNew && (
                <div>
                    <p className="neu-label" id="sh-rep">Also on</p>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="sh-rep">
                        {weekOfDate.filter(x => x !== s.date).map(x => {
                            const on = repeat.includes(x);
                            return (
                                <button key={x} type="button" aria-pressed={on} onClick={() => setRepeat(r => (on ? r.filter(y => y !== x) : [...r, x].sort((a, b) => a.localeCompare(b))))}
                                    className={`rounded-full px-3 py-1.5 text-[12px] ${on ? 'neu-inset text-gold-700 dark:text-gold-300 font-semibold' : 'neu-raised-sm text-gray-700 dark:text-gray-300'}`}>
                                    {DOW[weekdayIdx(x)]} {dayOfMonth(x)}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            <div id="shift-msgs" className="space-y-2" aria-live="polite">
                {errors.map(t => <Msg key={t} kind="error">{t}</Msg>)}
                {warns.map(t => <Msg key={t} kind="warn">{t}</Msg>)}
                {infos.map(t => <Msg key={t} kind="info">{t}</Msg>)}
            </div>
            {s.employeeId && (
                <div className="neu-card p-3 space-y-2">
                    <Field label={`Job title · ${person?.name ?? ''}`} htmlFor="sh-title" hint="Shown under their name on the roster, for everyone.">
                        <div className="flex gap-2">
                            <Input id="sh-title" list="sh-titles" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="e.g. Sales associate" />
                            <Button onClick={() => { void saveTitle(); }} disabled={title === (person?.title ?? '')}>Save</Button>
                        </div>
                        <datalist id="sh-titles">{data.jobTitles.map(t => <option key={t} value={t} />)}</datalist>
                    </Field>
                </div>
            )}
        </Drawer>
    );
};

/** Shifts needing someone this week: open ones, and ones that fall in approved leave. */
export const OpenShiftsPanel: React.FC<{ data: StaffRosterData; d: Derived; weekStart: string; onEdit: (s: StaffShift) => void; onClose: () => void; onChanged: () => void }> = ({ data, d, weekStart, onEdit, onClose, onChanged }) => {
    const [busy, setBusy] = useState<string | null>(null);
    const opens = data.shifts.filter(s => s.kind === 'shift' && !s.employeeId && inWeek(s, weekStart)).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
    const onLeave = data.shifts.filter(s => inWeek(s, weekStart) && (d.conflicts.get(s.id) ?? []).some(c => c.type === 'leave'));
    const makeOpen = async (s: StaffShift) => {
        setBusy(s.id);
        try { await staffRosterService.updateShift(s.id, { ...s, employeeId: null }); toast.success('Now an open shift'); onChanged(); }
        catch (e) { toast.error((e as Error).message || 'Could not change it'); } finally { setBusy(null); }
    };
    const item = (s: StaffShift, leave: boolean) => (
        <div key={s.id} className="neu-card p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
                <p className="font-semibold text-[13.5px]">{leave ? `${d.personName(s.employeeId)} · on leave` : s.role}</p>
                <p className="text-[12px] text-[var(--neu-text-dim)] tabular-nums">{dayLabel(s.date)} · {timeRange(s)}{endsNextDay(s) ? ' (+1 day)' : ''} · {d.storeName(s.storeId)}</p>
                {s.note && <p className="text-[12px] text-[var(--neu-text-dim)]">{s.note}</p>}
            </div>
            <div className="flex flex-wrap gap-2 justify-end shrink-0">
                {leave && <Button disabled={busy === s.id} onClick={() => { void makeOpen(s); }}>Make open</Button>}
                <Button variant="primary" onClick={() => onEdit(s)}>{leave ? 'Reassign' : 'Assign'}</Button>
            </div>
        </div>
    );
    return (
        <Drawer title="Shifts needing cover" onClose={onClose} footer={<><span className="flex-1" /><Button onClick={onClose}>Done</Button></>}>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">{rangeLabel(weekStart)}. Assign someone, or leave a shift open on purpose; open shifts can still be published.</p>
            {onLeave.length > 0 && <><h3 className="neu-label !mb-0">During approved leave · {onLeave.length}</h3><div className="space-y-2">{onLeave.map(s => item(s, true))}</div></>}
            <h3 className="neu-label !mb-0">Open shifts · {opens.length}</h3>
            {opens.length ? <div className="space-y-2">{opens.map(s => item(s, false))}</div> : <p className="text-[13px] text-[var(--neu-text-dim)]">No open shifts this week.</p>}
        </Drawer>
    );
};

/** Review, then publish a week so staff see it. Blocked while it has conflicts. */
interface PublishProblem { s: StaffShift; text: string }

/** What blocks publishing a week: overlapping shifts (each pair once) and shifts during approved leave. */
function publishProblems(week: StaffShift[], data: StaffRosterData, d: Derived): PublishProblem[] {
    const problems: PublishProblem[] = [];
    const seen = new Set<string>();
    for (const s of week) {
        for (const c of d.conflicts.get(s.id) ?? []) {
            const key = c.type === 'overlap' ? [s.id, c.otherId].sort((a, b) => a.localeCompare(b)).join('|') : `${s.id}|leave`;
            if (seen.has(key)) continue;
            seen.add(key);
            problems.push({ s, text: problemText(s, c, data, d) });
        }
    }
    return problems;
}

function problemText(s: StaffShift, c: Conflict, data: StaffRosterData, d: Derived): string {
    const who = d.personName(s.employeeId);
    const where = `${timeRange(s)} at ${d.storeName(s.storeId)}`;
    if (c.type !== 'overlap') return `${who} is on approved leave on ${dayLabel(s.date)} but has ${where}.`;
    const o = data.shifts.find(x => x.id === c.otherId);
    return `${who}: ${dayLabel(s.date)} ${where} overlaps ${o ? timeRange(o) + ' at ' + d.storeName(o.storeId) : 'another shift'}.`;
}

const PublishProblems: React.FC<{ problems: PublishProblem[]; onFix: (s: StaffShift) => void }> = ({ problems, onFix }) => (
    <div className="space-y-2">
        {problems.map(p => (
            <p key={p.text} className="sr-bad-box rounded-xl px-3 py-2 text-[12.5px] flex gap-2 items-start">
                <AlertTriangle size={14} className="shrink-0 mt-px" />
                <span>{p.text} <button type="button" onClick={() => onFix(p.s)} className="underline font-semibold">Fix</button></span>
            </p>
        ))}
        <Msg kind="error">Fix these before publishing.</Msg>
    </div>
);

export const PublishDialog: React.FC<{ data: StaffRosterData; d: Derived; weekStart: string; notify: boolean; onNotify: (v: boolean) => void; onFix: (s: StaffShift) => void; onClose: () => void; onPublished: () => void }> = ({ data, d, weekStart, notify, onNotify, onFix, onClose, onPublished }) => {
    const [busy, setBusy] = useState(false);
    const week = data.shifts.filter(s => s.kind === 'shift' && inWeek(s, weekStart));
    const assigned = week.filter(s => s.employeeId).length;
    const open = week.filter(s => !s.employeeId).length;
    const staff = new Set(week.filter(s => s.employeeId && s.employeeId !== data.me).map(s => s.employeeId)).size;
    const problems = publishProblems(week, data, d);
    const blocked = problems.length > 0;
    const publish = async () => {
        setBusy(true);
        try {
            const res = await staffRosterService.publish(weekStart, notify);
            toast.success(res.notified ? publishedNote(res.notified) : 'Published.');
            onPublished();
        } catch (e) { toast.error((e as Error).message || 'Could not publish'); setBusy(false); }
    };
    return (
        <Drawer title="Publish roster" onClose={onClose} footer={
            <>
                <span className="flex-1" />
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={() => { void publish(); }} disabled={blocked || busy} icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}>Publish</Button>
            </>
        }>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">Staff see the published roster. You can keep planning afterwards; changes wait until you publish again.</p>
            <dl className="neu-inset rounded-2xl p-3.5 grid grid-cols-[1fr_auto] gap-y-2 text-[13.5px]">
                <dt className="text-[var(--neu-text-dim)]">Dates</dt><dd className="font-semibold text-right tabular-nums">{rangeLabel(weekStart)}</dd>
                <dt className="text-[var(--neu-text-dim)]">Assigned shifts</dt><dd className="font-semibold text-right tabular-nums">{assigned}</dd>
                <dt className="text-[var(--neu-text-dim)]">Open shifts</dt><dd className="font-semibold text-right tabular-nums">{open}</dd>
                <dt className="text-[var(--neu-text-dim)]">Conflicts</dt><dd className={`font-semibold text-right tabular-nums ${blocked ? 'sr-bad-text' : 'text-green-700 dark:text-green-400'}`}>{problems.length || 'None'}</dd>
            </dl>
            {blocked && <PublishProblems problems={problems} onFix={onFix} />}
            {!blocked && open > 0 && <Msg kind="warn">{open > 1 ? `${open} open shifts` : '1 open shift'} will be published as needing cover.</Msg>}
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-[13.5px] font-medium">Notify staff</p>
                    <p className="text-[11.5px] text-[var(--neu-text-dim)]">{staff ? `A notification to the ${staff} people with shifts this week, on devices where they allowed them.` : 'No one else has shifts this week.'}</p>
                </div>
                <Toggle checked={notify} onChange={() => onNotify(!notify)} label="Notify staff" />
            </div>
        </Drawer>
    );
};

/** The week as a spreadsheet file, with the filters on screen. */
export const ExportPanel: React.FC<{ csv: string; weekStart: string; onClose: () => void }> = ({ csv, weekStart, onClose }) => {
    const download = () => {
        const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `roster-${weekStart}.csv`;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(csv); toast.success('Copied'); }
        catch { toast.error('Copying isn’t allowed here. Use Download instead.'); }
    };
    const rows = csv.split('\n').length - 1;
    return (
        <Drawer title="Export roster" onClose={onClose} footer={<><span className="flex-1" /><Button onClick={() => { void copy(); }} icon={<Copy size={14} />}>Copy</Button><Button variant="primary" onClick={download} icon={<Download size={14} />} data-autofocus>Download CSV</Button></>}>
            <p className="text-[12.5px] text-[var(--neu-text-dim)]">{rangeLabel(weekStart)}: {rows} row{rows === 1 ? '' : 's'} with the store, role and name filters on screen. Opens in Excel, Numbers or Google Sheets.</p>
            <label htmlFor="csv-preview" className="sr-only">CSV preview</label>
            <textarea id="csv-preview" readOnly value={csv} className="neu-field w-full min-h-[240px] font-mono text-[11.5px] whitespace-pre" />
        </Drawer>
    );
};

/** CSV of the week's shifts and days off. */
export function rosterCsv(data: StaffRosterData, d: Derived, shifts: StaffShift[]): string {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
    const out = [['Date', 'Day', 'Employee', 'Job title', 'Store', 'Start', 'End', 'Ends next day', 'Break (min)', 'Paid hours', 'Status', 'Note']];
    for (const s of [...shifts].sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin)) out.push(csvRow(s, d));
    return out.map(r => r.map(q).join(',')).join('\n');
}
