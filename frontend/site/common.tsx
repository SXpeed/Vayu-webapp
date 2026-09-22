// Pieces shared by the public pages: header, footer, placeholder frames and
// pricing cards fed from the plans published in the control centre.

import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useBranding } from '../useBranding';
import type { Copy } from './content';
import { content } from './content';

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

export const SiteHeader: React.FC<{ minimal?: boolean }> = ({ minimal = false }) => {
    const b = useBranding();
    return (
        <header className="sticky top-0 z-20 backdrop-blur bg-[var(--neu-bg)]/85 border-b border-black/5 dark:border-white/10">
            <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-6">
                <a href="/welcome" className="flex items-center gap-2.5 shrink-0">
                    {b.logoUrl
                        ? <img src={b.logoUrl} alt="" className="w-8 h-8 rounded-lg object-contain" />
                        : <span className="w-8 h-8 rounded-lg neu-accent flex items-center justify-center font-serif">{b.appName.slice(0, 1).toUpperCase()}</span>}
                    <span className="font-serif text-lg text-gray-900 dark:text-gray-100">{b.appName}</span>
                </a>
                {!minimal && (
                    <nav className="hidden md:flex items-center gap-6 text-sm text-gray-700 dark:text-gray-300">
                        <a href="/welcome#features" className="hover:text-gold-700">Features</a>
                        <a href="/welcome#how" className="hover:text-gold-700">How it works</a>
                        <a href="/welcome#pricing" className="hover:text-gold-700">Pricing</a>
                        <a href="/welcome#about" className="hover:text-gold-700">About</a>
                        <a href="/welcome#contact" className="hover:text-gold-700">Contact</a>
                    </nav>
                )}
                <div className="ml-auto flex items-center gap-2">
                    <a href={SIGNIN_URL} className="text-sm px-3 py-2 whitespace-nowrap text-gray-800 dark:text-gray-200 hover:text-gold-700">Log in</a>
                    {/* On phones the hero carries the main button, so the header keeps only "Log in". */}
                    {!minimal && <a href={SIGNUP_URL} className="hidden sm:inline-flex neu-button neu-button-primary text-sm whitespace-nowrap">Get started</a>}
                </div>
            </div>
        </header>
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
                    <a href="/welcome#pricing" className="hover:text-gold-700">Pricing</a>
                    <a href="/welcome#contact" className="hover:text-gold-700">Contact</a>
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
        const v = p.highlights.limits?.[key];
        if (v === undefined) continue;
        out.push(v === null ? `Unlimited ${many}` : `${v.toLocaleString('en-IN')} ${v === 1 ? one : many}`);
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

export const PlanCard: React.FC<{ plan: PublicPlan; cycle: 'monthly' | 'annual'; selected?: boolean; onChoose?: () => void; cta?: string; href?: string }> = ({ plan, cycle, selected, onChoose, cta = 'Choose', href }) => {
    const price = planPrice(plan, cycle);
    const Action = href
        ? <a href={href} className="neu-button neu-button-primary w-full justify-center mt-6">{cta}</a>
        : <button type="button" onClick={onChoose} className={`neu-button w-full justify-center mt-6 ${selected ? 'neu-button-primary' : ''}`}>{selected ? 'Selected' : cta}</button>;
    return (
        <div className={`neu-card p-6 flex flex-col ${selected ? 'ring-2 ring-gold-500' : ''}`}>
            <p className="font-serif text-xl text-gray-900 dark:text-gray-100">{plan.name}</p>
            {plan.description && <p className="text-[13px] mt-1 text-gray-600 dark:text-gray-400">{plan.description}</p>}
            <p className="mt-4">
                <span className="font-serif text-3xl text-gray-900 dark:text-gray-100">{price.amount}</span>
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
