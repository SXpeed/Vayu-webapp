// Pieces shared by the public pages: header, footer, placeholder frames and
// pricing cards fed from the plans published in the control centre.

import React, { useEffect, useRef, useState } from 'react';
import { Check, Menu, X } from 'lucide-react';
import { useBranding } from '../useBranding';
import type { Copy } from './content';
import { content } from './content';

/**
 * The landing page. It is the root of ateliersupport.com; the dev server
 * serves every page from one folder, where the root is the app, so there it
 * stays at /welcome.
 */
export const HOME_URL = import.meta.env.DEV ? '/welcome' : '/';
export const SIGNUP_URL = '/signup';
export const SIGNIN_URL = '/signup?mode=signin';

/** Renders real copy as-is, and a placeholder as a clearly marked frame. */
export const Text: React.FC<{ copy: Copy; className?: string }> = ({ copy, className = '' }) =>
    typeof copy === 'string'
        ? <span className={className}>{copy}</span>
        : (
            <span className={`inline-block border border-dashed border-amber-500/70 rounded-lg px-2 py-1 text-amber-800 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-900/10 ${className}`}>
                <span className="text-[10px] uppercase tracking-[0.14em] font-semibold mr-1">Placeholder</span>{copy.note}
            </span>
        );

const NAV: { id: string; label: string }[] = [
    { id: 'features', label: 'Features' },
    { id: 'how', label: 'How it works' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'about', label: 'About' },
    { id: 'contact', label: 'Contact' },
];

/**
 * The public header. Its height never changes: once the page moves it only
 * gains a quiet surface and hairline. On the welcome page the section being
 * read is marked. Phones get a menu button with a proper disclosure menu:
 * Escape or a tap outside closes it, and focus goes back to the button.
 */
export const SiteHeader: React.FC<{ minimal?: boolean; active?: string | null }> = ({ minimal = false, active = null }) => {
    const b = useBranding();
    const [scrolled, setScrolled] = useState(false);
    const [open, setOpen] = useState(false);
    const sentinel = useRef<HTMLSpanElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);

    // A 1px marker at the top of the page: when it leaves the screen, the page has moved.
    useEffect(() => {
        const el = sentinel.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting));
        io.observe(el);
        return () => io.disconnect();
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
        };
        const onWide = () => { if (window.innerWidth >= 1024) setOpen(false); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        window.addEventListener('resize', onWide);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDown);
            window.removeEventListener('resize', onWide);
        };
    }, [open]);

    return (
        <>
            <span ref={sentinel} aria-hidden className="absolute top-0 left-0 h-px w-px" />
            <header className="mk-header sticky top-0 z-30" data-scrolled={scrolled || open ? 'true' : 'false'}>
                <div className="max-w-6xl mx-auto px-5 h-16 flex items-center gap-6">
                    <a href={HOME_URL} className="flex items-center gap-2.5 shrink-0 rounded-lg">
                        {b.logoUrl
                            ? <img src={b.logoUrl} alt="" width={32} height={32} className="w-8 h-8 rounded-lg object-contain" />
                            : <span className="w-8 h-8 rounded-lg neu-accent flex items-center justify-center font-serif">{b.appName.slice(0, 1).toUpperCase()}</span>}
                        <span className="font-serif text-lg text-gray-900 dark:text-gray-100">{b.appName}</span>
                    </a>
                    {!minimal && (
                        <nav aria-label="Sections" className="hidden lg:flex items-center gap-6 text-sm text-gray-700 dark:text-gray-300">
                            {NAV.map(n => (
                                <a key={n.id} href={`${HOME_URL}#${n.id}`} aria-current={active === n.id ? 'location' : undefined}
                                    className="mk-navlink hover:text-gold-700 dark:hover:text-gold-300">{n.label}</a>
                            ))}
                        </nav>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                        <a href={SIGNIN_URL} className="text-sm px-3 py-2 whitespace-nowrap text-gray-800 dark:text-gray-200 hover:text-gold-700 rounded-lg">Log in</a>
                        {/* On phones the hero carries the main button, so the header keeps only "Log in". */}
                        {!minimal && <a href={SIGNUP_URL} className="hidden sm:inline-flex neu-button neu-button-primary text-sm whitespace-nowrap">Get started</a>}
                        {!minimal && (
                            <button ref={button} type="button" onClick={() => setOpen(o => !o)}
                                aria-expanded={open} aria-controls="mk-menu" aria-label={open ? 'Close menu' : 'Open menu'}
                                className="lg:hidden w-10 h-10 rounded-full neu-raised-sm neu-btn flex items-center justify-center text-gray-800 dark:text-gray-200 active-scale">
                                {open ? <X size={18} /> : <Menu size={18} />}
                            </button>
                        )}
                    </div>
                </div>
                {!minimal && (
                    <div ref={menu} id="mk-menu" data-open={open ? 'true' : 'false'} data-lenis-prevent
                        className="mk-menu lg:hidden absolute left-0 right-0 top-full px-4 pb-4">
                        <nav aria-label="Sections menu" className="neu-card p-3">
                            <ul className="space-y-1">
                                {NAV.map(n => (
                                    <li key={n.id}>
                                        <a href={`${HOME_URL}#${n.id}`} onClick={() => setOpen(false)} tabIndex={open ? undefined : -1}
                                            aria-current={active === n.id ? 'location' : undefined}
                                            className={`block rounded-xl px-4 py-3 text-[15px] ${active === n.id ? 'neu-inset text-gold-700 dark:text-gold-300' : 'text-gray-800 dark:text-gray-200'}`}>
                                            {n.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                            <a href={SIGNUP_URL} tabIndex={open ? undefined : -1} className="mt-3 neu-button neu-button-primary w-full justify-center">Get started</a>
                        </nav>
                    </div>
                )}
            </header>
        </>
    );
};

export const SiteFooter: React.FC = () => {
    const b = useBranding();
    return (
        <footer className="border-t border-black/5 dark:border-white/10 mt-24">
            <div className="max-w-6xl mx-auto px-4 py-10 flex flex-col md:flex-row gap-6 md:items-center text-sm text-gray-600 dark:text-gray-400">
                <div>
                    <p className="font-serif text-base text-gray-900 dark:text-gray-100">{b.appName}</p>
                    <p className="text-[12px] mt-1">{content.footer.note}</p>
                </div>
                <nav className="md:ml-auto flex flex-wrap gap-5">
                    <a href={`${HOME_URL}#pricing`} className="hover:text-gold-700">Pricing</a>
                    <a href={`${HOME_URL}#contact`} className="hover:text-gold-700">Contact</a>
                    <a href="/legal#privacy" className="hover:text-gold-700">Privacy policy</a>
                    <a href="/legal#terms" className="hover:text-gold-700">Terms</a>
                    <a href={SIGNIN_URL} className="hover:text-gold-700">Log in</a>
                </nav>
            </div>
        </footer>
    );
};

// ── Plans ─────────────────────────────────────────────────────────────────

export interface PublicPlan {
    key: string; name: string; description: string; billingType: string; currency: string;
    priceMonthly: number; priceAnnual: number; trialDays: number;
    highlights: { limits: Record<string, number | null>; modules: Record<string, boolean>; features: Record<string, boolean> };
}

export function usePublicPlans(): PublicPlan[] | null {
    const [plans, setPlans] = useState<PublicPlan[] | null>(null);
    useEffect(() => {
        fetch('/api/v2/public/plans')
            .then(r => (r.ok ? r.json() : { plans: [] }))
            .then(d => setPlans(Array.isArray(d.plans) ? d.plans : []))
            .catch(() => setPlans([]));
    }, []);
    return plans;
}

export const money = (minor: number, currency: string) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

/** [key, singular, plural] */
const LIMIT_LABELS: [string, string, string][] = [
    ['maxMembers', 'team member', 'team members'], ['maxItems', 'inventory item', 'inventory items'], ['maxStores', 'store', 'stores'],
    ['maxCatalogs', 'catalog', 'catalogs'], ['pdfGenerationsPerMonth', 'PDF a month', 'PDFs a month'], ['storageMb', 'MB storage', 'MB storage'],
];
const FEATURE_LABELS: Record<string, string> = {
    catalogs: 'Catalogs', invoices: 'Invoices', inquiries: 'Inquiries', messaging: 'Team messaging', attendance: 'Attendance',
    calendar: 'Calendar', payments: 'Payment collection', catalogPdf: 'Catalog PDFs', backgroundRemoval: 'Background removal',
    exports: 'Data export', customRoles: 'Custom roles', branding: 'Your own branding', prioritySupport: 'Priority support',
};

export function planBullets(p: PublicPlan): string[] {
    const out: string[] = [];
    for (const [key, one, many] of LIMIT_LABELS) {
        const v: number | null | undefined = p.highlights.limits?.[key];
        if (v === undefined) continue;
        if (v === null) out.push(`Unlimited ${many}`);
        else out.push(`${v.toLocaleString('en-IN')} ${v === 1 ? one : many}`);
    }
    for (const [key, on] of [...Object.entries(p.highlights.modules ?? {}), ...Object.entries(p.highlights.features ?? {})]) {
        if (on && FEATURE_LABELS[key]) out.push(FEATURE_LABELS[key]);
    }
    return out;
}

export function planPrice(p: PublicPlan, cycle: 'monthly' | 'annual'): { amount: string; per: string } {
    if (p.billingType === 'free') return { amount: 'Free', per: '' };
    if (p.billingType === 'custom') return { amount: 'Custom', per: 'talk to us' };
    if (p.billingType === 'trial') return { amount: `${p.trialDays}-day trial`, per: '' };
    return cycle === 'annual'
        ? { amount: money(p.priceAnnual, p.currency), per: '/ year' }
        : { amount: money(p.priceMonthly, p.currency), per: '/ month' };
}

export const PlanCard: React.FC<{ plan: PublicPlan; cycle: 'monthly' | 'annual'; selected?: boolean; onChoose?: () => void; cta?: string; href?: string; className?: string }> = ({ plan, cycle, selected, onChoose, cta = 'Choose', href, className = '' }) => {
    const price = planPrice(plan, cycle);
    const Action = href
        ? <a href={href} className="neu-button neu-button-primary w-full justify-center mt-6">{cta}</a>
        : <button type="button" onClick={onChoose} className={`neu-button w-full justify-center mt-6 ${selected ? 'neu-button-primary' : ''}`}>{selected ? 'Selected' : cta}</button>;
    return (
        <div className={`neu-card p-6 flex flex-col ${selected ? 'ring-2 ring-gold-500' : ''} ${className}`}>
            <p className="font-serif text-xl text-gray-900 dark:text-gray-100">{plan.name}</p>
            {plan.description && <p className="text-[13px] mt-1 text-gray-600 dark:text-gray-400">{plan.description}</p>}
            <p className="mt-4">
                <span className="font-serif text-3xl text-gray-900 dark:text-gray-100 tabular-nums">{price.amount}</span>
                <span className="text-sm text-gray-600 dark:text-gray-400"> {price.per}</span>
            </p>
            {plan.billingType === 'paid' && plan.trialDays > 0 && (
                <p className="text-[12px] text-gray-600 dark:text-gray-400">{plan.trialDays}-day trial</p>
            )}
            <ul className="mt-5 space-y-2 text-[13px] text-gray-800 dark:text-gray-200 flex-1">
                {planBullets(plan).map(b => (
                    <li key={b} className="flex gap-2"><Check size={15} className="text-gold-600 shrink-0 mt-0.5" />{b}</li>
                ))}
            </ul>
            {Action}
        </div>
    );
};
