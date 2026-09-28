import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle, CalendarClock, ChevronLeft, ChevronRight, Download, Leaf, Loader2, Plus, Send, Store as StoreIcon, Users,
} from 'lucide-react';
import { SearchBar } from '../components/SearchBar';
import { Button, EmptyState, GhostIconButton, PageBody, PageHeader, PageRoot, PrimaryIconButton, Select, Toggle } from '../components/ui';
import { useAppChrome } from '../components/Layout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { realtimeService } from '../services/realtimeService';
import { staffRosterService, type StaffRosterData } from '../services/staffRosterService';
import { addDays, defaultBreakMin, mondayOf, paidMin, weekDates, weekdayIdx, type StaffShift } from '../staffRosterRules';
import { DayAgenda, PhoneWeek, WeekGrid } from './staffRoster/WeekViews';
import { ByStoreView, MonthView, RequestsView } from './staffRoster/OtherViews';
import { ExportPanel, OpenShiftsPanel, PublishDialog, ShiftEditor, rosterCsv, type EditorState } from './staffRoster/Panels';
import { derive, hoursText, inWeek, matchesPerson, matchesStore, rangeLabel, todayIso, type Filters } from './staffRoster/shared';

type View = 'week' | 'month' | 'store' | 'requests';
type Overlay =
    | { kind: 'edit'; state: EditorState }
    | { kind: 'open' } | { kind: 'publish' } | { kind: 'export' } | null;

const NOTIFY_KEY = 'vayu.staffRoster.notify';
const STATUS_TEXT = { draft: 'Draft', published: 'Published', changed: 'Unpublished changes' } as const;
const STATUS_CLS = {
    draft: 'neu-inset text-[var(--neu-text-dim)]',
    published: 'neu-inset text-green-700 dark:text-green-400',
    changed: 'sr-warn-box',
} as const;

/** First and last day to load: the week, or the whole month grid around it. */
function rangeFor(view: View, weekStart: string): [string, string] {
    if (view !== 'month') return [weekStart, addDays(weekStart, 6)];
    const mid = new Date(Date.parse(`${addDays(weekStart, 3)}T00:00:00Z`));
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
export const StaffRosterView: React.FC = () => {
    const { can, navigate } = useAppChrome();
    const isPhone = useMediaQuery('(max-width: 767px)');
    const [weekStart, setWeekStart] = useState(() => mondayOf(todayIso()));
    const [view, setView] = useState<View>('week');
    const [layout, setLayout] = useState<'grid' | 'day'>('grid');
    const [dayIdx, setDayIdx] = useState(() => weekdayIdx(todayIso()));
    const [filters, setFilters] = useState<Filters>({ storeId: 'all', title: 'all', q: '' });
    const [data, setData] = useState<StaffRosterData | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [overlay, setOverlay] = useState<Overlay>(null);
    const [notify, setNotifyState] = useState(() => { try { return localStorage.getItem(NOTIFY_KEY) !== '0'; } catch { return true; } });
    const setNotify = (v: boolean) => { setNotifyState(v); try { localStorage.setItem(NOTIFY_KEY, v ? '1' : '0'); } catch { /* private mode */ } };

    const [from, to] = rangeFor(view, weekStart);
    const loadedAt = useRef(0);
    const load = useCallback(async () => {
        try {
            const next = await staffRosterService.load(from, to);
            setData(next);
            setError(null);
            loadedAt.current = Date.now();
        } catch (e) {
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

    const d = useMemo(() => (data ? derive(data) : null), [data]);
    const dates = weekDates(weekStart);
    const manage = !!data?.canManage;
    const week = useMemo(() => (data ? data.shifts.filter(s => inWeek(s, weekStart)) : []), [data, weekStart]);
    const status = data?.weeks[weekStart]?.status ?? 'draft';
    const titles = useMemo(() => [...new Set((data?.people ?? []).map(p => p.title).filter(Boolean))].sort(), [data]);

    // ── Actions ──────────────────────────────────────────────────────────
    const done = () => { setOverlay(null); void load(); };
    const edit = (s: StaffShift) => setOverlay({ kind: 'edit', state: { id: s.id, draft: { ...s } } });
    const newShift = (employeeId: string | null, date: string, storeId?: string) => {
        if (!data) return;
        const person = data.people.find(p => p.id === employeeId);
        const store = storeId ?? (filters.storeId !== 'all' ? filters.storeId : data.stores[0]?.id ?? null);
        setOverlay({
            kind: 'edit', state: {
                id: null,
                draft: {
                    kind: 'shift', employeeId, storeId: store, date, startMin: 540, endMin: 1020, breakMin: defaultBreakMin(540, 1020),
                    role: person?.title || (filters.title !== 'all' ? filters.title : data.jobTitles[0] ?? ''), note: '',
                },
            },
        });
    };
    const addAnywhere = () => {
        const today = todayIso();
        let date = weekStart;
        if (layout === 'day' && view === 'week') date = dates[dayIdx];
        else if (inWeek({ date: today }, weekStart)) date = today;
        newShift(null, date);
    };
    const moveWeek = (by: number) => setWeekStart(w => addDays(w, by * 7));
    const goToday = () => { setWeekStart(mondayOf(todayIso())); setDayIdx(weekdayIdx(todayIso())); };

    // ── Summary ──────────────────────────────────────────────────────────
    // Shifts of someone no longer on the team stay stored but don't count as staff.
    const team = useMemo(() => new Set((data?.people ?? []).map(p => p.id)), [data]);
    const work = week.filter(s => s.kind === 'shift' && (!s.employeeId || team.has(s.employeeId)));
    const openCount = work.filter(s => !s.employeeId).length;
    const leaveHits = data && d ? week.filter(s => (d.conflicts.get(s.id) ?? []).some(c => c.type === 'leave')).length : 0;
    const needCover = openCount + leaveHits;
    const needCoverLabel = () => (needCover ? `${needCover} to cover` : 'all covered');
    const pendingCount = data ? data.leaves.filter(l => l.status === 'pending' && (manage || l.employeeId === data.me)).length : 0;
    const myWork = work.filter(s => s.employeeId === data?.me);

    const tiles = manage ? [
        { Icon: Users, label: 'Staff scheduled', value: new Set(work.filter(s => s.employeeId).map(s => s.employeeId)).size, sub: `of ${data?.people.length ?? 0} · ${hoursText(work.filter(s => s.employeeId).reduce((a, s) => a + paidMin(s), 0))} h` },
        { Icon: StoreIcon, label: 'Stores', value: data?.stores.length ?? 0, sub: data?.stores.map(s => s.name).slice(0, 3).join(', ') || 'none yet' },
        { Icon: AlertTriangle, label: 'Open shifts', value: openCount, sub: openCount ? 'need someone' : 'all covered', alert: openCount > 0 },
        { Icon: Leaf, label: 'Pending leave', value: pendingCount, sub: pendingCount === 1 ? 'request' : 'requests' },
    ] : [
        { Icon: CalendarClock, label: 'Your shifts', value: myWork.length, sub: 'this week' },
        { Icon: Users, label: 'Your hours', value: hoursText(myWork.reduce((a, s) => a + paidMin(s), 0)), sub: 'paid' },
        { Icon: AlertTriangle, label: 'Open shifts', value: openCount, sub: openCount ? 'need someone' : 'all covered', alert: openCount > 0 },
        { Icon: Leaf, label: 'Your requests', value: pendingCount, sub: 'waiting' },
    ];

    const csv = () => {
        if (!data || !d) return '';
        const people = new Set(data.people.filter(p => matchesPerson(p, filters)).map(p => p.id));
        return rosterCsv(data, d, week.filter(s => matchesStore(s, filters) && (s.employeeId ? people.has(s.employeeId) : filters.title === 'all' || s.role === filters.title)));
    };

    // ── Layout ───────────────────────────────────────────────────────────
    const TABS: [View, string][] = [['week', 'Week'], ['month', 'Month'], ['store', 'By store'], ['requests', pendingCount ? `Requests (${pendingCount})` : 'Requests']];
    const publishedInfo = data?.weeks[weekStart];
    // Phones hide the status badge, so the subtitle carries it there.
    let subtitle = isPhone ? `${STATUS_TEXT[status]} · ${needCoverLabel()}` : 'Plan shifts and keep every store covered';
    if (!manage) {
        subtitle = publishedInfo?.publishedAt
            ? `Published ${new Date(publishedInfo.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${publishedInfo.publishedByName ? ` by ${publishedInfo.publishedByName}` : ''}`
            : 'This week isn’t published yet';
    }

    let body: React.ReactNode;
    if (error && !data) {
        body = <EmptyState icon={<CalendarClock size={22} strokeWidth={1.5} />} title="The roster didn’t load" message={error} action={<Button onClick={() => { void load(); }}>Try again</Button>} />;
    } else if (!data || !d) {
        body = <div className="py-20 flex justify-center text-[var(--neu-text-dim)]"><Loader2 size={22} className="animate-spin" /></div>;
    } else {
        const common = { data, d, dates, filters, onEdit: manage ? edit : undefined, onNew: manage ? newShift : undefined };
        if (view === 'week') {
            if (layout === 'day') body = <DayAgenda {...common} dayIdx={dayIdx} onDay={setDayIdx} />;
            else if (isPhone) body = <PhoneWeek {...common} onOpenDay={i => { setDayIdx(i); setLayout('day'); }} />;
            else body = <WeekGrid {...common} />;
        } else if (view === 'month') {
            body = <MonthView data={data} d={d} monthOf={addDays(weekStart, 3)} filters={filters} onPickDay={date => { setWeekStart(mondayOf(date)); setDayIdx(weekdayIdx(date)); setView('week'); setLayout('day'); }} />;
        } else if (view === 'store') {
            body = <ByStoreView data={data} d={d} weekStart={weekStart} filters={filters} onEdit={manage ? edit : undefined} onNew={manage ? newShift : undefined} />;
        } else {
            body = <RequestsView data={data} d={d} onChanged={() => { void load(); }} onReview={() => { setView('week'); setOverlay({ kind: 'open' }); }} />;
        }
    }

    return (
        <PageRoot width="wide">
            <PageHeader
                title="Staff roster"
                subtitle={subtitle}
                floatTools={false}
                actions={manage ? (
                    <>
                        <span className={`hidden sm:inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-semibold ${STATUS_CLS[status]}`} role="status">
                            <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />{STATUS_TEXT[status]}
                        </span>
                        <GhostIconButton onClick={() => setOverlay({ kind: 'export' })} label="Export this week" icon={<Download size={16} className="text-brand-900 dark:text-gold-400" />} />
                        <GhostIconButton onClick={() => setOverlay({ kind: 'publish' })} label="Publish roster" icon={<Send size={15} className="text-brand-900 dark:text-gold-400" />} />
                        <PrimaryIconButton onClick={addAnywhere} label="Add shift" icon={<Plus size={16} />} />
                    </>
                ) : undefined}
            >
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex gap-1 p-1 rounded-full neu-inset overflow-x-auto no-scrollbar max-w-full" role="tablist" aria-label="View">
                        {TABS.map(([k, label]) => (
                            <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
                                className={`shrink-0 rounded-full px-3.5 py-1.5 text-[12px] font-semibold whitespace-nowrap ${view === k ? 'neu-raised-sm text-gold-700 dark:text-gold-300' : 'text-[var(--neu-text-dim)]'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    {view !== 'requests' && (
                        <div className="flex items-center gap-1.5 ml-auto max-sm:w-full">
                            <button type="button" onClick={() => moveWeek(-1)} aria-label={view === 'month' ? 'Previous month' : 'Previous week'} className="neu-icon-btn-sm active-scale"><ChevronLeft size={15} /></button>
                            <span className="flex-1 sm:flex-none sm:min-w-[10.5rem] text-center text-[13px] font-semibold tabular-nums" aria-live="polite">{rangeLabel(weekStart)}</span>
                            <button type="button" onClick={() => moveWeek(1)} aria-label={view === 'month' ? 'Next month' : 'Next week'} className="neu-icon-btn-sm active-scale"><ChevronRight size={15} /></button>
                            <button type="button" onClick={goToday} className="neu-pill shrink-0">Today</button>
                        </div>
                    )}
                </div>
            </PageHeader>

            <PageBody space="lg">
                {manage && data && data.stores.length === 0 && (
                    <div className="neu-card p-4 flex flex-wrap items-center gap-3">
                        <StoreIcon size={18} className="text-[var(--neu-gold)]" />
                        <p className="flex-1 min-w-[12rem] text-[13px]">Add your stores first: shifts are planned per store. Stores are set up under Attendance → Stores.</p>
                        {can('attendance', 'edit') && <Button onClick={() => navigate('attendance')}>Open Attendance</Button>}
                    </div>
                )}

                {view !== 'requests' && (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                        {tiles.map(t => (
                            <div key={t.label} className="neu-card p-3 lg:p-4">
                                <div className="flex items-center gap-2 mb-1.5">
                                    <t.Icon size={14} className="text-gold-500 shrink-0" />
                                    <span className="text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300 truncate">{t.label}</span>
                                </div>
                                <p className={`text-xl lg:text-2xl font-serif tabular-nums ${'alert' in t && t.alert ? 'sr-bad-text' : 'text-gray-900 dark:text-white'}`}>
                                    {t.value}<span className="ml-1.5 font-sans text-[11.5px] text-[var(--neu-text-dim)]">{t.sub}</span>
                                </p>
                            </div>
                        ))}
                    </div>
                )}

                {view !== 'requests' && view !== 'month' && (
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="sr-only" htmlFor="sr-store">Store</label>
                        <Select id="sr-store" value={filters.storeId} onChange={e => setFilters(f => ({ ...f, storeId: e.target.value }))} className="!w-auto !rounded-full !py-2 flex-1 sm:flex-none min-w-[8rem]">
                            <option value="all">All stores</option>
                            {data?.stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                        <label className="sr-only" htmlFor="sr-title">Role</label>
                        <Select id="sr-title" value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} className="!w-auto !rounded-full !py-2 flex-1 sm:flex-none min-w-[8rem]">
                            <option value="all">All roles</option>
                            {titles.map(t => <option key={t} value={t}>{t}</option>)}
                        </Select>
                        <SearchBar value={filters.q} onChange={q => setFilters(f => ({ ...f, q }))} placeholder="Search people" className="flex-[1_1_12rem] sm:max-w-xs" />
                        {view === 'week' && (
                            <div className="flex gap-1 p-1 rounded-full neu-inset ml-auto" role="group" aria-label="Week layout">
                                {(['grid', 'day'] as const).map(k => (
                                    <button key={k} type="button" aria-pressed={layout === k} onClick={() => setLayout(k)}
                                        className={`rounded-full px-3 py-1 text-[12px] ${layout === k ? 'neu-raised-sm text-gold-700 dark:text-gold-300 font-semibold' : 'text-[var(--neu-text-dim)]'}`}>
                                        {k === 'grid' ? 'Week' : 'Day'}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {body}

                {data && view !== 'requests' && (
                    <div className="neu-card p-3.5 flex flex-wrap items-center gap-x-5 gap-y-3 text-[12px]">
                        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-[var(--neu-text-dim)]" aria-label="Legend">
                            {data.stores.map(s => (
                                <span key={s.id} className="inline-flex items-center gap-1.5"><i className={`w-5 h-3.5 rounded border ${d?.storeClass(s.id)}`} aria-hidden="true" />{s.name}</span>
                            ))}
                            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-leave" aria-hidden="true" />Approved leave</span>
                            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-pending" aria-hidden="true" />Leave requested</span>
                            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border sr-off" aria-hidden="true" />Day off</span>
                            <span className="inline-flex items-center gap-1.5"><i className="w-5 h-3.5 rounded border-[1.5px] sr-open" aria-hidden="true" />Open shift</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <strong className={needCover ? 'sr-open-text' : 'text-green-700 dark:text-green-400'}>
                                {needCover ? `${needCover} shift${needCover > 1 ? 's' : ''} need${needCover > 1 ? '' : 's'} coverage` : 'Every shift is covered'}
                            </strong>
                            {manage && needCover > 0 && <button type="button" onClick={() => setOverlay({ kind: 'open' })} className="text-[11px] font-semibold uppercase tracking-wider text-gold-700 dark:text-gold-300 active-scale">Review open shifts</button>}
                        </div>
                        {manage && (
                            <span className="inline-flex items-center gap-2 text-[var(--neu-text-dim)]"><Toggle checked={notify} onChange={() => setNotify(!notify)} label="Notify staff when publishing" />Notify staff when publishing</span>
                        )}
                        <p className="basis-full text-[11.5px] text-[var(--neu-text-dim)]">
                            {manage ? <>Status: <strong className="text-[var(--neu-text)]">{STATUS_TEXT[status]}</strong>. </> : null}
                            Hours are paid hours: shift length minus the unpaid break (60 min on shifts of 6 hours or more, else 30 min, unless changed). Weeks over 48 paid hours are marked.
                        </p>
                    </div>
                )}
            </PageBody>

            {data && d && overlay?.kind === 'edit' && (
                <ShiftEditor key={overlay.state.id ?? 'new'} data={data} d={d} start={overlay.state} onClose={() => setOverlay(null)} onSaved={done} />
            )}
            {data && d && overlay?.kind === 'open' && (
                <OpenShiftsPanel data={data} d={d} weekStart={weekStart} onEdit={edit} onClose={() => setOverlay(null)} onChanged={() => { void load(); }} />
            )}
            {data && d && overlay?.kind === 'publish' && (
                <PublishDialog data={data} d={d} weekStart={weekStart} notify={notify} onNotify={setNotify} onFix={edit} onClose={() => setOverlay(null)} onPublished={done} />
            )}
            {data && d && overlay?.kind === 'export' && <ExportPanel csv={csv()} weekStart={weekStart} onClose={() => setOverlay(null)} />}
        </PageRoot>
    );
};
