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

/* ───────────────────────────── Page header ───────────────────────────── */

export const PageHeader: React.FC<{
    title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
    back?: { label: string; onClick: () => void }; meta?: React.ReactNode;
}> = ({ title, description, actions, back, meta }) => (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
            {back && (
                <button type="button" onClick={back.onClick} className="mb-2 inline-flex items-center gap-1.5 text-[13px] ac-muted hover:text-[var(--ac-text)] transition-colors">
                    <ArrowLeft size={14} /> {back.label}
                </button>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="font-serif text-[1.65rem] leading-tight tracking-tight break-words">{title}</h1>
                {meta}
            </div>
            {description && <p className="mt-1 text-sm ac-muted max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
);

/** A titled surface. The padding is the same everywhere. */
export const Section: React.FC<{
    title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode;
    children?: React.ReactNode; className?: string; flush?: boolean;
}> = ({ title, description, actions, children, className = '', flush = false }) => (
    <section className={`neu-card ${className}`}>
        {(title || actions) && (
            <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
                {/* Takes the free width, so a small action (an icon) stays on the title row. */}
                <div className="min-w-0 flex-1 basis-[min(100%,16rem)]">
                    {title && <h2 className="text-[0.95rem] font-semibold">{title}</h2>}
                    {description && <p className="mt-0.5 text-[13px] ac-muted">{description}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
            </header>
        )}
        <div className={flush ? '' : `px-5 ${title || actions ? 'pb-5' : 'py-5'}`}>{children}</div>
    </section>
);

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

export const StatusPill: React.FC<{ status?: string; tone?: Tone; children?: React.ReactNode }> = ({ status, tone, children }) => (
    <span className="ac-tone" data-tone={tone ?? (status ? toneFor(status) : 'neutral')}>{children ?? (status ? labelFor(status) : '')}</span>
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
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]" aria-busy="true">
        {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="rounded-[14px]" style={{ height }} />)}
    </div>
);

export const EmptyState: React.FC<{ icon?: React.ReactNode; title: string; body?: string; action?: React.ReactNode; compact?: boolean }> = ({ icon, title, body, action, compact = false }) => (
    <div className={`flex flex-col items-center text-center px-4 ${compact ? 'py-4' : 'py-10'}`}>
        {icon && <div className="mb-3 w-11 h-11 rounded-2xl flex items-center justify-center bg-[var(--ac-accent-soft)] text-[var(--ac-accent)]">{icon}</div>}
        <p className="font-medium">{title}</p>
        {body && <p className="mt-1 text-[13px] ac-muted max-w-sm">{body}</p>}
        {action && <div className="mt-4">{action}</div>}
    </div>
);

/* ───────────────────────────── Controls ──────────────────────────────── */

export const Segmented: React.FC<{
    options: { value: string; label: React.ReactNode; count?: number }[]; value: string; onChange: (v: string) => void;
}> = ({ options, value, onChange }) => (
    <div role="tablist" className="ac-segmented">
        {options.map(o => (
            <button key={o.value} role="tab" type="button" aria-selected={value === o.value} onClick={() => onChange(o.value)}
                className={`neu-pill ${value === o.value ? 'neu-pill-active' : ''}`}>
                {o.label}
                {o.count !== undefined && o.count > 0 && <span className="text-[11px] ac-faint tabular-nums">{o.count}</span>}
            </button>
        ))}
    </div>
);

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="ac-kbd">{children}</kbd>;

/** A labelled key/value, used in detail views. */
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';

/** A person's initials in a pressed circle; fixed size, so rows line up. */
export const Avatar: React.FC<{ name: string; size?: number }> = ({ name, size = 36 }) => (
    <span className="neu-inset rounded-full flex items-center justify-center text-[12px] font-semibold text-[var(--ac-accent)] shrink-0"
        style={{ width: size, height: size }} aria-hidden>{initials(name)}</span>
);

export const Detail: React.FC<{ label: string; children?: React.ReactNode }> = ({ label, children }) => (
    <div className="min-w-0">
        <dt className="text-[12px] ac-muted">{label}</dt>
        <dd className="mt-0.5 text-sm break-words">{children === null || children === undefined || children === '' ? <span className="ac-faint">—</span> : children}</dd>
    </div>
);

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
            <div className="ac-scrim" onClick={onClose} />
            <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" className="ac-drawer outline-none"
                style={{ ['--ac-drawer-width' as string]: `${width}px` }}>
                <header className="flex items-start gap-3 px-5 sm:px-6 py-4">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-serif text-xl leading-tight break-words">{title}</h2>
                            {meta}
                        </div>
                        {subtitle && <p className="mt-0.5 text-[13px] ac-muted break-words">{subtitle}</p>}
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close" className="neu-button !h-9 !w-9 !p-0 shrink-0"><X size={16} /></button>
                </header>
                <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5 space-y-5">{children}</div>
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
                    <div className="ac-scrim ac-dialog-scrim" onClick={() => close(false)} />
                    <form role="alertdialog" aria-modal="true" className="ac-dialog p-5"
                        onSubmit={e => { e.preventDefault(); if (!tooShort) close(true); }}>
                        <h2 className="text-base font-semibold">{pending.o.title}</h2>
                        {pending.o.body && <div className="mt-1.5 text-sm ac-muted">{pending.o.body}</div>}
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
                        <div className="mt-5 flex justify-end gap-2">
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
