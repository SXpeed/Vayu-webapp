// Loading placeholders in the shape of what is coming, so the real content
// replaces them without a jump (index.css .neu-skeleton). Every screen that
// waits on the network shows one of these instead of a spinner.

import React from 'react';

export const Skeleton: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
    <div className={`neu-skeleton ${className}`} style={style} aria-hidden="true" />
);

/** Wraps a skeleton so assistive technology hears "Loading" once. */
export const SkeletonBlock: React.FC<{ label?: string; className?: string; children: React.ReactNode }> = ({ label = 'Loading', className = '', children }) => (
    <div className={className} role="status" aria-busy="true" aria-label={label}>{children}</div>
);

/** A list: avatar, two lines of text, a pill on the right. */
export const SkeletonRows: React.FC<{ rows?: number; avatar?: boolean; className?: string }> = ({ rows = 5, avatar = true, className = '' }) => (
    <SkeletonBlock className={`space-y-4 ${className}`}>
        {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
                {avatar && <Skeleton className="h-9 w-9 !rounded-full shrink-0" />}
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5" style={{ width: `${62 - (i % 3) * 12}%` }} />
                    <Skeleton className="h-3" style={{ width: `${38 - (i % 2) * 10}%` }} />
                </div>
                <Skeleton className="h-6 w-16 !rounded-full shrink-0" />
            </div>
        ))}
    </SkeletonBlock>
);

/** A row of stat tiles, as StatStrip lays them out. */
export const SkeletonStats: React.FC<{ count?: number }> = ({ count = 4 }) => (
    <SkeletonBlock className="neu-card p-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: count }, (_, i) => (
            <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-6 w-12" />
                <Skeleton className="h-3 w-20" />
            </div>
        ))}
    </SkeletonBlock>
);

/** A table: a header line, then rows of cells. */
export const SkeletonTable: React.FC<{ rows?: number; cols?: number; className?: string }> = ({ rows = 6, cols = 5, className = '' }) => (
    <SkeletonBlock className={`neu-card p-4 space-y-3 ${className}`}>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className="h-3" style={{ width: `${70 - (i % 3) * 15}%` }} />)}
        </div>
        {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="grid gap-3 pt-3 border-t border-[var(--neu-line)]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className="h-4" style={{ width: `${85 - ((r + c) % 4) * 12}%` }} />)}
            </div>
        ))}
    </SkeletonBlock>
);

/** Cards in a responsive grid. */
export const SkeletonCards: React.FC<{ count?: number; height?: number }> = ({ count = 4, height = 110 }) => (
    <SkeletonBlock className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
        {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="!rounded-2xl" style={{ height }} />)}
    </SkeletonBlock>
);

/** A whole screen: title, a stat strip and a list. For lazily loaded screens. */
export const SkeletonPage: React.FC = () => (
    <div className="h-full px-5 md:px-8 lg:px-10 pt-6 space-y-5 max-w-6xl mx-auto w-full">
        <SkeletonBlock className="space-y-2.5">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-3 w-64" />
        </SkeletonBlock>
        <SkeletonStats />
        <div className="neu-card p-4"><SkeletonRows rows={6} /></div>
    </div>
);
