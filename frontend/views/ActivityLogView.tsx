import React, { useState, useEffect, useCallback } from 'react';
import { authService, ActivityLog } from '../services/authService';

interface ActivityLogViewProps {
    onBack: () => void;
}

export function ActivityLogView({ onBack }: ActivityLogViewProps) {
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
    const actionTypes = Array.from(new Set(logs.map((l) => l.action))).sort();

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

    const formatTimestamp = (ts: number): string => {
        const date = new Date(ts);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();

        const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short' });

        if (isToday) return `Today, ${time}`;
        return `${dateStr}, ${time}`;
    };

    const getActionColor = (action: string): string => {
        const a = action.toLowerCase();
        if (a.includes('create') || a.includes('add')) return 'text-green-600 dark:text-green-400';
        if (a.includes('update') || a.includes('edit')) return 'text-blue-600 dark:text-blue-400';
        if (a.includes('delete') || a.includes('remove')) return 'text-red-600 dark:text-red-400';
        if (a.includes('login') || a.includes('logout') || a.includes('auth')) return 'text-purple-600 dark:text-purple-400';
        if (a.includes('send') || a.includes('message')) return 'text-cyan-600 dark:text-cyan-400';
        return 'text-gold-600 dark:text-gold-400';
    };

    const getActionBgColor = (action: string): string => {
        const a = action.toLowerCase();
        if (a.includes('create') || a.includes('add')) return 'bg-green-50 dark:bg-green-900/20';
        if (a.includes('update') || a.includes('edit')) return 'bg-blue-50 dark:bg-blue-900/20';
        if (a.includes('delete') || a.includes('remove')) return 'bg-red-50 dark:bg-red-900/20';
        if (a.includes('login') || a.includes('logout') || a.includes('auth')) return 'bg-purple-50 dark:bg-purple-900/20';
        if (a.includes('send') || a.includes('message')) return 'bg-cyan-50 dark:bg-cyan-900/20';
        return 'bg-gold-300/20 dark:bg-gold-500/10';
    };

    const getActionIcon = (action: string): string => {
        const a = action.toLowerCase();
        if (a.includes('create') || a.includes('add')) return '＋';
        if (a.includes('update') || a.includes('edit')) return '✎';
        if (a.includes('delete') || a.includes('remove')) return '✕';
        if (a.includes('login')) return '→';
        if (a.includes('logout')) return '←';
        if (a.includes('send') || a.includes('message')) return '✉';
        return '•';
    };

    return (
        <div className="h-full flex flex-col bg-[#faf9f6] dark:bg-[#121212] transition-colors duration-500 animate-fade-in">
            {/* Header */}
            <div className="sticky top-0 z-10 bg-white dark:bg-[#1a1a1a] shadow-sm border-b border-gray-100 dark:border-gray-800">
                <div className="px-4 pb-3" style={{ paddingTop: 'calc(2rem + env(safe-area-inset-top, 0px))' }}>
                    <div className="flex items-center gap-3 mb-3">
                        <button
                            onClick={onBack}
                            className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0"
                            aria-label="Go back"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 12H5M12 19l-7-7 7-7" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-serif text-gray-900 dark:text-white flex-1">Activity Logs</h1>
                        <button
                            onClick={loadLogs}
                            disabled={isLoading}
                            className="w-9 h-9 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors active-scale shrink-0 disabled:opacity-30"
                            aria-label="Refresh"
                            title="Refresh"
                        >
                            <svg
                                className={isLoading ? 'animate-spin' : ''}
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M23 4v6h-6M1 20v-6h6" />
                                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
                            </svg>
                        </button>
                    </div>

                    {/* Search + Filter */}
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 dark:text-gray-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="11" cy="11" r="8" />
                                <path d="m21 21-4.3-4.3" />
                            </svg>
                            <input
                                type="text"
                                placeholder="Search activity…"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[7px] py-2 pl-9 pr-4 text-xs text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors"
                            />
                        </div>
                        <select
                            value={actionFilter}
                            onChange={(e) => setActionFilter(e.target.value)}
                            className="bg-gray-100 dark:bg-[#2a2a2a] border border-transparent dark:border-gray-700 rounded-[7px] px-3 py-2 text-xs text-gray-900 dark:text-white focus:outline-none focus:border-gold-500 dark:focus:border-gold-500 transition-colors cursor-pointer"
                        >
                            <option value="all" className="dark:bg-gray-800">All Actions</option>
                            {actionTypes.map((action) => (
                                <option key={action} value={action} className="dark:bg-gray-800">
                                    {action}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto no-scrollbar p-4 pb-24">
                {isLoading && logs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
                        <div className="w-8 h-8 border-2 border-gold-500/30 border-t-gold-500 rounded-full animate-spin mb-4" />
                        <p className="text-xs font-light">Loading activity logs…</p>
                    </div>
                ) : error ? (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <p className="text-red-500 dark:text-red-400 mb-4 text-sm">{error}</p>
                        <button
                            onClick={loadLogs}
                            className="px-5 py-2.5 bg-brand-900 dark:bg-gold-500 text-white dark:text-brand-950 rounded-[7px] text-xs font-medium uppercase tracking-wider hover:bg-brand-800 dark:hover:bg-gold-400 transition-colors active-scale shadow-md"
                        >
                            Retry
                        </button>
                    </div>
                ) : filteredLogs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-gray-500">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-4">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                        </svg>
                        <p className="text-xs font-light">
                            {logs.length === 0 ? 'No activity logged yet.' : 'No results match your search.'}
                        </p>
                    </div>
                ) : (
                    <>
                        <p className="text-[9px] text-gray-400 dark:text-gray-500 mb-3 uppercase tracking-widest font-medium px-1">
                            Showing {filteredLogs.length} of {logs.length} {logs.length === 1 ? 'entry' : 'entries'}
                        </p>
                        <div className="space-y-2">
                            {filteredLogs.map((log, index) => (
                                <div
                                    key={log.id}
                                    className="bg-white dark:bg-[#1e1e1e] border border-gray-100 dark:border-gray-800 rounded-[7px] p-3.5 shadow-sm animate-fade-in-up"
                                    style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
                                >
                                    <div className="flex items-start gap-3">
                                        {/* Action icon */}
                                        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm ${getActionBgColor(log.action)} ${getActionColor(log.action)}`}>
                                            {getActionIcon(log.action)}
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <span className={`font-medium text-xs ${getActionColor(log.action)}`}>
                                                    {log.action}
                                                </span>
                                                <span className="text-gray-300 dark:text-gray-600 text-[9px]">·</span>
                                                <span className="text-[9px] text-gray-500 dark:text-gray-400 uppercase tracking-wider">{log.entity}</span>
                                            </div>

                                            {/* Details line */}
                                            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 break-words leading-relaxed">
                                                <span className="text-gray-900 dark:text-gray-200 font-medium">{log.userName}</span>
                                                {log.details ? ` — ${log.details}` : ''}
                                            </p>

                                            {/* Timestamp */}
                                            <p className="text-[9px] text-gray-400 dark:text-gray-500 mt-1.5 uppercase tracking-wider">
                                                {formatTimestamp(log.timestamp)}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}