// One billing document: preview, PDF, and every action its kind and status allow.

import React, { useState } from 'react';
import toast from 'react-hot-toast';
import {
    Edit2, Download, Share2, Printer, Loader2, Send, CheckCircle2, XCircle, Receipt, Truck, FileMinus, FilePlus, Copy,
    Ban, IndianRupee, Link2, PackageCheck, Undo2, Phone, Mail, MapPin, Trash2,
} from 'lucide-react';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';
import { useBilling, type BillingApi } from './billingContext';
import {
    balanceOf, convertDoc, displayStatus, docTotals, isLocked, KIND_LABEL, kindLabel, PAYMENT_MODES, PURPOSE_LABEL, RETURNABLE,
    sellerOf, storeOf, SUPPLY_LABEL, taxModeOf, type Balance, type BillingDoc, type BillingSettings, type DocKind, type DocLine, type PaymentMode,
} from '../../invoicing';
import { formatPaise, rupeesText, stateLabel, toPaise, type TaxMode } from '../../gstRules';
import { exportDocPdf } from '../../services/billingPdf';
import { attempt, CardSection, dateInput, fromDateInput, Modal, Sheet, shortDate, StatusBadge } from './parts';
import { TotalsBlock } from './DocEditor';
import type { SettingsSection } from './SettingsSheet';

type ModalKind = 'payment' | 'cancel' | 'return';
type PdfHow = 'download' | 'share' | 'print';

interface ActionSpec { label: string; Icon: React.ElementType; run: () => void; variant?: 'primary' | 'danger' }

/** What the action lists need: the document, its balance, and what each button does. */
interface ActionContext {
    doc: BillingDoc;
    b: BillingApi;
    title: string;
    taxLabel: string;
    balance: Balance | null;
    convert: (kind: DocKind) => void;
    paymentLink: (paise: number, what: string) => void;
    openModal: (m: ModalKind) => void;
    onClose: () => void;
}

const run = (fn: () => Promise<unknown>, success?: string) => () => { void attempt(fn, success); };

function proformaActions(x: ActionContext): ActionSpec[] {
    const { doc, b } = x;
    const open = doc.status !== 'Converted';
    const out: ActionSpec[] = [];
    if (doc.status !== 'Sent') out.push({ label: 'Mark sent', Icon: Send, run: run(() => b.setStatus(doc.id, 'Sent')) });
    if (open && doc.status !== 'Accepted') out.push({ label: 'Accepted', Icon: CheckCircle2, run: run(() => b.setStatus(doc.id, 'Accepted')) });
    if (open && doc.status !== 'Rejected') out.push({ label: 'Rejected', Icon: XCircle, run: run(() => b.setStatus(doc.id, 'Rejected')) });
    if (open) out.push({ label: `Convert to ${x.taxLabel}`, Icon: Receipt, run: () => x.convert('tax'), variant: 'primary' });
    out.push({ label: 'Make challan', Icon: Truck, run: () => x.convert('challan') });
    if (doc.advancePaise) {
        const advance = doc.advancePaise;
        out.push({ label: 'Collect advance', Icon: Link2, run: () => x.paymentLink(advance, 'advance') });
    }
    return out;
}

function taxActions(x: ActionContext): ActionSpec[] {
    const due = x.balance?.due ?? 0;
    const collect: ActionSpec[] = due > 0
        ? [
            { label: 'Record payment', Icon: IndianRupee, run: () => x.openModal('payment'), variant: 'primary' },
            { label: 'Collect balance', Icon: Link2, run: () => x.paymentLink(due, 'balance') },
        ]
        : [];
    return [
        ...collect,
        { label: 'Delivery challan', Icon: Truck, run: () => x.convert('challan') },
        { label: 'Credit note', Icon: FileMinus, run: () => x.convert('credit') },
        { label: 'Debit note', Icon: FilePlus, run: () => x.convert('debit') },
    ];
}

function challanActions(x: ActionContext): ActionSpec[] {
    const { doc, b } = x;
    const returnable = !!doc.challanPurpose && RETURNABLE.has(doc.challanPurpose);
    return [
        ...(doc.status === 'Issued' ? [{ label: 'Mark delivered', Icon: PackageCheck, run: run(() => b.markDelivered(doc.id), 'Marked delivered') }] : []),
        ...(returnable ? [{ label: 'Record return', Icon: Undo2, run: () => x.openModal('return') }] : []),
        { label: `Convert to ${x.taxLabel}`, Icon: Receipt, run: () => x.convert('tax'), variant: 'primary' as const },
    ];
}

/** Every action this document's kind and status allow, in the order they show. */
function actionsFor(x: ActionContext): ActionSpec[] {
    const { doc, b } = x;
    const draft = doc.status === 'Draft' && doc.kind !== 'proforma';
    const out: ActionSpec[] = [];
    if (doc.kind === 'proforma') out.push(...proformaActions(x));
    if (draft) out.push({ label: `Issue ${x.title.toLowerCase()}`, Icon: CheckCircle2, run: run(() => b.issueDoc(doc), `${x.title} issued`), variant: 'primary' });
    if (doc.kind === 'tax' && doc.status === 'Issued') out.push(...taxActions(x));
    if (doc.kind === 'challan' && (doc.status === 'Issued' || doc.status === 'Delivered')) out.push(...challanActions(x));
    if (doc.kind !== 'credit' && doc.kind !== 'debit') out.push({ label: 'Duplicate', Icon: Copy, run: () => x.convert(doc.kind) });
    if (isLocked(doc) && doc.status !== 'Cancelled') out.push({ label: 'Cancel', Icon: Ban, run: () => x.openModal('cancel'), variant: 'danger' });
    if (draft) {
        out.push({ label: 'Delete draft', Icon: Trash2, variant: 'danger', run: () => { void attempt(() => b.deleteDoc(doc.id), 'Draft deleted').then(ok => { if (ok) x.onClose(); }); } });
    }
    return out;
}

type MaybeRow = [string, string | number | false | null | undefined];

/** The details shown under the customer; empty ones are left out. */
function detailRows(doc: BillingDoc, s: BillingSettings): [string, string][] {
    const store = s.stores.length > 1 ? storeOf(s, doc.storeId) : null;
    const rows: MaybeRow[] = [
        ['Date', shortDate(doc.date)],
        ['Store', store?.name],
        ['Place of supply', stateLabel(doc.placeOfSupply) || '-'],
        ['Valid until', doc.kind === 'proforma' && !!doc.validUntil && shortDate(doc.validUntil)],
        ['Due', doc.kind === 'tax' && !!doc.dueDate && shortDate(doc.dueDate)],
        ['Purpose', doc.kind === 'challan' && !!doc.challanPurpose && PURPOSE_LABEL[doc.challanPurpose]],
        ['Return by', doc.kind === 'challan' && !!doc.returnBy && shortDate(doc.returnBy)],
        ['Supply', doc.kind === 'tax' && doc.supplyType !== 'regular' && SUPPLY_LABEL[doc.supplyType]],
        ['Reverse charge', doc.reverseCharge && 'Yes'],
        ['Reason', doc.noteReason],
        ['E-way bill', doc.ewayBillNo],
        ['Reference', doc.reference],
        ['Cancelled because', doc.cancelReason],
    ];
    return rows.filter((r): r is [string, string] => typeof r[1] === 'string' && r[1] !== '');
}

/** "1 Nos × ₹1,000.00 − 10% · HSN 9701 · GST 5%". */
function lineSummary(l: DocLine, mode: TaxMode, challan: boolean): string {
    const rate = mode === 'zero' ? 0 : l.gstRate;
    const discount = l.discountPct ? ` − ${l.discountPct}%` : '';
    return [
        `${l.qty} ${l.unit} × ₹${formatPaise(l.ratePaise)}${discount}`,
        l.hsn && `HSN ${l.hsn}`,
        mode !== 'none' && `GST ${rate}%`,
        challan && !!l.returnedQty && `${l.returnedQty} returned`,
    ].filter(Boolean).join(' · ');
}

function PdfButtons({ doc, source }: Readonly<{ doc: BillingDoc; source?: BillingDoc }>) {
    const b = useBilling();
    const [busy, setBusy] = useState<PdfHow | null>(null);
    const buttons: [PdfHow, React.ElementType, string][] = [
        ['download', Download, 'PDF'],
        ...(typeof navigator.canShare === 'function' ? [['share', Share2, 'Share'] as [PdfHow, React.ElementType, string]] : []),
        ['print', Printer, 'Print'],
    ];
    const pdf = async (how: PdfHow) => {
        setBusy(how);
        try {
            const r = await exportDocPdf(doc, b.settings, b.artworks, how, source);
            if (how === 'share' && r === 'downloaded') toast('Sharing isn’t available here, so the PDF was downloaded.');
        } catch (e) {
            if ((e as Error).name !== 'AbortError') {
                console.error('Billing PDF failed:', e);
                toast.error('Could not create the PDF. Please try again.');
            }
        } finally {
            setBusy(null);
        }
    };
    return (
        <div className="flex gap-2">
            {buttons.map(([how, Icon, label], i) => (
                <button key={how} type="button" onClick={() => { void pdf(how); }} disabled={busy !== null}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg text-[11px] font-bold uppercase tracking-widest active-scale disabled:opacity-60 ${i === 0 ? 'neu-raised-sm neu-btn text-gold-700 dark:text-gold-300' : 'neu-inset text-gray-700 dark:text-gray-200'}`}>
                    {busy === how ? <Loader2 size={15} className="animate-spin" /> : <Icon size={15} />} {label}
                </button>
            ))}
        </div>
    );
}

function PartyCard({ doc, status }: Readonly<{ doc: BillingDoc; status: string }>) {
    const p = doc.party;
    const small = 'text-xs text-gray-700 dark:text-gray-300 mt-1';
    return (
        <div className="flex justify-between items-start mb-5 gap-3">
            <div className="min-w-0">
                <h3 className="text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-widest mb-1">{doc.kind === 'challan' ? 'Consignee' : 'Bill to'}</h3>
                <p className="font-serif text-lg text-gray-900 dark:text-white">{p.name || '-'}</p>
                {p.gstin && <p className={small}>GSTIN {p.gstin}</p>}
                {p.phone && <p className={`${small} flex items-center gap-1.5`}><Phone size={11} className="text-gold-500 shrink-0" />{p.phone}</p>}
                {p.email && <p className={`${small} flex items-center gap-1.5 break-all`}><Mail size={11} className="text-gold-500 shrink-0" />{p.email}</p>}
                {p.address && <p className={`${small} flex items-start gap-1.5 whitespace-pre-line`}><MapPin size={11} className="text-gold-500 shrink-0 mt-0.5" />{p.address}</p>}
            </div>
            <div className="text-right shrink-0">
                <h3 className="text-[11px] font-bold text-gray-700 dark:text-gray-300 uppercase tracking-widest mb-1">Status</h3>
                <StatusBadge text={status} />
            </div>
        </div>
    );
}

function DocPreview({ doc, status }: Readonly<{ doc: BillingDoc; status: string }>) {
    const { settings: s } = useBilling();
    const totals = docTotals(doc, s);
    const mode = taxModeOf(doc, sellerOf(doc, s));
    return (
        <div className="neu-raised p-5 lg:p-6 rounded-lg">
            <PartyCard doc={doc} status={status} />
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 mb-5">
                {detailRows(doc, s).map(([k, v]) => (
                    <div key={k} className="min-w-0">
                        <dt className="text-[10px] uppercase tracking-wider text-gray-600 dark:text-gray-400">{k}</dt>
                        <dd className="text-xs text-gray-900 dark:text-gray-100 truncate">{v}</dd>
                    </div>
                ))}
            </dl>
            <div className="neu-divider w-full mb-4" />
            <h3 className="text-[11px] font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest mb-3">Items</h3>
            <div className="space-y-3 mb-5">
                {doc.lines.map((l, i) => (
                    <div key={l.key} className="flex justify-between gap-3">
                        <div className="min-w-0">
                            <p className="font-serif text-sm text-gray-900 dark:text-white">{l.description}</p>
                            {l.detail && <p className="text-[11px] text-gray-600 dark:text-gray-400 truncate">{l.detail}</p>}
                            <p className="text-[11px] text-gray-600 dark:text-gray-400">{lineSummary(l, mode, doc.kind === 'challan')}</p>
                        </div>
                        <p className="font-medium text-sm text-gray-900 dark:text-white shrink-0">{rupeesText(totals.lines[i]?.total ?? 0)}</p>
                    </div>
                ))}
            </div>
            <div className="neu-divider w-full mb-3" />
            <TotalsBlock totals={totals} mode={mode} pos={doc.placeOfSupply} />
        </div>
    );
}

function PaymentsCard({ doc, balance }: Readonly<{ doc: BillingDoc; balance: Balance }>) {
    const b = useBilling();
    const figures: [string, number][] = [['Invoice', balance.total], ['Credit notes', balance.debited - balance.credited], ['Received', balance.paid], ['Balance due', balance.due]];
    return (
        <CardSection title="Payments">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                {figures.map(([k, v]) => (
                    <div key={k}><p className="text-[10px] uppercase tracking-wider text-gray-600 dark:text-gray-400">{k}</p><p className="font-medium text-gray-900 dark:text-white">{rupeesText(v)}</p></div>
                ))}
            </div>
            {doc.payments.length > 0 && (
                <ul className="space-y-2">
                    {doc.payments.map(p => (
                        <li key={p.id} className="neu-inset rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs">
                            <span className="text-gray-700 dark:text-gray-300">{[shortDate(p.date), p.mode, p.reference].filter(Boolean).join(' · ')}</span>
                            <span className="flex items-center gap-2">
                                <span className="font-medium text-gray-900 dark:text-white">{rupeesText(p.amountPaise)}</span>
                                {b.canEdit && (
                                    <button type="button" aria-label="Remove payment" onClick={run(() => b.removePayment(doc.id, p.id))} className="text-gray-500 hover:text-red-600">
                                        <XCircle size={14} />
                                    </button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </CardSection>
    );
}

function LinkedCard({ docs, onOpen }: Readonly<{ docs: BillingDoc[]; onOpen: (id: string) => void }>) {
    const now = Date.now();
    return (
        <CardSection title="Linked documents">
            <div className="flex flex-wrap gap-2">
                {docs.map(d => (
                    <button key={d.id} type="button" onClick={() => onOpen(d.id)} className="neu-pill text-[11px]">
                        {KIND_LABEL[d.kind]} {d.number || '(draft)'} · {displayStatus(d, now)}
                    </button>
                ))}
            </div>
        </CardSection>
    );
}

function HistoryCard({ doc }: Readonly<{ doc: BillingDoc }>) {
    return (
        <CardSection title="History">
            <ol className="space-y-1.5">
                {[...doc.history].reverse().map(h => (
                    <li key={`${h.at}-${h.text}`} className="text-[12px] text-gray-700 dark:text-gray-300 flex justify-between gap-3">
                        <span>{h.text}</span>
                        <span className="text-gray-500 shrink-0">{new Date(h.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </li>
                ))}
            </ol>
        </CardSection>
    );
}

export function DocDetail({ doc, onClose, onEdit, onOpen, onSetup, onCollectPayment }: Readonly<{
    doc: BillingDoc;
    onClose: () => void;
    onEdit: (doc: BillingDoc) => void;
    onOpen: (id: string) => void;
    onSetup: (section: SettingsSection) => void;
    onCollectPayment?: () => void;
}>) {
    const b = useBilling();
    const s = b.settings;
    const [modal, setModal] = useState<ModalKind | null>(null);
    const title = kindLabel(doc.kind, sellerOf(doc, s).registration);
    const source = doc.sourceId ? b.docs.find(d => d.id === doc.sourceId) : undefined;
    const linked = [...(source ? [source] : []), ...b.docs.filter(d => d.sourceId === doc.id)];
    const balance = doc.kind === 'tax' && doc.status === 'Issued' ? balanceOf(doc, b.docs, s) : null;
    const status = balance?.state ?? displayStatus(doc, Date.now());

    const actions = actionsFor({
        doc, b, title, balance, onClose,
        taxLabel: kindLabel('tax', s.registration).toLowerCase(),
        openModal: setModal,
        // A duplicate is a fresh draft of the same kind, not linked to this one.
        convert: kind => onEdit(kind === doc.kind ? { ...convertDoc(doc, kind, s, Date.now()), sourceId: undefined, reference: '' } : convertDoc(doc, kind, s, Date.now())),
        // Payment links live in Payments, where the server works out what is still to collect.
        paymentLink: (paise, what) => {
            toast(`New payment link: choose ${doc.number || 'this document'} under “For invoice” to collect the ${what} (${rupeesText(paise)}).`, { duration: 6000 });
            onCollectPayment?.();
        },
    });
    const editable = b.canEdit && doc.status !== 'Cancelled';

    return (
        <Sheet title={doc.number || 'Draft'} subtitle={title} onClose={onClose}
            actions={editable && (
                <button type="button" onClick={() => onEdit(doc)} aria-label={`Edit ${title.toLowerCase()}`} className="neu-icon-btn text-gray-700 dark:text-gray-300 active-scale"><Edit2 size={18} /></button>
            )}>
            <PdfButtons doc={doc} source={source} />
            {b.canEdit && actions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {actions.map(a => (
                        <Button key={a.label} type="button" variant={a.variant ?? 'default'} onClick={a.run} icon={<a.Icon size={14} />} className="!py-2 !px-3 text-xs">{a.label}</Button>
                    ))}
                </div>
            )}
            <DocPreview doc={doc} status={status} />
            {balance && <PaymentsCard doc={doc} balance={balance} />}
            {linked.length > 0 && <LinkedCard docs={linked} onOpen={onOpen} />}
            {doc.internalNote && <CardSection title="Internal note"><p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-line">{doc.internalNote}</p></CardSection>}
            {doc.history.length > 0 && <HistoryCard doc={doc} />}
            {doc.status === 'Draft' && doc.kind !== 'proforma' && (
                <p className="text-[11px] text-center text-gray-600 dark:text-gray-400">
                    Drafts have no number yet. Issue it to number and lock it. Missing setup? <button type="button" className="underline text-gold-700 dark:text-gold-300" onClick={() => onSetup('business')}>Open billing setup</button>
                </p>
            )}
            {modal === 'payment' && balance && <PaymentModal docId={doc.id} due={balance.due} onClose={() => setModal(null)} />}
            {modal === 'cancel' && <CancelModal doc={doc} onClose={() => setModal(null)} />}
            {modal === 'return' && <ReturnModal doc={doc} onClose={() => setModal(null)} />}
        </Sheet>
    );
}

function PaymentModal({ docId, due, onClose }: Readonly<{ docId: string; due: number; onClose: () => void }>) {
    const b = useBilling();
    const [amount, setAmount] = useState(String(due / 100));
    const [date, setDate] = useState(dateInput(Date.now()));
    const [mode, setMode] = useState<PaymentMode>('UPI');
    const [reference, setReference] = useState('');
    const submit = () => {
        void attempt(() => b.addPayment(docId, { amountPaise: toPaise(amount), date: fromDateInput(date) ?? Date.now(), mode, reference: reference.trim() }), 'Payment recorded').then(ok => { if (ok) onClose(); });
    };
    return (
        <Modal title="Record payment" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save payment</Button></>}>
            <p className="text-xs text-gray-600 dark:text-gray-400">Balance due {rupeesText(due)}</p>
            <div className="grid grid-cols-2 gap-3">
                <Field label="Amount (₹)" htmlFor="pay-amt"><Input id="pay-amt" type="number" inputMode="decimal" min={0} value={amount} onChange={e => setAmount(e.target.value)} /></Field>
                <Field label="Date" htmlFor="pay-date"><Input id="pay-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
                <Field label="Mode" htmlFor="pay-mode"><Select id="pay-mode" value={mode} onChange={e => setMode(e.target.value as PaymentMode)}>{PAYMENT_MODES.map(m => <option key={m}>{m}</option>)}</Select></Field>
                <Field label="Reference" htmlFor="pay-ref"><Input id="pay-ref" value={reference} onChange={e => setReference(e.target.value)} placeholder="UTR, cheque No.…" /></Field>
            </div>
        </Modal>
    );
}

function CancelModal({ doc, onClose }: Readonly<{ doc: BillingDoc; onClose: () => void }>) {
    const b = useBilling();
    const [reason, setReason] = useState('');
    return (
        <Modal title={`Cancel ${doc.number}`} onClose={onClose}
            footer={<><Button onClick={onClose}>Keep it</Button><Button variant="danger" onClick={() => { void attempt(() => b.cancelDoc(doc.id, reason), 'Cancelled').then(ok => { if (ok) onClose(); }); }}>Cancel document</Button></>}>
            <p className="text-xs text-gray-600 dark:text-gray-400">The number stays on record and the PDF shows CANCELLED. This can’t be undone.</p>
            <Field label="Reason *" htmlFor="cancel-reason"><Textarea id="cancel-reason" rows={2} className="resize-none" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Wrong customer details" /></Field>
        </Modal>
    );
}

function ReturnModal({ doc, onClose }: Readonly<{ doc: BillingDoc; onClose: () => void }>) {
    const b = useBilling();
    const [back, setBack] = useState<Record<string, string>>(() => Object.fromEntries(doc.lines.map(l => [l.key, String(l.returnedQty ?? 0)])));
    const submit = () => {
        const returned = Object.fromEntries(Object.entries(back).map(([k, v]) => [k, Number(v) || 0]));
        void attempt(() => b.recordReturn(doc.id, returned), 'Return recorded').then(ok => { if (ok) onClose(); });
    };
    return (
        <Modal title="Record return" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save</Button></>}>
            <p className="text-xs text-gray-600 dark:text-gray-400">How many of each item are back in total.</p>
            {doc.lines.map(l => (
                <div key={l.key} className="flex items-center justify-between gap-3">
                    <label htmlFor={`ret-${l.key}`} className="text-sm text-gray-800 dark:text-gray-200 min-w-0 truncate">{l.description} <span className="text-gray-500">(of {l.qty})</span></label>
                    <div className="flex items-center gap-2 shrink-0">
                        <Input id={`ret-${l.key}`} type="number" min={l.returnedQty ?? 0} max={l.qty} value={back[l.key]} onChange={e => setBack({ ...back, [l.key]: e.target.value })} className="!w-20" />
                        <button type="button" className="neu-pill text-[11px]" onClick={() => setBack({ ...back, [l.key]: String(l.qty) })}>All</button>
                    </div>
                </div>
            ))}
        </Modal>
    );
}
