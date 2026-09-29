import React from 'react';
import { AlertTriangle, Leaf, Plus } from 'lucide-react';
import {
    WEEKLY_LIMIT_MIN, leaveOn, paidMin, weekdayIdx, type StaffShift,
} from '../../staffRosterRules';
import type { StaffRosterData } from '../../services/staffRosterService';
import {
    DOW, dayLabel, dayOfMonth, dm, hoursText, initials, matchesPerson, matchesStore, nextDay, shortRange, timeRange, todayIso,
    type Derived, type Filters,
} from './shared';

export interface WeekProps {
    data: StaffRosterData;
    d: Derived;
    dates: string[];
    filters: Filters;
    /** Managers edit; everyone else reads. */
    onEdit?: (shift: StaffShift) => void;
    onNew?: (employeeId: string | null, date: string) => void;
    /** Phone grid: a day with more than one entry opens in the day agenda. */
    onOpenDay?: (dayIdx: number) => void;
}

/** People to show, the signed-in person first when they only read the roster. */
function peopleFor(data: StaffRosterData, filters: Filters) {
    const list = data.people.filter(p => matchesPerson(p, filters));
    return data.canManage ? list : [...list.filter(p => p.id === data.me), ...list.filter(p => p.id !== data.me)];
}

const shiftsOf = (data: StaffRosterData, employeeId: string | null, date: string) =>
    data.shifts.filter(s => s.employeeId === employeeId && s.date === date).sort((a, b) => (a.kind === 'off' ? -1 : 0) - (b.kind === 'off' ? -1 : 0) || a.startMin - b.startMin);

const weekPaid = (data: StaffRosterData, employeeId: string, dates: string[]) =>
    data.shifts.filter(s => s.kind === 'shift' && s.employeeId === employeeId && dates.includes(s.date)).reduce((sum, s) => sum + paidMin(s), 0);

/** One shift, as on the desktop grid and the agenda. */
export const ShiftCard: React.FC<{ s: StaffShift; d: Derived; data: StaffRosterData; showName?: boolean; onEdit?: (s: StaffShift) => void }> = ({ s, d, data, showName, onEdit }) => {
    const issues = d.conflicts.get(s.id) ?? [];
    const overlap = issues.some(c => c.type === 'overlap');
    const onLeave = issues.some(c => c.type === 'leave');
    const open = !s.employeeId;
    const label = `${d.personName(s.employeeId)}, ${dayLabel(s.date)}, ${timeRange(s)}${nextDay(s) ? ' ending the next day' : ''} at ${d.storeName(s.storeId)}${overlap ? ', overlaps another shift' : ''}${onLeave ? ', during approved leave' : ''}`;
    const mine = s.employeeId === data.me && !data.canManage;
    const body = (
        <>
            {showName && <span className="font-semibold truncate max-w-full">{d.personName(s.employeeId)}</span>}
            <span className="font-semibold text-[12.5px] tabular-nums">{timeRange(s)}</span>
            <span className="text-[11.5px] truncate max-w-full">
                {d.storeName(s.storeId)}{open ? ` · ${s.role}` : ''}{nextDay(s) && <span className="opacity-80"> · +1 day</span>}
            </span>
            {open && <span className="text-[10px] font-bold uppercase tracking-wider">Needs cover</span>}
            {overlap && <span className="text-[10px] font-bold uppercase tracking-wider sr-bad-text inline-flex items-center gap-1"><AlertTriangle size={11} />Overlap</span>}
            {onLeave && <span className="text-[10px] font-bold uppercase tracking-wider sr-bad-text inline-flex items-center gap-1"><AlertTriangle size={11} />On leave · reassign</span>}
        </>
    );
    const cls = `w-full flex flex-col items-start gap-0.5 text-left rounded-[11px] border px-2.5 py-1.5 text-[12px] leading-tight ${open ? 'sr-open border-[1.5px]' : d.storeClass(s.storeId)} ${overlap || onLeave ? 'sr-conflict' : ''} ${mine ? 'ring-1 ring-gold-500/60' : ''}`;
    return onEdit
        ? <button type="button" onClick={() => onEdit(s)} aria-label={`${label}. Edit`} className={`${cls} active-scale`}>{body}</button>
        : <div className={cls} aria-label={label}>{body}</div>;
};

const Avatar: React.FC<{ name: string; open?: boolean; small?: boolean }> = ({ name, open, small }) => (
    <span aria-hidden="true" className={`${small ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-[12px]'} shrink-0 rounded-full neu-raised-sm flex items-center justify-center font-semibold ${open ? 'sr-open-text' : 'text-gold-700 dark:text-gold-300'}`}>
        {open ? <AlertTriangle size={small ? 12 : 14} /> : initials(name)}
    </span>
);

/** Desktop and tablet: a table with the people down the side and the days across. */
export const WeekGrid: React.FC<WeekProps> = ({ data, d, dates, filters, onEdit, onNew }) => {
    const today = todayIso();
    const people = peopleFor(data, filters);
    const opens = data.shifts.filter(s => !s.employeeId && dates.includes(s.date) && matchesStore(s, filters) && (filters.title === 'all' || s.role === filters.title));
    return (
        <div className="neu-card p-2.5">
            <div className="overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-xl no-scrollbar" tabIndex={0} aria-label="Weekly roster; scrolls sideways">
                <table className="w-full min-w-[980px] table-fixed border-separate border-spacing-0 text-[13px]">
                    <colgroup>
                        <col className="w-52" />
                        {dates.map(date => <col key={date} />)}
                        <col className="w-[5.5rem]" />
                    </colgroup>
                    <thead>
                        <tr>
                            <th scope="col" className="sticky top-0 left-0 z-30 bg-[var(--neu-bg)] text-left px-2 py-2.5 text-[12px] font-semibold border-b border-[var(--neu-line)]">Employee</th>
                            {dates.map(date => (
                                <th key={date} scope="col" className="sticky top-0 z-20 bg-[var(--neu-bg)] text-left px-2 py-2.5 border-b border-[var(--neu-line)]">
                                    <span className="block text-[10.5px] uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{DOW[weekdayIdx(date)]}{date === today && <span className="normal-case tracking-normal text-[var(--neu-gold)]"> · today</span>}</span>
                                    <span className={`text-[14px] font-semibold tabular-nums ${date === today ? 'text-[var(--neu-gold)]' : ''}`}>{dm(date)}</span>
                                </th>
                            ))}
                            <th scope="col" className="sticky top-0 z-20 bg-[var(--neu-bg)] text-right px-3 py-2.5 text-[12px] font-semibold border-b border-[var(--neu-line)]">Hours</th>
                        </tr>
                    </thead>
                    <tbody>
                        {people.map(p => {
                            const paid = weekPaid(data, p.id, dates);
                            const over = paid > WEEKLY_LIMIT_MIN;
                            return (
                                <tr key={p.id}>
                                    <th scope="row" className={`sticky left-0 z-10 bg-[var(--neu-bg)] text-left align-top px-2 py-2 border-b border-[var(--neu-line)] font-normal ${p.id === data.me ? 'shadow-[inset_3px_0_0_var(--neu-gold)]' : ''}`}>
                                        <div className="flex items-center gap-2.5">
                                            <Avatar name={p.name} />
                                            <div className="min-w-0">
                                                <div className="font-semibold truncate">{p.name}{p.id === data.me && <span className="text-[var(--neu-text-dim)] font-normal"> (you)</span>}</div>
                                                <div className="text-[12px] text-[var(--neu-text-dim)] truncate">{p.title || 'No job title'}</div>
                                            </div>
                                        </div>
                                    </th>
                                    {dates.map(date => {
                                        const all = shiftsOf(data, p.id, date);
                                        const work = all.filter(s => s.kind === 'shift');
                                        const shown = work.filter(s => matchesStore(s, filters));
                                        const off = all.find(s => s.kind === 'off');
                                        const leave = leaveOn(data.leaves, p.id, date);
                                        const pending = leaveOn(data.leaves, p.id, date, 'pending');
                                        return (
                                            <td key={date} className="align-top p-1.5 border-b border-[var(--neu-line)]">
                                                <div className="flex flex-col gap-1.5 min-h-[56px]">
                                                    {leave && <span className="sr-leave border rounded-[11px] px-2.5 py-1.5 text-[12px] font-medium inline-flex items-center gap-1.5"><Leaf size={12} />{leave.type}</span>}
                                                    {shown.map(s => <ShiftCard key={s.id} s={s} d={d} data={data} onEdit={onEdit} />)}
                                                    {off && !work.length && !leave && (
                                                        onEdit
                                                            ? <button type="button" onClick={() => onEdit(off)} className="sr-off border rounded-[11px] px-2.5 py-1.5 text-[12px] font-medium text-left active-scale" aria-label={`${p.name}, ${dayLabel(date)}: day off. Edit`}>Day off</button>
                                                            : <span className="sr-off border rounded-[11px] px-2.5 py-1.5 text-[12px] font-medium">Day off</span>
                                                    )}
                                                    {pending && <span className="sr-pending border rounded-[9px] px-2 py-1 text-[11px]" title="Waiting for approval">Leave requested</span>}
                                                    {onNew && !shown.length && !off && !leave && (
                                                        <button type="button" onClick={() => onNew(p.id, date)} aria-label={`Add a shift for ${p.name} on ${dayLabel(date)}`}
                                                            className="flex-1 min-h-[44px] rounded-[11px] border border-dashed border-transparent hover:border-[var(--neu-line)] focus-visible:border-[var(--neu-line)] text-[var(--neu-text-dim)] opacity-50 hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-70 flex items-center justify-center">
                                                            <Plus size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        );
                                    })}
                                    <td className={`align-top text-right px-3 py-2.5 border-b border-[var(--neu-line)] font-semibold tabular-nums ${over ? 'sr-bad-text' : ''}`}>
                                        {hoursText(paid)} h
                                        <span className="block text-[11px] font-normal text-[var(--neu-text-dim)]">{over ? 'over 48 h' : 'paid'}</span>
                                    </td>
                                </tr>
                            );
                        })}
                        {people.length === 0 && (
                            <tr><td colSpan={9} className="p-5 text-[13px] text-[var(--neu-text-dim)]">No one matches these filters.</td></tr>
                        )}
                        <tr className="sr-open-row">
                            <th scope="row" className="sticky left-0 z-10 sr-open-row text-left align-top px-2 py-2 font-normal">
                                <div className="flex items-center gap-2.5">
                                    <Avatar name="" open />
                                    <div><div className="font-semibold">Unassigned</div><div className="text-[12px] text-[var(--neu-text-dim)]">Open shifts · {opens.length}</div></div>
                                </div>
                            </th>
                            {dates.map(date => {
                                const list = opens.filter(s => s.date === date);
                                return (
                                    <td key={date} className="align-top p-1.5">
                                        <div className="flex flex-col gap-1.5 min-h-[44px]">
                                            {list.length ? list.map(s => <ShiftCard key={s.id} s={s} d={d} data={data} onEdit={onEdit} />) : <span className="m-auto text-[var(--neu-text-dim)] opacity-60" aria-hidden="true">—</span>}
                                        </div>
                                    </td>
                                );
                            })}
                            <td />
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    );
};

/** A tile in the phone week: a button when it does something. */
const DayTile: React.FC<{ dayIdx: number; content: React.ReactNode; cls: string; label: string; act?: () => void }> = ({ dayIdx, content, cls, label, act }) => (
    act
        ? <button type="button" onClick={act} aria-label={label} className={`h-[52px] min-w-0 rounded-[10px] border flex flex-col items-center justify-center text-center leading-tight active-scale ${cls}`}>{content}</button>
        : <div aria-label={label} className={`h-[52px] min-w-0 rounded-[10px] border flex flex-col items-center justify-center text-center leading-tight ${cls}`} data-day={dayIdx}>{content}</div>
);

type TileLook = { content: React.ReactNode; cls: string; label: string; act?: () => void };

interface DayArgs {
    data: StaffRosterData; d: Derived; filters: Filters; employeeId: string | null; name: string; date: string;
    openDay?: () => void; onEdit?: (s: StaffShift) => void; onNew?: (employeeId: string | null, date: string) => void;
}

/** A day with shifts: the first one's times and store (or "+N MORE"), tinted by store; conflicts and requested leave marked. */
function workTile(a: DayArgs, work: StaffShift[], ring: string, pending: boolean): TileLook {
    const { d, employeeId, name, date } = a;
    const s = work[0];
    const bad = work.some(x => d.conflicts.has(x.id));
    const more = work.length > 1;
    const storeTag = d.storeName(s.storeId).slice(0, 3).toUpperCase() + (nextDay(s) ? ' ⁺¹' : '');
    const tint = employeeId ? d.storeClass(s.storeId) : 'sr-open border-[1.5px]';
    return {
        content: (
            <>
                <span className="text-[11px] font-semibold tabular-nums tracking-tight">{shortRange(s)}</span>
                <span className="text-[9px] font-semibold tracking-wider opacity-80">{more ? `+${work.length - 1} MORE` : storeTag}</span>
                {bad && <span className="sr-only">has a conflict</span>}
            </>
        ),
        cls: `${tint}${bad ? ' sr-conflict' : ''}${ring}`,
        label: `${name}, ${dayLabel(date)}: ${work.map(x => timeRange(x) + ' at ' + d.storeName(x.storeId)).join(', ')}${bad ? ', has a conflict' : ''}${pending ? ', leave requested' : ''}`,
        act: more || !a.onEdit ? a.openDay : () => a.onEdit?.(s),
    };
}

/** What a person's day shows on the phone week: leave, work, a day off, a way to add a shift, or nothing. */
function describeDay(a: DayArgs): TileLook {
    const { data, employeeId, name, date } = a;
    const all = shiftsOf(data, employeeId, date);
    const work = all.filter(s => s.kind === 'shift' && matchesStore(s, a.filters));
    const off = all.find(s => s.kind === 'off');
    const leave = employeeId ? leaveOn(data.leaves, employeeId, date) : undefined;
    const pending = !!employeeId && !!leaveOn(data.leaves, employeeId, date, 'pending');
    const ring = pending ? ' outline outline-1 outline-dashed outline-offset-1 outline-[var(--sr-leave-edge)]' : '';
    if (leave) {
        return { content: <><Leaf size={12} /><span className="text-[10px] font-semibold mt-0.5">Leave</span></>, cls: 'sr-leave' + ring, label: `${name}, ${dayLabel(date)}: ${leave.type}`, act: work.length ? a.openDay : undefined };
    }
    if (work.length) return workTile(a, work, ring, pending);
    if (off) return { content: <span className="text-[10.5px] font-medium">Off</span>, cls: 'sr-off' + ring, label: `${name}, ${dayLabel(date)}: day off`, act: a.onEdit ? () => a.onEdit?.(off) : undefined };
    if (employeeId && a.onNew) {
        return { content: <Plus size={13} className="opacity-60" />, cls: 'border-dashed border-[var(--neu-line)] text-[var(--neu-text-dim)]' + ring, label: `Add a shift for ${name} on ${dayLabel(date)}`, act: () => a.onNew?.(employeeId, date) };
    }
    return { content: <span className="text-[var(--neu-text-dim)] opacity-50">·</span>, cls: 'border-transparent' + ring, label: `${name}, ${dayLabel(date)}: nothing planned${pending ? ', leave requested' : ''}` };
}

/**
 * Phones: the whole week without sideways scrolling. Each person is a short
 * row of seven day tiles — the times, the store's first letters and its tint —
 * so a week reads like a timetable. A tile opens the shift; a day with more
 * than one entry opens that day's agenda.
 */
export const PhoneWeek: React.FC<WeekProps> = ({ data, d, dates, filters, onEdit, onNew, onOpenDay }) => {
    const today = todayIso();
    const people = peopleFor(data, filters);
    const opens = data.shifts.filter(s => !s.employeeId && dates.includes(s.date) && matchesStore(s, filters) && (filters.title === 'all' || s.role === filters.title));

    const dayTile = (employeeId: string | null, name: string, date: string, i: number) => (
        <DayTile key={date} dayIdx={i} {...describeDay({ data, d, filters, employeeId, name, date, openDay: onOpenDay ? () => onOpenDay(i) : undefined, onEdit, onNew })} />
    );

    return (
        <div className="neu-card p-3 space-y-3">
            {/* Day header, lined up with the tiles below */}
            <div className="grid grid-cols-7 gap-1 sticky top-0 z-10 -mx-3 px-3 py-1.5 bg-[var(--neu-bg)] rounded-t-2xl">
                {dates.map(date => (
                    <div key={date} className={`text-center leading-tight ${date === today ? 'text-[var(--neu-gold)]' : 'text-[var(--neu-text-dim)]'}`}>
                        <span className="block text-[10px] font-semibold uppercase tracking-wider">{DOW[weekdayIdx(date)].slice(0, 2)}</span>
                        <span className="block text-[13px] font-semibold tabular-nums">{dayOfMonth(date)}</span>
                    </div>
                ))}
            </div>

            {opens.length > 0 && (
                <div className="rounded-2xl p-2 sr-open-row space-y-1.5">
                    <p className="px-1 text-[11px] font-semibold sr-open-text flex items-center gap-1.5"><AlertTriangle size={12} />Needs cover · {opens.length}</p>
                    <div className="grid grid-cols-7 gap-1">
                        {dates.map((date, i) => dayTile(null, 'Open shift', date, i))}
                    </div>
                </div>
            )}

            {people.map(p => {
                const paid = weekPaid(data, p.id, dates);
                return (
                    <div key={p.id} className={`space-y-1.5 ${p.id === data.me ? 'rounded-2xl p-1.5 -mx-1.5 neu-inset' : ''}`}>
                        <div className="flex items-center gap-2 px-0.5">
                            <Avatar name={p.name} small />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{p.name}{p.id === data.me && <span className="font-normal text-[var(--neu-text-dim)]"> (you)</span>}<span className="font-normal text-[var(--neu-text-dim)]">{p.title ? ` · ${p.title}` : ''}</span></span>
                            <span className={`shrink-0 text-[12px] font-semibold tabular-nums ${paid > WEEKLY_LIMIT_MIN ? 'sr-bad-text' : 'text-[var(--neu-text-dim)]'}`}>{hoursText(paid)} h</span>
                        </div>
                        <div className="grid grid-cols-7 gap-1">
                            {dates.map((date, i) => dayTile(p.id, p.name, date, i))}
                        </div>
                    </div>
                );
            })}
            {people.length === 0 && <p className="text-[13px] text-[var(--neu-text-dim)] p-2">No one matches these filters.</p>}
        </div>
    );
};

/** One day, as cards: who works, who is off or on leave, and what still needs cover. */
export const DayAgenda: React.FC<WeekProps & { dayIdx: number; onDay: (i: number) => void }> = ({ data, d, dates, filters, onEdit, onNew, dayIdx, onDay }) => {
    const today = todayIso();
    const date = dates[dayIdx];
    const opens = data.shifts.filter(s => !s.employeeId && s.date === date && matchesStore(s, filters) && (filters.title === 'all' || s.role === filters.title));
    const people = peopleFor(data, filters);
    return (
        <div className="space-y-4">
            <div className="neu-card p-2 grid grid-cols-7 gap-1" role="group" aria-label="Choose a day">
                {dates.map((dt, i) => {
                    const staff = new Set(data.shifts.filter(s => s.kind === 'shift' && s.employeeId && s.date === dt && matchesStore(s, filters)).map(s => s.employeeId)).size;
                    const open = data.shifts.filter(s => !s.employeeId && s.date === dt && matchesStore(s, filters)).length;
                    return (
                        <button key={dt} type="button" onClick={() => onDay(i)} aria-pressed={i === dayIdx}
                            aria-label={`${dayLabel(dt)}: ${staff} on shift${open ? ', ' + open + ' open' : ''}`}
                            className={`rounded-2xl py-2 flex flex-col items-center leading-tight active-scale ${i === dayIdx ? 'neu-inset text-[var(--neu-gold)]' : 'text-[var(--neu-text-dim)]'}`}>
                            <span className="text-[10.5px] font-semibold uppercase">{DOW[i]}</span>
                            <span className={`text-[16px] font-semibold tabular-nums ${i === dayIdx ? '' : 'text-[var(--neu-text)]'}`}>{dayOfMonth(dt)}</span>
                            <span className="text-[9.5px] tabular-nums">{staff} staff{open ? ` · ${open} open` : ''}</span>
                        </button>
                    );
                })}
            </div>

            <h3 className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--neu-text-dim)]">{dayLabel(date)}{date === today ? ' · today' : ''}</h3>

            {opens.length > 0 && (
                <div className="space-y-2">
                    {opens.map(s => (
                        <div key={s.id} className="neu-card p-3 flex gap-3 items-start">
                            <Avatar name="" open />
                            <div className="flex-1 min-w-0 space-y-1.5"><p className="text-[13px] font-semibold">Needs cover <span className="font-normal text-[var(--neu-text-dim)]">· {s.role}</span></p><ShiftCard s={s} d={d} data={data} onEdit={onEdit} /></div>
                        </div>
                    ))}
                </div>
            )}

            <div className="space-y-2">
                {people.map(p => {
                    const all = shiftsOf(data, p.id, date);
                    const work = all.filter(s => s.kind === 'shift' && matchesStore(s, filters));
                    if (filters.storeId !== 'all' && !work.length) return null;
                    const off = all.find(s => s.kind === 'off');
                    const leave = leaveOn(data.leaves, p.id, date);
                    const pending = leaveOn(data.leaves, p.id, date, 'pending');
                    return (
                        <div key={p.id} className={`neu-card p-3 flex gap-3 items-start ${p.id === data.me ? 'ring-1 ring-gold-500/50' : ''}`}>
                            <Avatar name={p.name} />
                            <div className="flex-1 min-w-0 space-y-1.5">
                                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                    <span className="text-[13.5px] font-semibold">{p.name}{p.id === data.me && <span className="font-normal text-[var(--neu-text-dim)]"> (you)</span>}</span>
                                    <span className="text-[12px] text-[var(--neu-text-dim)]">{p.title}</span>
                                </div>
                                {leave && <span className="sr-leave border rounded-[11px] px-2.5 py-1.5 text-[12px] font-medium inline-flex items-center gap-1.5"><Leaf size={12} />{leave.type}</span>}
                                {work.map(s => <ShiftCard key={s.id} s={s} d={d} data={data} onEdit={onEdit} />)}
                                {!work.length && !leave && off && <span className="sr-off border rounded-[11px] px-2.5 py-1.5 text-[12px] font-medium inline-block">Day off</span>}
                                {!work.length && !leave && !off && (
                                    <div className="flex items-center gap-3">
                                        <span className="text-[12.5px] text-[var(--neu-text-dim)]">Not scheduled</span>
                                        {onNew && <button type="button" onClick={() => onNew(p.id, date)} className="neu-button !py-1.5 !px-3 !text-[12px]"><Plus size={13} /> Add shift</button>}
                                    </div>
                                )}
                                {pending && <span className="sr-pending border rounded-[9px] px-2 py-1 text-[11px] inline-block">Leave requested (waiting)</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
