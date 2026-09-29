import React from 'react';

// One card of headline figures, shared by Sales and the staff roster: figures
// side by side on wide screens, two to a row on phones, with room for one
// extra block (Sales puts its payment-mode split there) and a footnote.

export interface Stat {
    label: string;
    value: React.ReactNode;
    /** A quiet line under the figure. */
    sub?: React.ReactNode;
    Icon?: React.ElementType;
    /** Shows the figure in the warning colour (an open shift, say). */
    alert?: boolean;
    /** Extra classes for the cell, e.g. to span the whole row on phones. */
    className?: string;
}

const StatCell: React.FC<{ stat: Stat }> = ({ stat }) => (
    <div className={`min-w-0 ${stat.className ?? ''}`}>
        <div className="flex items-center gap-1.5 h-4">
            {stat.Icon && <stat.Icon size={13} className="text-gold-500 shrink-0" aria-hidden="true" />}
            <span className="text-[10.5px] font-semibold uppercase tracking-widest text-gray-700 dark:text-gray-300 truncate">{stat.label}</span>
        </div>
        <p className={`mt-1 text-xl lg:text-[1.625rem] leading-tight font-serif tabular-nums truncate ${stat.alert ? 'sr-bad-text' : 'text-gray-900 dark:text-white'}`}>{stat.value}</p>
        {stat.sub != null && stat.sub !== '' && <p className="mt-0.5 text-[11.5px] text-[var(--neu-text-dim)] truncate">{stat.sub}</p>}
    </div>
);

export const StatStrip: React.FC<{
    stats: Stat[];
    /** Grid columns per screen size; the default fits four figures. */
    cols?: string;
    label: string;
    children?: React.ReactNode;
    footer?: React.ReactNode;
}> = ({ stats, cols = 'grid-cols-2 lg:grid-cols-4', label, children, footer }) => (
    <section className="neu-card px-4 py-3.5 lg:px-5 lg:py-4" aria-label={label}>
        <div className={`grid ${cols} gap-x-5 gap-y-4`}>
            {stats.map(s => <StatCell key={s.label} stat={s} />)}
            {children}
        </div>
        {footer && <div className="mt-3 pt-2.5 border-t border-[var(--neu-line)] text-[11.5px] text-[var(--neu-text-dim)]">{footer}</div>}
    </section>
);
