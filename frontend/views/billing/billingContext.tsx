// What the Billing screens share: the documents, the setup, and the actions,
// each going through the server (which numbers, locks and totals) and then
// updating inventory the way the setup asks.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Artwork, Contact } from '../../types';
import {
    balanceOf, issueProblems, statusAfterReturn,
    type BillingDoc, type BillingSettings, type DocStatus, type Payment,
} from '../../invoicing';
import { rupeesText } from '../../gstRules';
import { saveBillingSettings, useBillingSettings } from '../../services/invoiceService';
import { useAppChrome } from '../../components/Layout';

export interface BillingHandlers {
    handleSaveInvoice: (doc: BillingDoc) => Promise<BillingDoc>;
    handleIssueInvoice: (id: string) => Promise<BillingDoc[]>;
    handleCancelInvoice: (id: string, reason: string) => Promise<BillingDoc>;
    handleDeleteInvoice: (id: string) => Promise<void>;
}

export interface BillingApi {
    settings: BillingSettings;
    docs: BillingDoc[];
    artworks: Artwork[];
    contacts: readonly Contact[];
    online: boolean;
    /** May create and change documents (Billing "edit"). */
    canEdit: boolean;
    /** May change the billing setup (workspace admins: it holds the bank account invoices ask customers to pay into). */
    isAdmin: boolean;
    onArtworkClick?: (artwork: Artwork) => void;
    saveSettings: (settings: BillingSettings) => Promise<void>;
    saveDoc: (doc: BillingDoc) => Promise<BillingDoc>;
    /** Issues the draft given (as just saved: the list may not show it yet). */
    issueDoc: (doc: BillingDoc) => Promise<BillingDoc>;
    cancelDoc: (id: string, reason: string) => Promise<void>;
    deleteDoc: (id: string) => Promise<void>;
    setStatus: (id: string, status: DocStatus) => Promise<void>;
    addPayment: (id: string, payment: Omit<Payment, 'id'>) => Promise<void>;
    removePayment: (id: string, paymentId: string) => Promise<void>;
    markDelivered: (id: string) => Promise<void>;
    recordReturn: (id: string, returned: Record<string, number>) => Promise<void>;
}

const BillingContext = createContext<BillingApi | null>(null);

export function useBilling(): BillingApi {
    const api = useContext(BillingContext);
    if (!api) throw new Error('useBilling outside BillingProvider');
    return api;
}

function useOnline(): boolean {
    const [online, setOnline] = useState(() => navigator.onLine);
    useEffect(() => {
        const on = () => setOnline(true);
        const off = () => setOnline(false);
        globalThis.addEventListener('online', on);
        globalThis.addEventListener('offline', off);
        return () => {
            globalThis.removeEventListener('online', on);
            globalThis.removeEventListener('offline', off);
        };
    }, []);
    return online;
}

export const BillingProvider: React.FC<{
    docs: BillingDoc[];
    artworks: Artwork[];
    contacts?: readonly Contact[];
    handlers: BillingHandlers;
    onArtworkClick?: (artwork: Artwork) => void;
    children?: React.ReactNode;
}> = ({ docs, artworks, contacts = [], handlers, onArtworkClick, children }) => {
    const settings = useBillingSettings();
    const online = useOnline();
    const chrome = useAppChrome();
    const canEdit = chrome.can('invoices', 'edit');
    const isAdmin = chrome.isAdmin;
    // Actions read the latest documents and setup, not the ones from when they were made.
    const latest = useRef({ docs, settings, handlers });
    latest.current = { docs, settings, handlers };

    const actions = useMemo(() => {
        const find = (id: string): BillingDoc => {
            const doc = latest.current.docs.find(d => d.id === id);
            if (!doc) throw new Error('That document no longer exists.');
            return doc;
        };
        // updatedAt goes back as loaded: the server refuses a save made from an older copy.
        const save = (doc: BillingDoc) => latest.current.handlers.handleSaveInvoice(doc);

        return {
            saveSettings: async (next: BillingSettings) => { await saveBillingSettings(next); },
            saveDoc: save,
            async issueDoc(doc: BillingDoc) {
                if (!navigator.onLine) throw new Error('Issuing needs a connection, so a number is never used twice. The draft is saved.');
                const problems = issueProblems(doc, latest.current.settings);
                if (problems.length) throw new Error(problems[0]);
                const [issued] = await latest.current.handlers.handleIssueInvoice(doc.id);
                return issued;
            },
            async cancelDoc(id: string, reason: string) {
                await latest.current.handlers.handleCancelInvoice(id, reason);
            },
            async deleteDoc(id: string) {
                await latest.current.handlers.handleDeleteInvoice(id);
            },
            async setStatus(id: string, status: DocStatus) {
                const doc = find(id);
                if (doc.kind !== 'proforma') throw new Error('Only a proforma’s status is set by hand.');
                await save({ ...doc, status });
            },
            async addPayment(id: string, payment: Omit<Payment, 'id'>) {
                const doc = find(id);
                if (!Number.isFinite(payment.amountPaise) || payment.amountPaise <= 0) throw new Error('Enter an amount above ₹0.');
                const { due } = balanceOf(doc, latest.current.docs, latest.current.settings);
                if (payment.amountPaise > due) throw new Error(`That’s more than the balance due (${rupeesText(due)}).`);
                await save({ ...doc, payments: [...doc.payments, { ...payment, id: crypto.randomUUID() }] });
            },
            async removePayment(id: string, paymentId: string) {
                const doc = find(id);
                await save({ ...doc, payments: doc.payments.filter(p => p.id !== paymentId) });
            },
            async markDelivered(id: string) {
                await save({ ...find(id), status: 'Delivered' });
            },
            async recordReturn(id: string, returned: Record<string, number>) {
                const doc = find(id);
                const lines = doc.lines.map(l => ({ ...l, returnedQty: Math.min(l.qty, Math.max(l.returnedQty ?? 0, Math.floor(returned[l.key] ?? l.returnedQty ?? 0))) }));
                const updated = { ...doc, lines };
                await save({ ...updated, status: statusAfterReturn(updated) });
            },
        };
    }, []);

    const api = useMemo<BillingApi>(() => ({ settings, docs, artworks, contacts, online, canEdit, isAdmin, onArtworkClick, ...actions }),
        [settings, docs, artworks, contacts, online, canEdit, isAdmin, onArtworkClick, actions]);
    return <BillingContext.Provider value={api}>{children}</BillingContext.Provider>;
};
