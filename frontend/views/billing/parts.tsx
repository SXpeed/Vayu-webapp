// Small pieces shared by the billing screens, in the app's own surface styles.

import React, { useEffect } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeft, X } from 'lucide-react';
import { SectionTitle } from '../../components/ui';

/** Full-screen sheet with the app's sheet header (back/close, title, right-side actions). */
export function Sheet({ title, subtitle, onClose, close = 'back', actions, z = 'z-50', children }: Readonly<{
    title: string;
    subtitle?: string;
    onClose: () => void;
    close?: 'back' | 'close';
    actions?: React.ReactNode;
    z?: string;
    children?: React.ReactNode;
}>) {
    return (
        <dialog open className={`neu-sheet ${z} animate-fade-in-up`} aria-label={title}>
            <div className="flex justify-between items-center gap-2 p-3 pt-[calc(1.75rem+var(--safe-top))] lg:pt-4 z-10">
                <button type="button" onClick={onClose} aria-label={close === 'back' ? 'Back' : 'Close'} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale shrink-0">
                    {close === 'back' ? <ArrowLeft size={20} /> : <X size={20} />}
                </button>
                <div className="min-w-0 text-center">
                    <h2 className="text-base font-serif text-gray-900 dark:text-white truncate">{title}</h2>
                    {subtitle && <p className="text-[10px] uppercase tracking-[0.14em] text-gray-600 dark:text-gray-400 truncate">{subtitle}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0 min-w-9 justify-end">{actions}</div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 lg:p-6 no-scrollbar pb-[calc(6rem+var(--safe-bottom-ui))] lg:pb-8">
                <div className="max-w-3xl mx-auto w-full flex flex-col gap-4">{children}</div>
            </div>
        </dialog>
    );
}

/** Centred dialog for short forms (payment, cancel reason, returns). Escape closes it. */
export function Modal({ title, onClose, children, footer }: Readonly<{ title: string; onClose: () => void; children?: React.ReactNode; footer?: React.ReactNode }>) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        globalThis.addEventListener('keydown', onKey);
        return () => globalThis.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <dialog open aria-modal="true" aria-label={title} className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-3">
            <button type="button" aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
            <div className="relative neu-card w-full max-w-md p-5 space-y-4 max-h-[85dvh] overflow-y-auto no-scrollbar animate-fade-in-up">
                <div className="flex items-center justify-between">
                    <h3 className="font-serif text-lg text-gray-900 dark:text-white">{title}</h3>
                    <button type="button" onClick={onClose} aria-label="Close" className="neu-icon-btn text-gray-600 dark:text-gray-300 active-scale"><X size={16} /></button>
                </div>
                {children}
                {footer && <div className="flex gap-2 justify-end pt-1">{footer}</div>}
            </div>
        </dialog>
    );
}

export function CardSection({ title, hint, actions, children, className = '' }: Readonly<{ title: string; hint?: string; actions?: React.ReactNode; children?: React.ReactNode; className?: string }>) {
    return (
        <section className={`neu-card p-4 lg:p-5 ${className}`}>
            <SectionTitle actions={actions}>{title}</SectionTitle>
            {hint && <p className="-mt-2 mb-3 text-[11px] text-gray-600 dark:text-gray-400">{hint}</p>}
            <div className="space-y-4">{children}</div>
        </section>
    );
}

const STATUS_TONE: Record<string, string> = {
    Paid: 'text-green-700 dark:text-green-400',
    Issued: 'text-blue-700 dark:text-blue-400',
    Sent: 'text-blue-700 dark:text-blue-400',
    Accepted: 'text-green-700 dark:text-green-400',
    Converted: 'text-green-700 dark:text-green-400',
    Invoiced: 'text-green-700 dark:text-green-400',
    Delivered: 'text-blue-700 dark:text-blue-400',
    Returned: 'text-green-700 dark:text-green-400',
    'Part returned': 'text-yellow-700 dark:text-yellow-400',
    'Partly paid': 'text-yellow-700 dark:text-yellow-400',
    Unpaid: 'text-yellow-700 dark:text-yellow-400',
    Overdue: 'text-red-700 dark:text-red-400',
    Cancelled: 'text-red-700 dark:text-red-400',
    Rejected: 'text-red-700 dark:text-red-400',
    Expired: 'text-gray-600 dark:text-gray-400',
};

export function StatusBadge({ text }: Readonly<{ text: string }>) {
    return (
        <span className={`neu-status text-[10px] px-1.5 py-0.5 rounded-[3px] font-medium uppercase tracking-wider inline-block ${STATUS_TONE[text] ?? 'text-yellow-700 dark:text-yellow-400'}`}>
            {text}
        </span>
    );
}

/** Runs an action and shows its error (the server's words) as a toast instead of throwing. True when it worked. */
export async function attempt(fn: () => unknown, success?: string): Promise<boolean> {
    try {
        await fn();
        if (success) toast.success(success);
        return true;
    } catch (e) {
        toast.error((e as Error).message || 'Something went wrong. Please try again.');
        return false;
    }
}

export const dateInput = (ms: number | undefined): string => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A yyyy-mm-dd input value as local noon (so it never slips a day across time zones). */
export const fromDateInput = (v: string): number | undefined => (v ? new Date(`${v}T12:00:00`).getTime() : undefined);

export const shortDate = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Reads a picked image as a small JPEG data URL (logo, signature), so it fits in storage. */
export async function readImage(file: File, maxPx = 400): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', 0.85);
}
