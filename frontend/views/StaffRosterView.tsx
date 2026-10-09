import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
    AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, CopyPlus, Download, FileUp, Leaf, Loader2, Plus, Send, Store as StoreIcon, Users,
} from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { StatStrip, type Stat } from '../components/StatStrip';
import { Button, EmptyState, GhostIconButton, PageBody, PageHeader, PageRoot, PrimaryIconButton, Select, Toggle } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { realtimeService } from '../services/realtimeService';
import { staffRosterService, type StaffRosterData, type WeekInfo, type WeekStatus } from '../services/staffRosterService';
import { addDays, defaultBreakMin, mondayOf, paidMin, weekDates, weekdayIdx, type StaffShift } from '../staffRosterRules';
import { DayAgenda, PhoneWeek, WeekGrid } from './staffRoster/WeekViews';
import { CopyWeekPanel, ImportPanel } from './staffRoster/PlanTools';
import { ByStoreView, MonthView, RequestsView } from './staffRoster/OtherViews';
import { ExportPanel, OpenShiftsPanel, PublishDialog, ShiftEditor, rosterCsv, type EditorState } from './staffRoster/Panels';
import { derive, hoursText, inWeek, matchesPerson, matchesStore, rangeLabel, todayIso, type Derived, type Filters } from './staffRoster/shared';

type View = 'week' | 'month' | 'store' | 'requests';
type Overlay =
    | { kind: 'edit'; state: EditorState }
    | { kind: 'open' } | { kind: 'publish' } | { kind: 'export' } | { kind: 'copy' } | { kind: 'import' } | null;

const NOTIFY_KEY = 'vayu.staffRoster.notify';
const STATUS_TEXT = { draft: 'Draft', published: 'Published', changed: 'Unpublished changes' } as const;
const STATUS_CLS = {
    draft: 'neu-inset text-[var(--neu-text-dim)]',
    published: 'neu-inset text-green-700 dark:text-green-400',
    changed: 'sr-warn-box',
} as const;

/** The four figures above the roster: the team's week for managers, your own for everyone else. */
function summaryStats(manage: boolean, data: StaffRosterData | null, work: StaffShift[], openCount: number, pendingCount: number, me: string): Stat[] {
    const open: Stat = { Icon: AlertTriangle, label: 'Open shifts', value: openCount, sub: openCount ? 'need someone' : 'all covered', alert: openCount > 0 };
    if (!manage) {
        const mine = work.filter(s => s.employeeId === me);
        return [
            { Icon: CalendarClock, label: 'Your shifts', value: mine.length, sub: 'this week' },
            { Icon: Users, label: 'Your hours', value: hoursText(mine.reduce((a, s) => a + paidMin(s), 0)), sub: 'paid, this week' },
            open,
            { Icon: Leaf, label: 'Your requests', value: pendingCount, sub: 'waiting' },
        ];
    }
    const staffed = work.filter(s => s.employeeId);
    return [
        { Icon: Users, label: 'Staff scheduled', value: new Set(staffed.map(s => s.employeeId)).size, sub: `of ${data?.people.length ?? 0} · ${hoursText(staffed.reduce((a, s) => a + paidMin(s), 0))} h paid` },
        { Icon: StoreIcon, label: 'Stores', value: data?.stores.length ?? 0, sub: data?.stores.map(s => s.name).slice(0, 3).join(', ') || 'none yet' },
        open,
        { Icon: Leaf, label: 'Pending leave', value: pendingCount, sub: pendingCount === 1 ? 'request' : 'requests' },
    ];
}

/** Managers: the week's status (phones, where the badge is hidden) or what the page is for. Everyone else: when it was published. */
function rosterSubtitle(manage: boolean, isPhone: boolean, status: WeekStatus, needCover: number, published: WeekInfo | undefined): string {
    if (manage) {
        // Phones hide the status badge, so the subtitle carries it there.
        const cover = needCover ? needCover + ' to cover' : 'all covered';
        return isPhone ? `${STATUS_TEXT[status]} · ${cover}` : 'Plan shifts and keep every store covered';
    }
    if (!published?.publishedAt) return 'This week isn’t published yet';
    const by = published.publishedByName ? ' by ' + published.publishedByName : '';
    return `Published ${new Date(published.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${by}`;
}

/** The month shown by the Month view: today's when this week holds today, else the one holding the week's Thursday. */
function monthOfWeek(weekStart: string): string {
    const today = todayIso();
    return inWeek({ date: today }, weekStart) ? today : addDays(weekStart, 3);
}

/** "28 Sep – 4 Oct 2026", or on the Month view "October 2026". */
function navLabel(view: View, weekStart: string): string {
    if (view !== 'month') return rangeLabel(weekStart);
    return new Date(`${monthOfWeek(weekStart)}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** A week in the month `by` months from the one `weekStart` shows (its middle, so the Month view lands on that month). */
function shiftMonthOfWeek(weekStart: string, by: number): string {
    const mid = new Date(Date.parse(`${monthOfWeek(weekStart)}T00:00:00Z`));
    return mondayOf(new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth() + by, 15)).toISOString().slice(0, 10));
}

/** The view tabs, and moving through weeks (or months). */
const RosterNav: React.FC<{ view: View; tabs: [View, string][]; weekStart: string; onView: (v: View) => void; onMove: (by: number) => void; onToday: () => void }> = ({ view, tabs: TABS, weekStart, onView, onMove, onToday }) => (
    <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 p-1 rounded-full neu-inset overflow-x-auto no-scrollbar max-w-full" role="tablist" aria-label="View">
            {TABS.map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => onView(k)}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold whitespace-nowrap ${view === k ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                    {label}
                </button>
            ))}
        </div>
        {view !== 'requests' && (
            <div className="flex items-center gap-1 ml-auto max-sm:w-full">
                <button type="button" onClick={() => onMove(-1)} aria-label={view === 'month' ? 'Previous month' : 'Previous week'} className="neu-icon-btn-sm active-scale"><ChevronLeft size={15} /></button>
                <span className="min-w-0 flex-1 sm:flex-none sm:w-[11.5rem] truncate text-center text-[13px] font-semibold tabular-nums text-[var(--neu-text)]" aria-live="polite">{navLabel(view, weekStart)}</span>
                <button type="button" onClick={() => onMove(1)} aria-label={view === 'month' ? 'Next month' : 'Next week'} className="neu-icon-btn-sm active-scale"><ChevronRight size={15} /></button>
                <button type="button" onClick={onToday} className="neu-pill shrink-0 ml-1">Today</button>
            </div>
        )}
    </div>
);

/** "Add shift": labelled where there's room, the round + on phones (as Sales' "Record sale"). */
const AddShiftButton: React.FC<{ phone: boolean; onClick: () => void }> = ({ phone, onClick }) => (
    phone
        ? <PrimaryIconButton onClick={onClick} label="Add shift" icon={<Plus size={16} />} />
        : <Button variant="primary" onClick={onClick} icon={<Plus size={15} />}>Add shift</Button>
);

/** A header action: labelled where there's room, an icon on phones. */
const HeaderAction: React.FC<{ phone: boolean; label: string; short: string; icon: React.ReactNode; onClick: () => void }> = ({ phone, label, short, icon, onClick }) => (
    phone
        ? <GhostIconButton onClick={onClick} label={label} icon={icon} />
        : <Button onClick={onClick} icon={icon} aria-label={label}>{short}</Button>
);

/** The week's figures in one strip: two to a row on phones, four across on wide screens. */
const RosterStats: React.FC<{ stats: Stat[] }> = ({ stats }) => <StatStrip label="This week" stats={stats} />;

const FILTER_SELECT = '!w-auto !h-10 !py-0 !pr-8 !rounded-full !text-[13px]';

/** Store, role and name filters, and (on the week) the week / day layout. */
const RosterFilters: React.FC<{
    view: View; filters: Filters; stores: { id: string; name: string }[]; titles: string[]; layout: 'grid' | 'day';
    onFilters: (patch: Partial<Filters>) => void; onLayout: (l: 'grid' | 'day') => void;
}> = ({ view, filters, stores, titles, layout, onFilters, onLayout }) => (
    <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="sr-store">Store</label>
        <Select id="sr-store" value={filters.storeId} onChange={e => onFilters({ storeId: e.target.value })} className={`${FILTER_SELECT} flex-1 sm:flex-none min-w-0 sm:min-w-[9rem]`}>
            <option value="all">All stores</option>
            {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <label className="sr-only" htmlFor="sr-title">Role</label>
        <Select id="sr-title" value={filters.title} onChange={e => onFilters({ title: e.target.value })} className={`${FILTER_SELECT} flex-1 sm:flex-none min-w-0 sm:min-w-[9rem]`}>
            <option value="all">All roles</option>
            {titles.map(t => <option key={t} value={t}>{t}</option>)}
        </Select>
        {/* Phones: the two lists share a row, search and the layout the next. */}
        <div className="basis-full h-0 sm:hidden" aria-hidden="true" />
        <SearchBar value={filters.q} onChange={q => onFilters({ q })} placeholder="Search people" className="flex-[1_1_12rem] sm:max-w-xs" />
        {view === 'week' && (
            <fieldset className="flex gap-0.5 p-1 rounded-full neu-inset ml-auto shrink-0" aria-label="Week layout">
                {(['grid', 'day'] as const).map(k => (
                    <button key={k} type="button" aria-pressed={layout === k} onClick={() => onLayout(k)}
                        className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${layout === k ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                        {k === 'grid' ? 'Week' : 'Day'}
                    </button>
                ))}
            </fieldset>
        )}
    </div>
);

/** The store colours and marks, whether every shift is covered, and the publishing notice switch. */
const RosterLegend: React.FC<{
    stores: { id: string; name: string }[]; storeClass: (id: string) => string; needCover: number; manage: boolean; status: WeekStatus;
    notify: boolean; onNotify: (v: boolean) => void; onReviewOpen: () => void;
}> = ({ stores, storeClass, needCover, manage, status, notify, onNotify, onReviewOpen }) => (
    <div className="neu-card p-3.5 flex flex-wrap items-center gap-x-5 gap-y-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[var(--neu-text-dim)]" aria-label="Legend">
            {stores.map(s => (
                <span key={s.id} className="inline-flex items-center gap-1.5"><i className={`w-5 h-3.5 rounded border ${storeClass(s.id)}`} aria-hidden="true" />{s.name}</span>
            ))}
            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-leave" aria-hidden="true" />Approved leave</span>
            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-pending" aria-hidden="true" />Leave requested</span>
            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-off" aria-hidden="true" />Day off</span>
            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border-[1.5px] sr-open" aria-hidden="true" />Open shift</span>
        </div>
        <div className="flex items-center gap-2">
            <strong className={needCover ? 'sr-open-text' : 'text-green-700 dark:text-green-400'}>
                {needCover ? coverNote(needCover) : 'Every shift is covered'}
            </strong>
            {manage && needCover > 0 && <button type="button" onClick={onReviewOpen} className="text-[11px] font-semibold uppercase tracking-wider text-gold-700 dark:text-gold-300 active-scale">Review open shifts</button>}
        </div>
        {manage && (
            <span className="inline-flex items-center gap-2 text-[var(--neu-text-dim)]"><Toggle checked={notify} onChange={() => onNotify(!notify)} label="Notify staff when publishing" />Notify staff when publishing</span>
        )}
        <p className="basis-full text-[11.5px] text-[var(--neu-text-dim)]">
            {manage ? <>Status: <strong className="text-[var(--neu-text)]">{STATUS_TEXT[status]}</strong>. </> : null}
            Hours are paid hours: shift length minus the unpaid break (60 min on shifts of 6 hours or more, else 30 min, unless changed). Weeks over 48 paid hours are marked.
        </p>
    </div>
);

/** Managers: fill a week fast from last week's plan (import and export are in the header). */
const PlanToolbar: React.FC<{ onCopy: () => void }> = ({ onCopy }) => (
    <fieldset className="flex flex-wrap items-center gap-2" aria-label="Plan faster">
        <Button onClick={onCopy} icon={<CopyPlus size={15} />}>Copy last week</Button>
        <p className="hidden lg:block ml-auto text-[11.5px] text-[var(--neu-text-dim)]">Tip: drag a shift to another person or day to move it; hold Ctrl to copy.</p>
    </fieldset>
);

type Common = Parameters<typeof WeekGrid>[0];

/** The roster in the chosen view. */
const RosterBody: React.FC<{
    view: View; layout: 'grid' | 'day'; isPhone: boolean; common: Common; dayIdx: number; weekStart: string;
    onDay: (i: number) => void; onOpenDay: (i: number) => void; onPickDay: (date: string) => void; onChanged: () => void; onReview: () => void;
}> = ({ view, layout, isPhone, common, dayIdx, weekStart, onDay, onOpenDay, onPickDay, onChanged, onReview }) => {
    const { data, d, filters, onEdit, onNew } = common;
    if (view === 'month') return <MonthView data={data} d={d} monthOf={monthOfWeek(weekStart)} filters={filters} onPickDay={onPickDay} />;
    if (view === 'store') return <ByStoreView data={data} d={d} weekStart={weekStart} filters={filters} onEdit={onEdit} onNew={onNew} />;
    if (view === 'requests') return <RequestsView data={data} d={d} onChanged={onChanged} onReview={onReview} />;
    if (layout === 'day') return <DayAgenda {...common} dayIdx={dayIdx} onDay={onDay} />;
    return isPhone ? <PhoneWeek {...common} onOpenDay={onOpenDay} /> : <WeekGrid {...common} />;
};

const coverNote = (n: number): string => (n > 1 ? `${n} shifts need coverage` : `${n} shift needs coverage`);

/**
 * First and last day to load: the week, or the whole month grid around it.
 * Requests: four weeks before the week to five after (the server's 62-day
 * limit), so its decided leave doesn't depend on the tab shown before.
 */
function rangeFor(view: View, weekStart: string): [string, string] {
    if (view === 'requests') return [addDays(weekStart, -28), addDays(weekStart, 34)];
    if (view !== 'month') return [weekStart, addDays(weekStart, 6)];
    const mid = new Date(Date.parse(`${monthOfWeek(weekStart)}T00:00:00Z`));
    const first = new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(mid.getUTCFullYear(), mid.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    return [mondayOf(first), addDays(mondayOf(last), 6)];
}

/**
 * The staff roster: who works where and when, week by week, at the stores set
 * up under Attendance. Managers (the Staff roster "Manage" permission) plan
 * shifts and days off, decide on leave and publish each week; everyone else
 * sees the published weeks and can ask for leave.
 */
const rosterTabs = (pending: number): [View, string][] => [
    ['week', 'Week'], ['month', 'Month'], ['store', 'By store'], ['requests', pending ? `Requests (${pending})` : 'Requests'],
];

/** What the week views get: managers edit and add, and on a desktop also drag shifts about. */
function weekViewProps(
    base: Pick<Common, 'data' | 'd' | 'dates' | 'filters'>, manage: boolean, isPhone: boolean,
    actions: { edit: (s: StaffShift) => void; newShift: (employeeId: string | null, date: string) => void; moveShift: (s: StaffShift, e: string | null, date: string, copy: boolean) => Promise<void> },
): Common {
    if (!manage) return base;
    const onMove = isPhone ? undefined : (s: StaffShift, e: string | null, date: string, copy: boolean) => { void actions.moveShift(s, e, date, copy); };
    return { ...base, onEdit: actions.edit, onNew: actions.newShift, onMove };
}

/** Where "Add shift" puts a new one: the day shown, else today if it's in the week, else the week's Monday. */
function addDate(shownDay: string | null, weekStart: string): string {
    if (shownDay) return shownDay;
    const today = todayIso();
    return inWeek({ date: today }, weekStart) ? today : weekStart;
}

/** The week's shifts as CSV, with the filters applied. */
function weekCsv(data: StaffRosterData, d: Derived, week: StaffShift[], filters: Filters): string {
    const people = new Set(data.people.filter(p => matchesPerson(p, filters)).map(p => p.id));
    const shown = (s: StaffShift) => (s.employeeId ? people.has(s.employeeId) : filters.title === 'all' || s.role === filters.title);
    return rosterCsv(d, week.filter(s => matchesStore(s, filters) && shown(s)));
}

/** The roster for a date range, kept fresh: on a schedule change, and on coming back to the tab after 30 s. */
function useRosterData(from: string, to: string) {
    const [data, setData] = useState<StaffRosterData | null>(null);
    const [error, setError] = useState<string | null>(null);
    // The range the shown data was loaded for, and the one asked for last:
    // a slower answer for a range left behind is dropped.
    const [loadedKey, setLoadedKey] = useState('');
    const wantedKey = useRef(`${from}|${to}`);
    wantedKey.current = `${from}|${to}`;
    const loadedAt = useRef(0);
    const load = useCallback(async () => {
        const key = `${from}|${to}`;
        try {
            const next = await staffRosterService.load(from, to);
            if (wantedKey.current !== key) return;
            setData(next);
            setLoadedKey(key);
            setError(null);
            loadedAt.current = Date.now();
        } catch (e) {
            if (wantedKey.current !== key) return;
            const err = e as Error & { code?: string };
            setError(err.code === 'module_off' ? 'The staff roster isn’t part of this workspace’s plan.' : err.message || 'Could not load the roster');
        }
    }, [from, to]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => {
        const unsubscribe = realtimeService.subscribe(event => {
            if (event.type === 'invalidate' && event.events.some(e => e.entity === 'schedule') && document.visibilityState === 'visible') void load();
        });
        const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > 30_000) void load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { unsubscribe(); document.removeEventListener('visibilitychange', onVisible); };
    }, [load]);
    return { data, error, loadedKey, load };
}

/** A shift dragged to someone else or another day (null: unassigned); `copy` keeps the original. */
async function moveShiftTo(data: StaffRosterData | null, s: StaffShift, employeeId: string | null, date: string, copy: boolean): Promise<void> {
    if (s.kind === 'off' && !employeeId) { toast.error('A day off needs a person.'); return; }
    const who = employeeId ? (data?.people.find(p => p.id === employeeId)?.name.split(' ')[0] ?? 'them') : 'open shifts';
    const { id: _id, ...fields } = s;
    try {
        if (copy) await staffRosterService.createShifts([{ ...fields, employeeId, date }]);
        else await staffRosterService.updateShift(s.id, { ...fields, employeeId, date });
        const day = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
        toast.success(`${copy ? 'Copied' : 'Moved'} to ${who}, ${day}`);
    } catch (e) {
        toast.error((e as Error).message || 'Could not move it');
    }
}

/** The week's shifts that count, and what needs a manager: open shifts, people on leave, requests. */
function coverCounts(data: StaffRosterData | null, d: Derived | null, week: StaffShift[], manage: boolean) {
    // Shifts of someone no longer on the team stay stored but don't count as staff.
    const team = new Set((data?.people ?? []).map(p => p.id));
    const work = week.filter(s => s.kind === 'shift' && (!s.employeeId || team.has(s.employeeId)));
    const openCount = work.filter(s => !s.employeeId).length;
    const leaveHits = d ? week.filter(s => (d.conflicts.get(s.id) ?? []).some(c => c.type === 'leave')).length : 0;
    const pendingCount = data ? data.leaves.filter(l => l.status === 'pending' && (manage || l.employeeId === data.me)).length : 0;
    return { work, openCount, needCover: openCount + leaveHits, pendingCount };
}

/** A new shift's starting values: 9 to 5, in the filtered store and title when there is one. */
function newShiftDraft(data: StaffRosterData, filters: Filters, employeeId: string | null, date: string, storeId?: string): Omit<StaffShift, 'id'> {
    const person = data.people.find(p => p.id === employeeId);
    const filteredStore = filters.storeId === 'all' ? null : filters.storeId;
    const filteredTitle = filters.title === 'all' ? null : filters.title;
    return {
        kind: 'shift', employeeId, storeId: storeId ?? filteredStore ?? data.stores[0]?.id ?? null, date,
        startMin: 540, endMin: 1020, breakMin: defaultBreakMin(540, 1020),
        role: person?.title || filteredTitle || data.jobTitles[0] || '', note: '',
    };
}

/** Whichever panel is open over the roster. */
const RosterOverlay: React.FC<{
    overlay: NonNullable<Overlay>; data: StaffRosterData; d: Derived; weekStart: string; notify: boolean; onNotify: (v: boolean) => void;
    onEdit: (s: StaffShift) => void; csv: () => string; onClose: () => void; onDone: () => void; onChanged: () => void;
}> = ({ overlay, data, d, weekStart, notify, onNotify, onEdit, csv, onClose, onDone, onChanged }) => {
    switch (overlay.kind) {
        case 'edit': return <ShiftEditor key={overlay.state.id ?? 'new'} data={data} d={d} start={overlay.state} onClose={onClose} onSaved={onDone} />;
        case 'open': return <OpenShiftsPanel data={data} d={d} weekStart={weekStart} onEdit={onEdit} onClose={onClose} onChanged={onChanged} />;
        case 'publish': return <PublishDialog data={data} d={d} weekStart={weekStart} notify={notify} onNotify={onNotify} onFix={onEdit} onClose={onClose} onPublished={onDone} />;
        case 'export': return <ExportPanel csv={csv()} weekStart={weekStart} onClose={onClose} />;
        case 'copy': return <CopyWeekPanel data={data} weekStart={weekStart} onClose={onClose} onDone={onDone} />;
        case 'import': return <ImportPanel data={data} onClose={onClose} onDone={onDone} />;
    }
};

export const StaffRosterView: React.FC = () => {
    const { can, navigate } = useAppChrome();
    const isPhone = useMediaQuery('(max-width: 767px)');
    const [weekStart, setWeekStart] = useState(() => mondayOf(todayIso()));
    const [view, setView] = useState<View>('week');
    const [layout, setLayout] = useState<'grid' | 'day'>('grid');
    const [dayIdx, setDayIdx] = useState(() => weekdayIdx(todayIso()));
    const [filters, setFilters] = useState<Filters>({ storeId: 'all', title: 'all', q: '' });
    const [overlay, setOverlay] = useState<Overlay>(null);
    const [notify, setNotify] = useState(() => { try { return localStorage.getItem(NOTIFY_KEY) !== '0'; } catch { return true; } });
    const chooseNotify = (v: boolean) => { setNotify(v); try { localStorage.setItem(NOTIFY_KEY, v ? '1' : '0'); } catch { /* private mode */ } };

    const [from, to] = rangeFor(view, weekStart);
    const rangeKey = `${from}|${to}`;
    const { data, error, loadedKey, load } = useRosterData(from, to);

    const d = useMemo(() => (data ? derive(data) : null), [data]);
    const dates = weekDates(weekStart);
    const manage = !!data?.canManage;
    const week = useMemo(() => (data ? data.shifts.filter(s => inWeek(s, weekStart)) : []), [data, weekStart]);
    const status = data?.weeks[weekStart]?.status ?? 'draft';
    const titles = useMemo(() => [...new Set((data?.people ?? []).map(p => p.title).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [data]);

    // ── Actions ──────────────────────────────────────────────────────────
    const done = () => { setOverlay(null); void load(); };
    const edit = (s: StaffShift) => setOverlay({ kind: 'edit', state: { id: s.id, draft: { ...s } } });
    const newShift = (employeeId: string | null, date: string, storeId?: string) => {
        if (data) setOverlay({ kind: 'edit', state: { id: null, draft: newShiftDraft(data, filters, employeeId, date, storeId) } });
    };
    const addAnywhere = () => newShift(null, addDate(layout === 'day' && view === 'week' ? dates[dayIdx] : null, weekStart));
    /** A shift dragged to someone else or another day (null: unassigned). Ctrl/Alt copies it. */
    const moveShift = async (s: StaffShift, employeeId: string | null, date: string, copy: boolean) => {
        await moveShiftTo(data, s, employeeId, date, copy);
        void load();
    };
    const moveWeek = (by: number) => setWeekStart(w => (view === 'month' ? shiftMonthOfWeek(w, by) : addDays(w, by * 7)));
    const goToday = () => { setWeekStart(mondayOf(todayIso())); setDayIdx(weekdayIdx(todayIso())); };

    // ── Summary ──────────────────────────────────────────────────────────
    const { work, openCount, needCover, pendingCount } = useMemo(() => coverCounts(data, d, week, manage), [data, d, week, manage]);

    const stats = summaryStats(manage, data, work, openCount, pendingCount, data?.me ?? '');

    const csv = () => (data && d ? weekCsv(data, d, week, filters) : '');

    // ── Layout ───────────────────────────────────────────────────────────
    const TABS = rosterTabs(pendingCount);
    // Nothing until the roster arrives: before then it isn't known whether the week is published.
    const subtitle = data ? rosterSubtitle(manage, isPhone, status, needCover, data.weeks[weekStart]) : '';

    const common = data && d ? weekViewProps({ data, d, dates, filters }, manage, isPhone, { edit, newShift, moveShift }) : null;
    const openDayView = (date: string) => { setWeekStart(mondayOf(date)); setDayIdx(weekdayIdx(date)); setView('week'); setLayout('day'); };
    let body: React.ReactNode = <div className="py-20 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    // Requests waits for its own range: another tab's data holds different leave.
    const shown = view !== 'requests' || loadedKey === rangeKey;
    if (error && (!data || !shown)) {
        body = <EmptyState icon={<CalendarClock size={22} strokeWidth={1.5} />} title="The roster didn’t load" message={error} action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (common && shown) {
        body = <RosterBody view={view} layout={layout} isPhone={isPhone} common={common} dayIdx={dayIdx} weekStart={weekStart}
            onDay={setDayIdx} onOpenDay={i => { setDayIdx(i); setLayout('day'); }} onPickDay={openDayView}
            onChanged={() => { void load(); }} onReview={() => { setView('week'); setOverlay({ kind: 'open' }); }} />;
    }

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Staff roster"
                subtitle={subtitle}
                actions={manage ? (
                    <>
                        <output className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold ${STATUS_CLS[status]}`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />{STATUS_TEXT[status]}
                        </output>
                        <HeaderAction phone={isPhone} label="Import roster" short="Import" onClick={() => setOverlay({ kind: 'import' })} icon={<FileUp size={15} className="text-brand-900 dark:text-gold-400" />} />
                        <HeaderAction phone={isPhone} label="Export this week" short="Export" onClick={() => setOverlay({ kind: 'export' })} icon={<Download size={15} className="text-brand-900 dark:text-gold-400" />} />
                        <GhostIconButton onClick={() => setOverlay({ kind: 'publish' })} label="Publish roster" icon={<Send size={15} className="text-brand-900 dark:text-gold-400" />} />
                        <AddShiftButton phone={isPhone} onClick={addAnywhere} />
                    </>
                ) : undefined}
            >
                <RosterNav view={view} tabs={TABS} weekStart={weekStart} onView={setView} onMove={moveWeek} onToday={goToday} />
            </PageHeader>

            <PageBody space="md" className="text-[var(--neu-text)]">
                {manage && data?.stores.length === 0 && (
                    <div className="neu-card p-4 flex flex-wrap items-center gap-3">
                        <StoreIcon size={18} className="text-[var(--neu-gold)]" />
                        <p className="flex-1 min-w-[12rem] text-[13px]">Add your stores first: shifts are planned per store. Stores are set up under Attendance → Stores.</p>
                        {can('attendance', 'edit') && <Button onClick={() => navigate('attendance')}>Open Attendance</Button>}
                    </div>
                )}

                {view !== 'requests' && <RosterStats stats={stats} />}

                {manage && data && (view === 'week' || view === 'store') && (
                    <PlanToolbar onCopy={() => setOverlay({ kind: 'copy' })} />
                )}

                {view !== 'requests' && view !== 'month' && (
                    <RosterFilters view={view} filters={filters} stores={data?.stores ?? []} titles={titles} layout={layout}
                        onFilters={patch => setFilters(f => ({ ...f, ...patch }))} onLayout={setLayout} />
                )}

                {body}

                {data && d && view !== 'requests' && (
                    <RosterLegend stores={data.stores} storeClass={d.storeClass} needCover={needCover} manage={manage} status={status}
                        notify={notify} onNotify={chooseNotify} onReviewOpen={() => setOverlay({ kind: 'open' })} />
                )}
            </PageBody>

            {data && d && overlay && (
                <RosterOverlay overlay={overlay} data={data} d={d} weekStart={weekStart} notify={notify} onNotify={chooseNotify}
                    onEdit={edit} csv={csv} onClose={() => setOverlay(null)} onDone={done} onChanged={() => { void load(); }} />
            )}
        </PageRoot>
    );
};
