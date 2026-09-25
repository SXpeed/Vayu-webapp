import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { useMediaQuery } from '../hooks/useMediaQuery';

/* ------------------------------------------------------------------ */
/*  Neumorphic page primitives.                                        */
/*  Shared shell used by every view: PageRoot → PageHeader → PageBody  */
/*                                                                     */
/*  PageRoot owns the content width and shares it through context, so  */
/*  the header title and the body columns line up on wide screens      */
/*  instead of the header hugging the left edge.                       */
/* ------------------------------------------------------------------ */

export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

/** Reading-width caps. `narrow` is for forms, `wide` for dashboards. */
const WIDTH_CLS: Record<PageWidth, string> = {
    narrow: 'w-full max-w-3xl mx-auto',
    default: 'w-full max-w-6xl mx-auto',
    wide: 'w-full max-w-[1600px] mx-auto',
    full: 'w-full',
};

interface PageChrome {
    width: PageWidth;
    /** Phone: the small shell, where the header keeps its tools in reach by
     *  folding them away rather than stacking them under the title. */
    isPhone: boolean;
    /** Phone only: the header's tools are folded while the page is scrolled. */
    collapsed: boolean;
    /** Unfold them again — what the folded search bar's stand-in icon calls. */
    expand: () => void;
}

const PageChromeContext = createContext<PageChrome>({
    width: 'default', isPhone: false, collapsed: false, expand: () => { },
});

/** Set by a SearchBar sitting in the header's tools row, so the title row can
 *  carry the magnifier that stands in for it once the row folds away — and
 *  focus it again on tap. */
interface HeaderTools {
    registerSearch: (input: HTMLInputElement | null) => void;
}

const HeaderToolsContext = createContext<HeaderTools>({ registerSearch: () => { } });

/** For SearchBar: hands the page header its input. No header above (sheets,
 *  dialogs) means the default no-op, and nothing to stand in for. */
export const useHeaderTools = () => useContext(HeaderToolsContext);

/** Horizontal gutters — one rhythm for header and body so they align. Phone
 *  gets 20px (not 16px): the scroller clips overflow on both axes, and the
 *  card shadows (9px offset + 22px blur) visibly shear at 16px. */
const GUTTER = 'px-5 md:px-8 lg:px-10';

/** Phones — below Tailwind's `md`. Tablets and up keep the full header. */
const PHONE_QUERY = '(max-width: 767px)';

/**
 * Fold the header's tools (search bar, filter pills) away while the page is
 * scrolled down, restore them on scroll up or at the top — the usual iOS
 * pattern. The title row itself stays put, so the page never loses its name.
 * Phone-only: tablet/desktop never collapse, so this is a no-op there.
 *
 * Listens in the capture phase on the page root, so it hears whichever
 * element actually scrolls (PageBody, or a view's own scroller) without every
 * view wiring it up. Direction is judged on the distance travelled since the
 * last reversal, not per event: iOS fires a scroll per frame, so a slow drag
 * moves a pixel or two at a time and a single-event threshold either never
 * trips or trips on noise.
 *
 * A floating tools row (the phone default, see PageHeader) sits over the
 * scroller, so folding it never resizes anything and it can follow the finger
 * both ways at once. An in-flow row does resize the scroller, which risks the
 * classic feedback loop — folding makes the scroller taller, which can clamp
 * scrollTop and fire a scroll that would open it again — so that one gets a
 * lock that outlives the fold animation after each change.
 *
 * Returns `expand()`: the way back in from the folded search bar's stand-in
 * icon. It routes through the same internal flag as the scroll path, so the
 * next gesture can fold the row again instead of thinking it is still open.
 */
const useCollapseOnScroll = (
    rootRef: React.RefObject<HTMLDivElement | null>,
    enabled: boolean,
    setCollapsed: (value: boolean) => void,
): (() => void) => {
    const expandRef = useRef<() => void>(() => { });

    useEffect(() => {
        const root = rootRef.current;
        if (!root || !enabled) {
            expandRef.current = () => { };
            setCollapsed(false);
            return;
        }

        const lastTop = new WeakMap<Element, number>();
        let collapsed = false;
        let lockUntil = 0;
        // Signed distance scrolled since the direction last changed.
        let travel = 0;
        const tools = () => root.querySelector<HTMLElement>('[data-page-header-tools]');
        const set = (value: boolean) => {
            if (value === collapsed) return;
            collapsed = value;
            travel = 0;
            lockUntil = tools()?.dataset.floating === undefined ? performance.now() + 420 : 0;
            setCollapsed(value);
        };

        expandRef.current = () => set(false);

        const onScroll = (event: Event) => {
            const el = event.target;
            // The header's own pill rows scroll sideways — not page scroll.
            if (!(el instanceof HTMLElement) || el.closest('header')) return;
            const top = el.scrollTop;
            const delta = top - (lastTop.get(el) ?? top);
            lastTop.set(el, top);
            if (delta === 0) return; // horizontal scroll
            travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;

            if (top <= 8) { set(false); return; } // back at the top: always open
            if (performance.now() < lockUntil) return;
            // Typing: keep the header (and any Save/Cancel living in it) on
            // screen for as long as a field has focus.
            const active = document.activeElement;
            if (active instanceof HTMLElement && (active.isContentEditable
                || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))) return;

            const max = el.scrollHeight - el.clientHeight;
            const row = tools();
            const floating = row?.dataset.floating !== undefined;
            const toolsHeight = row && row.offsetHeight > 0
                ? row.offsetHeight + (Number.parseFloat(getComputedStyle(row).marginTop) || 0)
                : 0;
            // Floating: fold once the content has slid up under the row, so it
            // never leaves a blank band where it was. In flow: only fold when
            // the page can still scroll without the tools — folding them back
            // would un-scroll the page, clamp scrollTop to 0 and pop them
            // straight open again. Measured while they are still expanded,
            // i.e. exactly the space folding them gives back.
            const canFold = floating ? top > toolsHeight : top > 32 && max > toolsHeight + 24;
            if (travel > 12 && canFold) {
                set(true);
            } else if (travel < -16 && top < max - 4) {
                // Ignore iOS bounce-back at the bottom edge, which reads as an
                // upward scroll.
                set(false);
            }
        };

        root.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => root.removeEventListener('scroll', onScroll, { capture: true });
    }, [rootRef, enabled, setCollapsed]);

    return useCallback(() => expandRef.current(), []);
};

interface PageRootProps {
    children?: React.ReactNode;
    /** Content width cap shared by PageHeader and PageBody. Default 'default'. */
    width?: PageWidth;
    className?: string;
}

/** Full-height column that fills the <main> scroller in Layout. */
export const PageRoot: React.FC<PageRootProps> = ({ children, width = 'default', className = '' }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const isPhone = useMediaQuery(PHONE_QUERY);
    const [collapsed, setCollapsed] = useState(false);
    const expand = useCollapseOnScroll(rootRef, isPhone, setCollapsed);

    // The class resets `--page-tools-h` so a page nested inside another never
    // inherits the outer page's value; a floating tools row overrides it inline.
    return (
        <PageChromeContext.Provider value={{ width, isPhone, collapsed: isPhone && collapsed, expand }}>
            <div ref={rootRef} data-page-root className={`flex flex-col h-full min-h-0 w-full [--page-tools-h:0px] ${className}`}>
                {children}
            </div>
        </PageChromeContext.Provider>
    );
};

interface PageHeaderProps {
    title: string;
    /** Small line under the title — record counts, context, status. */
    subtitle?: string;
    /** Right-aligned action buttons (PrimaryIconButton / GhostIconButton / Button). */
    actions?: React.ReactNode;
    /** When set, shows a back button on the left. */
    onBack?: () => void;
    /** Stacked rows under the title (SearchBar, filter pills, …). Rendered
     *  in normal document flow with uniform vertical rhythm so nothing
     *  ever overlaps — no absolute positioning, no negative margins. */
    children?: React.ReactNode;
    /** Phone: float the tools over the top of the scroller (default) rather
     *  than stacking them in flow above it. Needs the scroller right under the
     *  header to pad by `--page-tools-h`, as PageBody does — turn it off for
     *  a page with anything else in between. */
    floatTools?: boolean;
    className?: string;
}

/**
 * The single page header for every view. It is the only place a page title
 * appears — the app shell deliberately has no second title bar.
 *
 * Phone: the title row — and so the page name — is always on screen; the tools
 * under it (search bar, filter pills) fold away as soon as the page is
 * scrolled, so a list gets its space back the moment the header stops being
 * read. A folded search bar doesn't just vanish: as the row closes, the field
 * fades and drifts up while the magnifier rises straight up out of the closing
 * row into the title line in its place — and tapping that magnifier brings the
 * field back, caret and all.
 * The tools float over the top of the scroller rather than sitting above it,
 * and the scroller is padded by their height, so at rest the page looks the
 * same — but folding is only a fade and a nudge (compositor work), never a
 * resize. Resizing the scroller mid-scroll re-laid out the page every frame
 * and slid the list up faster than the finger: the jerk this replaced.
 * Sitting permanently above the content, tools and all, this header used to
 * eat up to 27% of an iPhone screen.
 * Tablet/desktop: never folds — full size and width-matched to the body, so
 * the title sits over the content instead of off in the left margin.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
    title, subtitle, actions, onBack, children, floatTools = true, className = '',
}) => {
    const { width, isPhone, collapsed, expand } = useContext(PageChromeContext);
    const floating = isPhone && floatTools && !!children;

    // Publish the floating row's height on the page root for the scroller to
    // pad by. Before paint, so the first frame already has the list below the
    // row. The root is found through the DOM, not PageRoot's ref: on mount a
    // child's layout effect runs before its parent's ref is attached.
    const toolsRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const row = toolsRef.current;
        const root = row?.closest<HTMLElement>('[data-page-root]');
        if (!floating || !row || !root) return;
        const publish = () => root.style.setProperty('--page-tools-h', `${row.offsetHeight}px`);
        publish();
        const observer = new ResizeObserver(publish);
        observer.observe(row);
        return () => {
            observer.disconnect();
            root.style.removeProperty('--page-tools-h');
        };
    }, [floating]);

    // A SearchBar among the tools registers itself here. That is what earns the
    // title row its stand-in magnifier — a row with no field in it has nothing
    // to stand in for — and what the magnifier puts the caret back into.
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const [hasSearch, setHasSearch] = useState(false);
    const registerSearch = useCallback((input: HTMLInputElement | null) => {
        searchInputRef.current = input;
        setHasSearch(input !== null);
    }, []);
    const headerTools = useRef<HeaderTools>({ registerSearch }).current;

    const revealSearch = useCallback(() => {
        expand();
        // The field is `inert` while folded, so it can only take focus once
        // React has re-rendered the row open — hence the next frame.
        requestAnimationFrame(() => searchInputRef.current?.focus({ preventScroll: true }));
    }, [expand]);

    const showStandIn = isPhone && hasSearch;

    return (
        <header
            data-collapsed={collapsed || undefined}
            className={`shrink-0 w-full ${floating ? 'relative z-10' : ''} ${GUTTER} pt-[calc(0.375rem+var(--safe-top))] pb-2 md:pt-[calc(1.25rem+var(--safe-top))] md:pb-4 lg:pt-6 lg:pb-5 ${className}`}
        >
            <div className={WIDTH_CLS[width]}>
                {/* Title row — never folds. The phone keeps its title and
                    actions; only the tools underneath fold away. */}
                <div className="flex items-center justify-between gap-3 w-full">
                    <div className="flex items-center gap-3 min-w-0">
                        {onBack && (
                            <button
                                onClick={onBack}
                                aria-label="Go back"
                                className="w-9 h-9 shrink-0 neu-raised-sm neu-btn rounded-full flex items-center justify-center active-scale"
                            >
                                <ArrowLeft size={17} className="text-brand-900 dark:text-gold-400" />
                            </button>
                        )}
                        <div className="min-w-0">
                            <h2 className="text-[1.2rem] md:text-2xl lg:text-[1.75rem] font-serif leading-tight tracking-wide text-gold-700 dark:text-gold-300 truncate">
                                {title}
                            </h2>
                            {subtitle && (
                                <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-gray-600 dark:text-gray-400 font-light truncate">
                                    {subtitle}
                                </p>
                            )}
                        </div>
                    </div>
                    {(actions || showStandIn) && (
                        <div className="flex items-center gap-2.5 shrink-0">
                            {/* The folded search bar, reduced to its own icon and
                                shifted up onto the title line. Its slot is always
                                laid out — only faded out while the field is open —
                                so nothing on this line ever jumps: the magnifier
                                rises straight up out of the closing row and
                                settles into the slot as the row finishes closing.
                                The motion lives on this wrapper, not the button:
                                `.neu-btn`'s own unlayered `transition: box-shadow`
                                would otherwise win the cascade and snap the
                                opacity/scale/translate. */}
                            {showStandIn && (
                                <span
                                    aria-hidden={collapsed ? undefined : true}
                                    className={`grid transition-[opacity,scale,translate] duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${collapsed
                                        ? 'opacity-100 scale-100 translate-y-0 translate-x-0 delay-[120ms]'
                                        : 'opacity-0 scale-[0.72] translate-y-2.5 pointer-events-none duration-100'
                                        }`}
                                >
                                    <button
                                        type="button"
                                        onClick={revealSearch}
                                        aria-label="Search"
                                        tabIndex={collapsed ? undefined : -1}
                                        className="w-9 h-9 rounded-full neu-raised-sm neu-btn text-brand-900 dark:text-gold-400 flex items-center justify-center active-scale"
                                    >
                                        <Search size={17} />
                                    </button>
                                </span>
                            )}
                            {actions}
                        </div>
                    )}
                </div>

                {/* Search bar / filter pills in flow — tablet/desktop, where
                    nothing folds, and phone pages that opt out of floating.
                    On those the row is the only thing that folds. Three tracks run together so it reads as one motion: the
                    1fr→0fr grid row (animated margin included) takes the space
                    away over 360ms on an ease-out curve; the contents fade and
                    drift straight up towards the title line, shrinking a hair
                    as they go; and the magnifier that takes their place rises
                    out of the closing row and lands on the title line just as
                    the row finishes closing. On the way back the contents wait
                    100ms, so they don't pop into a half-open row. clip-path,
                    not overflow:hidden, does the clipping so the rows' raised
                    shadows survive — the negative inset is their headroom.
                    `inert` keeps the folded controls out of the tab order, and
                    the context is what a SearchBar in here registers itself
                    with. */}
                {/* Phone: the same row, floated. It hangs off the bottom of the
                    header over the scroller's top padding, on the page colour
                    with a short fade underneath that stands in for the
                    scroller's own edge fade — content slides up under it
                    until it folds. Folding is opacity and translate only. */}
                {children && floating && (
                    <HeaderToolsContext.Provider value={headerTools}>
                        <div
                            ref={toolsRef}
                            data-page-header-tools
                            data-floating
                            inert={collapsed || undefined}
                            className={`absolute inset-x-0 top-full ${GUTTER} pb-2 bg-[var(--neu-bg)] after:absolute after:inset-x-0 after:top-full after:h-3.5 after:bg-gradient-to-b after:from-[var(--neu-bg)] after:to-transparent after:pointer-events-none transition-[opacity,translate] duration-[280ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-[opacity,translate] ${collapsed
                                ? 'opacity-0 -translate-y-2 pointer-events-none'
                                : 'opacity-100 translate-y-0'
                                }`}
                        >
                            <div className={`${WIDTH_CLS[width]} space-y-2`}>
                                {children}
                            </div>
                        </div>
                    </HeaderToolsContext.Provider>
                )}
                {children && !floating && (
                    <HeaderToolsContext.Provider value={headerTools}>
                        <div
                            data-page-header-tools
                            inert={collapsed || undefined}
                            className={`grid transition-[grid-template-rows,margin] duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${collapsed
                                ? 'grid-rows-[0fr] mt-0'
                                : 'grid-rows-[1fr] mt-2 md:mt-3 lg:mt-4'
                                }`}
                        >
                            <div className="min-h-0 [clip-path:inset(-16px)]">
                                <div className={`w-full space-y-2 md:space-y-3 transition-[opacity,translate,scale] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${collapsed
                                    ? 'opacity-0 -translate-y-2 scale-[0.97]'
                                    : 'opacity-100 translate-y-0 scale-100 delay-100'
                                    }`}
                                >
                                    {children}
                                </div>
                            </div>
                        </div>
                    </HeaderToolsContext.Provider>
                )}
            </div>
        </header>
    );
};

const SPACE_CLS: Record<string, string> = {
    none: '',
    sm: 'space-y-2',
    md: 'space-y-3',
    lg: 'space-y-4 lg:space-y-5',
};

// items-start so a short card doesn't stretch to the height of the tallest
// one in its row, which left big empty cards on wide screens.
const COLS_CLS: Record<number | 'gallery', string> = {
    1: 'grid grid-cols-1 items-start',
    2: 'grid grid-cols-1 md:grid-cols-2 items-start',
    3: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 items-start',
    4: 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 items-start',
    // Picture tiles: two up even on phones, stretched so a row lines up.
    gallery: 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 items-stretch',
};

interface PageBodyProps {
    children?: React.ReactNode;
    /** Column count for desktop multi-column grids (1–4). */
    columns?: 1 | 2 | 3 | 4 | 'gallery';
    /** Vertical rhythm between stacked children. Default 'md'. */
    space?: keyof typeof SPACE_CLS;
    /** Classes for the content wrapper — grid and spacing overrides go here. */
    className?: string;
    /** Classes for the outer scroller — padding and overflow overrides. */
    scrollClassName?: string;
}

/**
 * The scrolling body of a page.
 *
 * The bottom padding clears the phone dock and the iOS home indicator; `lg:pb-10` takes it back on desktop, where
 * the dock is hidden and that reserved strip would just be dead space.
 */
export const PageBody: React.FC<PageBodyProps> = ({
    children, columns, space = 'md', className = '', scrollClassName = '',
}) => {
    const { width } = useContext(PageChromeContext);
    // `pt-3` gives the first row's raised shadow room above the scroll-clip
    // edge — plus, on a phone, the height of the header's tools floating over
    // the top of this scroller (0 everywhere else) — and `neu-scroll-fade` melts scrolled content into the header
    // instead of shearing it on a hard line — header and body read as one
    // surface. The bottom padding clears the phone dock and the iOS home
    // indicator; lg:pb-10 takes it back on desktop, where the dock is hidden.
    const base = `flex-1 min-h-0 w-full ${GUTTER} pt-[calc(0.75rem+var(--page-tools-h,0px))] pb-[calc(6rem+var(--safe-bottom-ui))] lg:pb-10 no-scrollbar neu-scroll-fade overflow-y-auto`;
    const inner = columns
        ? `${WIDTH_CLS[width]} ${COLS_CLS[columns]} gap-3 md:gap-4 lg:gap-5`
        : `${WIDTH_CLS[width]} ${SPACE_CLS[space]}`;
    return (
        <div className={`${base} ${scrollClassName}`}>
            <div className={`${inner} ${className}`}>{children}</div>
        </div>
    );
};

/* ------------------------------ Buttons ------------------------------ */

interface IconButtonProps {
    onClick?: () => void;
    label: string;
    icon: React.ReactNode;
    disabled?: boolean;
}

/** Gold-gradient primary action (the header "+"). Same 36px as
 *  GhostIconButton, so header actions line up; pass a 16px icon. */
export const PrimaryIconButton: React.FC<IconButtonProps> = ({ onClick, label, icon, disabled = false }) => (
    <button
        onClick={onClick}
        aria-label={label}
        title={label}
        disabled={disabled}
        className={`w-9 h-9 shrink-0 neu-accent neu-btn rounded-full flex items-center justify-center active-scale ring-1 ring-gold-600/20 disabled:opacity-50 disabled:pointer-events-none`}
    >
        {icon}
    </button>
);

/** Subtle raised secondary action. */
export const GhostIconButton: React.FC<IconButtonProps> = ({ onClick, label, icon, disabled = false }) => (
    <button
        onClick={onClick}
        aria-label={label}
        title={label}
        disabled={disabled}
        className="w-9 h-9 shrink-0 neu-raised-sm neu-btn rounded-full flex items-center justify-center active-scale disabled:opacity-40 disabled:pointer-events-none"
    >
        {icon}
    </button>
);

type ButtonVariant = 'default' | 'primary' | 'danger';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
    variant?: ButtonVariant;
    /** Stretch to the container width — forms, sheet footers. */
    block?: boolean;
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
}

const VARIANT_CLS: Record<ButtonVariant, string> = {
    default: '',
    primary: 'neu-button-primary',
    danger: 'neu-button-danger',
};

/**
 * Text button. Every extruded surface, never a flat colour fill — the gold
 * primary is a gradient with the same shadow pair as the rest of the UI.
 */
export const Button: React.FC<ButtonProps> = ({
    variant = 'default', block = false, icon, children, className = '', ...rest
}) => (
    <button
        {...rest}
        className={`neu-button ${VARIANT_CLS[variant]} ${block ? 'w-full' : ''} ${className}`}
    >
        {icon}
        {children}
    </button>
);

/* ------------------------------ Surfaces ----------------------------- */

interface CardProps {
    children?: React.ReactNode;
    /** Adds hover lift + pointer cursor. Use for clickable list/grid items. */
    interactive?: boolean;
    /** Inner padding preset. Default 'md'. */
    padding?: 'none' | 'sm' | 'md' | 'lg';
    className?: string;
    onClick?: () => void;
}

const PAD_CLS = { none: '', sm: 'p-3', md: 'p-4 lg:p-5', lg: 'p-5 lg:p-6' };

/** Standard raised surface — the one card treatment app-wide. */
export const Card: React.FC<CardProps> = ({
    children, interactive = false, padding = 'md', className = '', onClick,
}) => {
    const cls = `${interactive ? 'neu-card-interactive cursor-pointer' : 'neu-card'} ${PAD_CLS[padding]} ${className}`;
    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={`${cls} text-left w-full`}>
                {children}
            </button>
        );
    }
    return <div className={cls}>{children}</div>;
};

/** Small caps heading used inside cards and sections. */
export const SectionTitle: React.FC<{ children?: React.ReactNode; actions?: React.ReactNode; className?: string }> = ({
    children, actions, className = '',
}) => (
    <div className={`flex items-center justify-between gap-3 mb-3 ${className}`}>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">
            {children}
        </h3>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
);

/** Engraved hairline separator. */
export const Divider: React.FC<{ className?: string }> = ({ className = '' }) => (
    <hr className={`neu-divider w-full my-1 border-0 ${className}`} />
);

/* ------------------------------- Fields ------------------------------ */

interface FieldProps {
    label: string;
    htmlFor?: string;
    hint?: string;
    children?: React.ReactNode;
    className?: string;
}

/** Label + control + hint, with one spacing rhythm everywhere. */
export const Field: React.FC<FieldProps> = ({ label, htmlFor, hint, children, className = '' }) => (
    <div className={className}>
        <label htmlFor={htmlFor} className="neu-label">{label}</label>
        {children}
        {hint && <p className="mt-1 text-[11px] text-gray-600 dark:text-gray-400 font-light">{hint}</p>}
    </div>
);

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** Inset well input. */
export const Input: React.FC<InputProps> = ({ className = '', ...rest }) => (
    <input {...rest} className={`neu-field ${className}`} />
);

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea: React.FC<TextareaProps> = ({ className = '', ...rest }) => (
    <textarea {...rest} className={`neu-field ${className}`} />
);

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** Inset well select. The chevron comes from `select.neu-field` in CSS, so a
 *  plain <select className="neu-field"> elsewhere looks the same as this. */
export const Select: React.FC<SelectProps> = ({ className = '', children, ...rest }) => (
    <select {...rest} className={`neu-field ${className}`}>
        {children}
    </select>
);

/** Read-only counterpart to Input — same well, no interaction. */
export const ReadOnlyValue: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <p className={`neu-value ${className}`}>{children}</p>
);

interface ToggleProps {
    checked: boolean;
    onChange: () => void;
    label: string;
    disabled?: boolean;
}

/** Neumorphic switch — pressed track, extruded knob that turns gold when on. */
export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, disabled = false }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        data-on={checked}
        className={`neu-toggle ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
        <span className="neu-toggle-knob" />
    </button>
);

/** Label + description on the left, Toggle on the right. */
export const ToggleRow: React.FC<{
    icon?: React.ReactNode;
    title: string;
    description?: string;
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
}> = ({ icon, title, description, checked, onChange, disabled = false }) => (
    <div className="flex items-center justify-between gap-4 py-1.5">
        <div className="flex items-center gap-3 min-w-0 text-gray-700 dark:text-gray-200">
            {icon && <span className="shrink-0">{icon}</span>}
            <div className="min-w-0">
                <p className="text-sm font-medium truncate">{title}</p>
                {description && (
                    <p className="text-[11px] text-gray-600 dark:text-gray-400 font-light">{description}</p>
                )}
            </div>
        </div>
        <Toggle checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
);

/* ------------------------------- Pills ------------------------------- */

export const Pill: React.FC<{
    active?: boolean;
    onClick?: () => void;
    children?: React.ReactNode;
    className?: string;
}> = ({ active = false, onClick, children, className = '' }) => (
    <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`neu-pill ${active ? 'neu-pill-active' : ''} ${className}`}
    >
        {children}
    </button>
);

/** Non-interactive status chip. */
export const Badge: React.FC<{ children?: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
    <span className={`neu-badge ${className}`}>{children}</span>
);

/* ----------------------------- Empty state ---------------------------- */

interface EmptyStateProps {
    /** Optional lucide icon, shown inside a pressed well. */
    icon?: React.ReactNode;
    title: string;
    message?: string;
    /** Optional call to action rendered under the message. */
    action?: React.ReactNode;
    className?: string;
}

/** Shared empty state — raised card with an inset icon well. */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, message, action, className = '' }) => (
    <div className={`col-span-full text-center py-12 lg:py-16 px-6 neu-card ${className}`}>
        {icon && (
            <div className="mx-auto mb-3 w-12 h-12 rounded-full neu-inset flex items-center justify-center text-gray-600 dark:text-gray-300">
                {icon}
            </div>
        )}
        <p className="text-sm lg:text-base font-serif text-gray-700 dark:text-gray-200 mb-1.5">{title}</p>
        {message && (
            <p className="text-xs lg:text-sm text-gray-600 dark:text-gray-300 font-light leading-relaxed max-w-sm mx-auto">
                {message}
            </p>
        )}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
);
