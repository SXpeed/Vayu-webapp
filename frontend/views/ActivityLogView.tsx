import React, { useState, useEffect, useCallback } from 'react';
import { authService, ActivityLog } from '../services/authService';
import { SearchBar } from '../components/SearchBar';
import { PageRoot, PageHeader, PageBody, GhostIconButton } from '../components/ui';
import { RefreshCw, Plus, Pencil, Trash2, LogIn, LogOut, Send, Activity, History } from 'lucide-react';

interface ActivityLogViewProps {
    readonly onBack: () => void;
    /** Inside the Admin sheet: skip the page chrome (the sheet's header owns
     *  the title and back button) and render the toolbar inline. */
    readonly embedded?: boolean;
}

const formatTime = (ts: number): string =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Today" / "Yesterday" / "Mon, 14 Sep" — the heading for a day's group. */
const dayLabel = (ts: number): string => {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};

const getActionColor = (action: string): string => {
    const a = action.toLowerCase();
    if (a.includes('create') || a.includes('add')) return 'text-green-600 dark:text-green-400';
    if (a.includes('update') || a.includes('edit')) return 'text-blue-600 dark:text-blue-400';
    if (a.includes('delete') || a.includes('remove')) return 'text-red-600 dark:text-red-400';
    if (a.includes('login') || a.includes('logout') || a.includes('auth')) return 'text-purple-600 dark:text-purple-400';
    if (a.includes('send') || a.includes('message')) return 'text-cyan-600 dark:text-cyan-400';
    return 'text-gold-700 dark:text-gold-300';
};

const getActionIcon = (action: string): React.ElementType => {
    const a = action.toLowerCase();
    if (a.includes('create') || a.includes('add')) return Plus;
    if (a.includes('update') || a.includes('edit')) return Pencil;
    if (a.includes('delete') || a.includes('remove')) return Trash2;
    if (a.includes('login')) return LogIn;
    if (a.includes('logout')) return LogOut;
    if (a.includes('send') || a.includes('message')) return Send;
    return Activity;
};

export function ActivityLogView({ onBack, embedded = false }: ActivityLogViewProps) {
    const [logs, setLogs] = useState<ActivityLog[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [actionFilter, setActionFilter] = useState<string>('all');

    const loadLogs = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const data = await authService.getActivityLogs(200);
            setLogs(data);
        } catch (err) {
            console.error('Failed to load activity logs:', err);
            setError('Failed to load activity logs. Please try again.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadLogs();
    }, [loadLogs]);

    // Derive unique action types for the filter dropdown
    const actionTypes = Array.from(new Set(logs.map((l) => l.action))).sort((a, b) => a.localeCompare(b));

    const filteredLogs = logs.filter((log) => {
        const matchesSearch =
            searchQuery === '' ||
            log.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.entity.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
            log.action.toLowerCase().includes(searchQuery.toLowerCase());

        const matchesAction = actionFilter === 'all' || log.action === actionFilter;

        return matchesSearch && matchesAction;
    });

    // Logs arrive newest first, so consecutive runs of the same day form the groups.
    const groups: { day: string; logs: ActivityLog[] }[] = [];
    for (const log of filteredLogs) {
        const day = dayLabel(log.timestamp);
        const last = groups.at(-1);
        if (last?.day === day) last.logs.push(log);
        else groups.push({ day, logs: [log] });
    }

    const refreshButton = (
        <GhostIconButton onClick={loadLogs} label="Refresh" icon={<RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />} disabled={isLoading} />
    );

    // Search gets its own full row on phones; the filter (and refresh, when
    // embedded) share the next one instead of squeezing the field.
    const filters = (extra?: React.ReactNode) => (
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2">
            <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search activity…" className="w-full sm:w-auto sm:flex-1" />
            <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                aria-label="Filter by action"
                className="neu-field flex-1 sm:flex-none sm:w-auto text-xs py-2"
            >
                <option value="all" className="dark:bg-gray-800">All Actions</option>
                {actionTypes.map((action) => (
                    <option key={action} value={action} className="dark:bg-gray-800">
                        {action}
                    </option>
                ))}
            </select>
            {extra}
        </div>
    );

    let body: React.ReactNode;
    if (isLoading && logs.length === 0) {
        body = (
            <div className="flex flex-col items-center justify-center py-20 text-[var(--neu-text-dim)]">
                <div className="w-8 h-8 border-2 border-gold-500/30 border-t-gold-500 rounded-full animate-spin mb-4" />
                <p className="text-xs">Loading activity logs…</p>
            </div>
        );
    } else if (error) {
        body = (
            <div className="neu-card flex flex-col items-center justify-center py-12 px-6 text-center">
                <p className="text-red-600 dark:text-red-400 mb-4 text-sm">{error}</p>
                <button
                    onClick={loadLogs}
                    className="px-5 py-2.5 neu-raised-sm neu-btn text-gold-700 dark:text-gold-300 rounded-full text-xs font-medium uppercase tracking-wider active-scale"
                >
                    Retry
                </button>
            </div>
        );
    } else if (filteredLogs.length === 0) {
        body = (
            <div className="neu-card flex flex-col items-center justify-center py-12 px-6 text-center">
                <span className="w-14 h-14 rounded-full neu-inset mb-4 flex items-center justify-center text-[var(--neu-gold)]">
                    <History size={22} strokeWidth={1.5} />
                </span>
                <p className="text-xs text-[var(--neu-text-dim)]">
                    {logs.length === 0 ? 'No activity logged yet.' : 'No results match your search.'}
                </p>
            </div>
        );
    } else {
        body = (
            <div className="space-y-5 animate-fade-in">
                <p className="neu-label px-1">
                    Showing {filteredLogs.length} of {logs.length} {logs.length === 1 ? 'entry' : 'entries'}
                </p>
                {/* One card per day, rows divided inside it — a timeline, not a
                    stack of 200 separately extruded slabs. */}
                {groups.map(({ day, logs: dayLogs }) => (
                    <section key={day}>
                        <h3 className="neu-label px-1">{day}</h3>
                        <div className="neu-card px-1.5 py-1">
                            {dayLogs.map((log, index) => {
                                const Icon = getActionIcon(log.action);
                                const color = getActionColor(log.action);
                                return (
                                    <React.Fragment key={log.id}>
                                        {index > 0 && <div className="neu-divider mx-2.5" />}
                                        <div className="flex items-start gap-3 px-2.5 py-3">
                                            <span className={`w-9 h-9 rounded-full neu-inset flex items-center justify-center shrink-0 ${color}`}>
                                                <Icon size={15} strokeWidth={2} />
                                            </span>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-baseline justify-between gap-3">
                                                    <p className="text-[13px] leading-snug text-[var(--neu-text)] min-w-0">
                                                        <span className="font-semibold">{log.userName}</span>
                                                        {' '}<span className={`font-medium ${color}`}>{log.action}</span>
                                                        {' '}<span className="text-[11px] uppercase tracking-wider text-[var(--neu-text-dim)]">{log.entity}</span>
                                                    </p>
                                                    <span className="text-[11px] text-[var(--neu-text-dim)] tabular-nums shrink-0">{formatTime(log.timestamp)}</span>
                                                </div>
                                                {log.details && (
                                                    <p className="text-xs text-[var(--neu-text-dim)] mt-1 break-words leading-relaxed">{log.details}</p>
                                                )}
                                            </div>
                                        </div>
                                    </React.Fragment>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
        );
    }

    if (embedded) {
        return (
            <div className="max-w-4xl space-y-4">
                {filters(refreshButton)}
                {body}
            </div>
        );
    }

    return (
        <PageRoot width="narrow">
            <PageHeader title="Activity Logs" onBack={onBack} actions={refreshButton}>
                {filters()}
            </PageHeader>
            <PageBody space="none">
                {body}
            </PageBody>
        </PageRoot>
    );
}
