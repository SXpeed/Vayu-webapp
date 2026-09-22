import React from 'react';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';

export interface DeviceInfo {
    id?: string;
    label: string;
    createdAt: number;
    lastUsedAt: number;
    /** The device you're looking from (own list only). */
    current?: boolean;
}

/** Matches DEFAULT_MAX_DEVICES in deviceSessions.ts (server). */
export const DEFAULT_MAX_DEVICES = 2;

export function timeAgo(ts: number): string {
    if (!ts) return 'a while ago';
    const minutes = Math.round((Date.now() - ts) / 60_000);
    if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/** "2 of 2 devices", "1 device" (no limit) … */
export function deviceCountText(count: number, limit: number | null | undefined): string {
    if (limit) return `${count} of ${limit} ${limit === 1 ? 'device' : 'devices'}`;
    return `${count} ${count === 1 ? 'device' : 'devices'}`;
}

function DeviceIcon({ label }: { label: string }) {
    if (/iPad/.test(label)) return <Tablet size={15} />;
    if (/iPhone|Android/.test(label)) return <Smartphone size={15} />;
    return <Monitor size={15} />;
}

/** Devices someone is signed in on, most recently used first. With
 *  `onSignOut`, every device except the current one gets a Sign out button. */
export const DeviceList: React.FC<{
    devices?: DeviceInfo[];
    emptyText?: string;
    onSignOut?: (device: DeviceInfo) => void;
    busyId?: string | null;
}> = ({ devices, emptyText = 'No devices.', onSignOut, busyId }) => {
    if (!devices) return null;
    if (devices.length === 0) return <p className="text-[11px] text-[var(--neu-text-dim)]">{emptyText}</p>;
    return (
        <ul className="space-y-2">
            {devices.map((d, i) => (
                <li key={`${d.label}-${d.createdAt}-${i}`} className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full neu-inset flex items-center justify-center shrink-0 text-[var(--neu-text-dim)]">
                        <DeviceIcon label={d.label} />
                    </span>
                    <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-[var(--neu-text)] truncate">
                            {d.label}
                            {d.current && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-600 dark:text-green-400">This device</span>}
                        </span>
                        <span className="block text-[11px] text-[var(--neu-text-dim)]">
                            {d.current ? 'In use now' : `Last used ${timeAgo(d.lastUsedAt)}`}
                        </span>
                    </span>
                    {onSignOut && !d.current && d.id && (
                        <button
                            type="button"
                            onClick={() => onSignOut(d)}
                            disabled={busyId != null}
                            aria-label={`Sign out ${d.label}`}
                            className="neu-btn active-scale shrink-0 inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold text-red-600 dark:text-red-400 disabled:opacity-50"
                        >
                            <LogOut size={12} aria-hidden="true" />
                            {busyId === d.id ? 'Signing out…' : 'Sign out'}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
};
