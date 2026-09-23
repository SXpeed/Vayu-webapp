// Building blocks for the control centre: routing, page headers, status
// pills, skeletons, empty states, slide-over drawers and promise-based
// dialogs (instead of the browser's own prompt/confirm).
//
// Everything here keeps layout stable: skeletons occupy the space the real
// content will, drawers and dialogs overlay rather than push content, and
// nothing uses fixed widths that could crop text.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, X } from 'lucide-react';

/* ─────────────────────────────── Routing ─────────────────────────────── */

/** `#/section/id/…` — so refresh, Back and shared links all work. */
export interface Route { section: string; id?: string; rest: string[] }

function parseHash(): Route {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    return { section: parts[0] || 'overview', id: parts[1], rest: parts.slice(2) };
}

export function useHashRoute(): [Route, (section: string, id?: string) => void] {
    const [route, setRoute] = useState<Route>(parseHash);
    useEffect(() => {
        const on = () => setRoute(parseHash());
        window.addEventListener('hashchange', on);
        return () => window.removeEventListener('hashchange', on);
    }, []);
    const go = useCallback((section: string, id?: string) => {
        const next = `#/${encodeURIComponent(section)}${id ? `/${encodeURIComponent(id)}` : ''}`;
        if (location.hash !== next) location.hash = next;
    }, []);
    return [route, go];
}

/* ───────────────────────────── Buttons ───────────────────────────────── */

/** The app's round 36px secondary action (GhostIconButton). */
export const IconButton: React.FC<{
    label: string; onClick?: () => void; children: React.ReactNode; disabled?: boolean; className?: string;
}> = ({ label, onClick, children, disabled = false, className = '' }) => (
    <button type="button" onClick={onClick} aria-label={label} title={label} disabled={disabled}
        className={`w-9 h-9 shrink-0 neu-raised-sm neu-btn rounded-full flex items-center justify-center active-scale text-gray-700 dark:text-gray-200 disabled:opacity-40 disabled:pointer-events-none ${className}`}>
        {children}
    </button>
);

/* ───────────────────────────── Page header ───────────────────────────── */

/**
 * The app's PageHeader: a gold serif title with a small-caps line under it,
 * and actions on the right. A back arrow sits before the title, the way the
 * app's detail pages do it.
 */
export const PageHeader: React.FC<{
    title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
    back?: { label: string; onClick: () => void }; meta?: React.ReactNode;
}> = ({ title, description, actions, back, meta }) => (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
            {back && (
                <IconButton label={back.label} onClick={back.onClick}>
                    <ArrowLeft size={17} className="text-brand-900 dark:text-gold-400" />
                </IconButton>
            )}
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="text-[1.35rem] md:text-2xl lg:text-[1.75rem] font-serif leading-tight tracking-wide text-gold-700 dark:text-gold-300 break-words">{title}</h1>
                    {meta}
                </div>
                {description && (
                    <p className="mt-1 text-[11px] uppercase tracking-[0.14em] font-light text-gray-600 dark:text-gray-400 break-words">{description}</p>
                )}
            </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
    </header>
);

/** A titled card: the app's Card with its small-caps SectionTitle. */
export const Section: React.FC<{
    title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
    children?: React.ReactNode; className?: string; flush?: boolean;
}> = ({ title, description, actions, children, className = '', flush = false }) => (
    <section className={`neu-card ${className}`}>
        {(title || actions) && (
            <header className="flex flex-wrap items-start justify-between gap-3 px-5 lg:px-6 pt-5 lg:pt-6 pb-3">
                {/* Takes the free width, so a small action (an icon) stays on the title row. */}
                <div className="min-w-0 flex-1 basis-[min(100%,16rem)]">
                    {title && <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">{title}</h2>}
                    {description && <p className="mt-1.5 text-[12px] font-light leading-relaxed text-gray-600 dark:text-gray-400">{description}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
            </header>
        )}
        <div className={flush ? '' : `px-5 lg:px-6 ${title || actions ? 'pb-5 lg:pb-6' : 'py-5 lg:py-6'}`}>{children}</div>
    </section>
);

/**
 * The app's dashboard StatTile: gold glyph, small-caps label, serif figure.
 * Fixed height and single lines, so the placeholder and the real tile are
 * the same size and nothing moves when data lands.
 */
export const StatTile: React.FC<{
    icon?: React.ReactNode; label: string; value: React.ReactNode; foot?: React.ReactNode;
    tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void;
    meter?: { share: number; tone: 'ok' | 'warn' | 'bad' };
}> = ({ icon, label, value, foot, tone, onClick, meter }) => {
    const ink = tone === 'bad' ? 'text-[var(--ac-bad)]' : tone === 'warn' ? 'text-[var(--ac-warn)]' : tone === 'ok' ? 'text-[var(--ac-ok)]' : 'text-gray-900 dark:text-white';
    const body = (
        <>
            <span className="flex items-center gap-2 min-w-0">
                {icon && <span className="shrink-0 text-gold-500">{icon}</span>}
                <span className="text-[11px] font-medium uppercase tracking-wider lg:tracking-widest text-gray-700 dark:text-gray-300 truncate">{label}</span>
            </span>
            <span className={`block mt-2 text-xl lg:text-2xl font-serif leading-8 tabular-nums truncate ${ink}`}>{value}</span>
            <span className="block mt-0.5 text-[11px] font-light leading-[18px] text-gray-600 dark:text-gray-400 truncate">{foot || ' '}</span>
            {meter && (
                <span className="ac-meter absolute left-3 right-3 bottom-2.5 lg:left-4 lg:right-4 lg:bottom-3" data-tone={meter.tone}>
                    <span style={{ transform: `scaleX(${meter.share})` }} />
                </span>
            )}
        </>
    );
    // flex-col + justify-start: a <button> would otherwise centre its content
    // vertically, so clickable and plain tiles would not line up.
    const cls = 'relative flex flex-col justify-start h-[118px] p-3 lg:p-4 min-w-0 overflow-hidden text-left';
    return onClick
        ? <button type="button" onClick={onClick} className={`neu-card-interactive cursor-pointer ${cls}`}>{body}</button>
        : <div className={`neu-card ${cls}`}>{body}</div>;
};

/** Height of a StatTile, for placeholders. */
export const STAT_TILE_H = 'h-[118px]';

/* ───────────────────────────── Status pills ──────────────────────────── */

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral';

const TONES: Record<string, Tone> = {
    active: 'ok', approved: 'ok', published: 'ok', verified: 'ok', sent: 'ok', provisioned: 'ok', trialing: 'info',
    pending_review: 'warn', needs_information: 'info', payment_required: 'warn', pending: 'warn', unverified: 'warn',
    provisioning: 'info', draft: 'neutral', retired: 'neutral', archived: 'neutral', withdrawn: 'neutral', cancelled: 'neutral', none: 'neutral',
    rejected: 'bad', suspended: 'bad', disabled: 'bad', failed: 'bad', provisioning_failed: 'bad', closed: 'bad',
    trial_expired: 'bad', past_due: 'bad', canceled: 'neutral',
};

const LABELS: Record<string, string> = {
    pending_review: 'To review', needs_information: 'Waiting on applicant', payment_required: 'Awaiting payment',
    provisioning: 'Setting up', provisioning_failed: 'Setup failed', trial_expired: 'Trial expired', past_due: 'Past due',
    trialing: 'Trial',
};

export const toneFor = (status: string): Tone => TONES[status] ?? 'neutral';
export const labelFor = (status: string): string => LABELS[status] ?? status.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

/** The app's status chip (neu-status): pressed in, coloured small caps. */
export const StatusPill: React.FC<{ status?: string; tone?: Tone; children?: React.ReactNode }> = ({ status, tone, children }) => (
    <span className="ac-status" data-tone={tone ?? (status ? toneFor(status) : 'neutral')}>{children ?? (status ? labelFor(status) : '')}</span>
);

/* ───────────────────────────── Loading ───────────────────────────────── */

export const Skeleton: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className = '', style }) => (
    <div className={`ac-skeleton ${className}`} style={style} aria-hidden />
);

/** Rows shaped like a list, so the real list replaces it without a jump. */
export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 5 }) => (
    <div className="space-y-3 py-1" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5" style={{ width: `${55 - (i % 3) * 10}%` }} />
                    <Skeleton className="h-3" style={{ width: `${35 - (i % 2) * 8}%` }} />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
            </div>
        ))}
    </div>
);

export const SkeletonCards: React.FC<{ count?: number; height?: number }> = ({ count = 4, height = 104 }) => (
    <div className="grid gap-4 lg:gap-5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]" aria-busy="true">
        {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="rounded-2xl" style={{ height }} />)}
    </div>
);

/** The app's empty state: an inset icon well and a serif line. */
export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode; compact?: boolean }> = ({ icon, title, body, action, compact = false }) => (
    <div className={`flex flex-col items-center text-center px-4 ${compact ? 'py-5' : 'py-10 lg:py-12'}`}>
        {icon && <div className="mb-3 w-12 h-12 rounded-full neu-inset flex items-center justify-center text-gray-600 dark:text-gray-300">{icon}</div>}
        <p className="text-sm lg:text-base font-serif text-gray-700 dark:text-gray-200">{title}</p>
        {body && <p className="mt-1.5 text-xs lg:text-sm font-light leading-relaxed text-gray-600 dark:text-gray-300 max-w-sm">{body}</p>}
        {action && <div className="mt-4">{action}</div>}
    </div>
);

/* ───────────────────────────── Controls ──────────────────────────────── */

/** The app's filter pills: raised at rest, pressed in and gold when chosen. */
export const Segmented: React.FC<{
    options: { value: string; label: React.ReactNode; count?: number }[]; value: string; onChange: (v: string) => void;
}> = ({ options, value, onChange }) => (
    <div role="tablist" className="flex flex-wrap gap-2">
        {options.map(o => (
            <button key={o.value} role="tab" type="button" aria-selected={value === o.value} onClick={() => onChange(o.value)}
                className={`neu-pill ${value === o.value ? 'neu-pill-active' : ''}`}>
                {o.label}
                {o.count !== undefined && o.count > 0 && <span className="text-[10px] opacity-70 tabular-nums">{o.count}</span>}
            </button>
        ))}
    </div>
);

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="ac-kbd">{children}</kbd>;

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';

/** A person's initials in a pressed circle; fixed size, so rows line up. */
export const Avatar: React.FC<{ name: string; size?: number }> = ({ name, size = 36 }) => (
    <span className="neu-inset rounded-full flex items-center justify-center font-serif text-gold-700 dark:text-gold-300 shrink-0"
        style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }} aria-hidden>{initials(name)}</span>
);

/** A labelled value in a detail view — the app's small-caps field label. */
export const Detail: React.FC<{ label: string; children?: React.ReactNode }> = ({ label, children }) => (
    <div className="min-w-0">
        <dt className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-gray-600 dark:text-gray-400">{label}</dt>
        <dd className="mt-1 text-sm break-words">{children === null || children === undefined || children === '' ? <span className="ac-faint">—</span> : children}</dd>
    </div>
);

/** "Chrome on Windows" from a user-agent string. */
export function device(ua: string | null): { label: string; phone: boolean } {
    if (!ua) return { label: 'Unknown device', phone: false };
    const phone = /iphone|android|mobile/i.test(ua);
    const os = /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /iphone|ipad/i.test(ua) ? 'iPhone / iPad' : /android/i.test(ua) ? 'Android' : /linux/i.test(ua) ? 'Linux' : 'Device';
    const browser = /edg\//i.test(ua) ? 'Edge' : /chrome\//i.test(ua) ? 'Chrome' : /safari\//i.test(ua) ? 'Safari' : /firefox\//i.test(ua) ? 'Firefox' : 'Browser';
    return { label: `${browser} on ${os}`, phone };
}

/* ─────────────────────────── Overlay plumbing ────────────────────────── */

function useEscape(active: boolean, onEscape: () => void) {
    useEffect(() => {
        if (!active) return;
        const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onEscape(); } };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [active, onEscape]);
}

/** Stops the page behind an overlay from scrolling — without a width jump. */
function useScrollLock(active: boolean) {
    useEffect(() => {
        if (!active) return;
        const { overflow } = document.body.style;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = overflow; };
    }, [active]);
}

/** Overlays render into the control-centre root so they share its theme. */
function portal(node: React.ReactNode) {
    const host = document.getElementById('ac-overlays') ?? document.body;
    return createPortal(node, host);
}

/* ───────────────────────────── Drawer ────────────────────────────────── */

export const Drawer: React.FC<{
    open: boolean; onClose: () => void; title?: React.ReactNode; subtitle?: React.ReactNode; meta?: React.ReactNode;
    width?: number; footer?: React.ReactNode; children?: React.ReactNode;
}> = ({ open, onClose, title, subtitle, meta, width = 640, footer, children }) => {
    useEscape(open, onClose);
    useScrollLock(open);
    const panel = useRef<HTMLDivElement>(null);
    useEffect(() => { if (open) panel.current?.focus(); }, [open]);
    if (!open) return null;
    return portal(
        <>
            <div className="ac-scrim neu-scrim" onClick={onClose} />
            <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className="ac-drawer neu-modal outline-none"
                style={{ ['--ac-drawer-width' as string]: `${width}px` }}>
                <header className="flex items-start gap-3 px-5 sm:px-6 py-4">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-serif text-xl leading-tight text-gold-700 dark:text-gold-300 break-words">{title}</h2>
                            {meta}
                        </div>
                        {subtitle && <p className="mt-1 text-[11px] uppercase tracking-[0.12em] font-light text-gray-600 dark:text-gray-400 break-words">{subtitle}</p>}
                    </div>
                    <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
                </header>
                <div className="flex-1 overflow-y-auto ac-no-scrollbar px-5 sm:px-6 py-5 space-y-5">{children}</div>
                {footer && <footer className="px-5 sm:px-6 py-3 flex flex-wrap items-center justify-end gap-2">{footer}</footer>}
            </div>
        </>,
    );
};

/* ───────────────────────────── Dialogs ───────────────────────────────── */

interface ConfirmOptions { title: string; body?: React.ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface PromptOptions extends ConfirmOptions {
    label?: string; placeholder?: string; defaultValue?: string; multiline?: boolean;
    minLength?: number; inputType?: string; hint?: string;
}
interface Dialogs {
    confirm: (o: ConfirmOptions) => Promise<boolean>;
    /** Resolves to the text, or null when cancelled. */
    prompt: (o: PromptOptions) => Promise<string | null>;
}

type Pending =
    | { kind: 'confirm'; o: ConfirmOptions; resolve: (v: boolean) => void }
    | { kind: 'prompt'; o: PromptOptions; resolve: (v: string | null) => void };

const DialogContext = createContext<Dialogs | null>(null);

export function useDialogs(): Dialogs {
    const ctx = useContext(DialogContext);
    if (!ctx) throw new Error('useDialogs must be used inside <DialogProvider>');
    return ctx;
}

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [pending, setPending] = useState<Pending | null>(null);
    const [value, setValue] = useState('');
    // The open dialog, readable from event handlers without re-creating them.
    const current = useRef<Pending | null>(null);
    const valueRef = useRef('');
    valueRef.current = value;

    const open = useCallback((p: Pending) => {
        current.current?.kind === 'confirm' ? current.current.resolve(false) : current.current?.resolve(null);
        current.current = p;
        setPending(p);
    }, []);
    const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>(resolve => open({ kind: 'confirm', o, resolve })), [open]);
    const prompt = useCallback((o: PromptOptions) => new Promise<string | null>(resolve => {
        setValue(o.defaultValue ?? '');
        open({ kind: 'prompt', o, resolve });
    }), [open]);

    const close = useCallback((ok: boolean) => {
        const p = current.current;
        if (!p) return;
        current.current = null;
        if (p.kind === 'confirm') p.resolve(ok);
        else p.resolve(ok ? valueRef.current.trim() : null);
        setPending(null);
    }, []);

    useEscape(!!pending, () => close(false));
    const tooShort = pending?.kind === 'prompt' && value.trim().length < (pending.o.minLength ?? 1);

    return (
        <DialogContext.Provider value={{ confirm, prompt }}>
            {children}
            {pending && portal(
                <>
                    <div className="ac-scrim ac-dialog-scrim neu-scrim" onClick={() => close(false)} />
                    <form role="alertdialog" aria-modal="true" className="ac-dialog neu-modal p-6"
                        onSubmit={e => { e.preventDefault(); if (!tooShort) close(true); }}>
                        <h2 className="text-lg font-serif text-gray-900 dark:text-gray-100">{pending.o.title}</h2>
                        {pending.o.body && <div className="mt-2 text-sm font-light leading-relaxed text-gray-700 dark:text-gray-300">{pending.o.body}</div>}
                        {pending.kind === 'prompt' && (
                            <div className="mt-4">
                                {pending.o.label && <label className="neu-label" htmlFor="ac-prompt">{pending.o.label}</label>}
                                {pending.o.multiline ? (
                                    <textarea id="ac-prompt" autoFocus rows={3} className="neu-field" value={value}
                                        placeholder={pending.o.placeholder} onChange={e => setValue(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !tooShort) close(true); }} />
                                ) : (
                                    <input id="ac-prompt" autoFocus type={pending.o.inputType ?? 'text'} className="neu-field" value={value}
                                        placeholder={pending.o.placeholder} onChange={e => setValue(e.target.value)} />
                                )}
                                {pending.o.hint && <p className="mt-1.5 text-[12px] ac-faint">{pending.o.hint}</p>}
                            </div>
                        )}
                        <div className="mt-6 flex flex-wrap justify-end gap-2.5">
                            <button type="button" className="neu-button" onClick={() => close(false)}>{pending.o.cancelLabel ?? 'Cancel'}</button>
                            <button type="submit" autoFocus={pending.kind === 'confirm'} disabled={tooShort}
                                className={`neu-button ${pending.o.danger ? 'neu-button-danger' : 'neu-button-primary'}`}>
                                {pending.o.confirmLabel ?? 'Continue'}
                            </button>
                        </div>
                    </form>
                </>,
            )}
        </DialogContext.Provider>
    );
};
