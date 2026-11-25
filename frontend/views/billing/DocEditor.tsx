// New / edit form for every billing document. Drafts edit everything; an
// issued document only opens the fields GST lets change afterwards.

import React, { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Loader2, Plus, Trash2, X, AlertTriangle, Lock, ChevronDown } from 'lucide-react';
import { Field, Input, Select, Textarea, ToggleRow, Button, Pill } from '../../components/ui';
import { ArtworkPicker } from '../../components/ArtworkPicker';
import { ContactSuggest } from '../../components/ContactSuggest';
import { TypeDeleteDialog } from '../../components/TypeDeleteDialog';
import { editionLabel, stockOf, type Artwork, type Contact } from '../../types';
import { useBilling, type BillingApi } from './billingContext';
import {
    currentSeller, docTotals, isLocked, ISSUED_KINDS, issueProblems, kindLabel, problemField, PURPOSE_LABEL, RETURNABLE, stateOfGstin,
    SUPPLY_LABEL, taxModeOf, type BillingDoc, type BillingSettings, type ChallanPurpose, type DocLine, type Party, type SupplyType, type Transport,
} from '../../invoicing';
import { amountInWords, GST_RATES, gstinProblem, rupeesText, sgstLabel, stateLabel, STATES, toPaise, type TaxMode } from '../../gstRules';
import { attempt, CardSection, dateInput, fromDateInput, Sheet } from './parts';
import { PhotoAttachments } from '../../components/PhotoAttachments';
import { MAX_PHOTOS } from '../../salesRules';
import type { SettingsSection } from './SettingsSheet';

/** Goods worth more than this (₹50,000, in paise) usually need an e-way bill to move. */
const EWAY_LIMIT = 5_000_000;
const UNITS = ['Nos', 'Pcs', 'Set', 'Sq ft', 'Hrs', 'Job', 'Lot'];
const CHARGES = ['Packing', 'Framing', 'Freight', 'Insurance', 'Installation'];
const NOTE_REASONS = ['Sales return', 'Discount after sale', 'Price correction', 'Deficiency in service', 'Other'];

/** Plain-words meanings behind the "?" next to GST terms. */
const HELP = {
    gstin: 'The customer’s 15-character GST number. Only registered businesses have one; leave it empty for a private buyer.',
    pos: 'The state the goods are delivered to. Same state as you: CGST + SGST. Another state: IGST.',
    hsn: 'A code that tells GST what was sold. 9701 is paintings; services such as framing use a SAC code (9988…).',
    gst: 'The tax rate on this item. Check it with your CA if unsure.',
    supply: 'A normal sale in India, or an export / SEZ sale, which is taxed differently.',
    eway: 'A permit from the GST e-way bill portal, needed to move goods worth over ₹50,000 by vehicle.',
    irn: 'The Invoice Reference Number from the e-invoice portal. Only for businesses with turnover above ₹5 crore.',
};

/** A section that folds away, open when it holds something that needs a look. */
function Fold({ title, summary, open, children }: Readonly<{ title: string; summary?: string; open?: boolean; children?: React.ReactNode }>) {
    return (
        <details className="neu-card p-4 lg:p-5 group" open={open}>
            <summary className="cursor-pointer select-none list-none flex items-center justify-between gap-2 font-semibold">
                <span className="min-w-0">{title}{summary && <span className="block text-[11px] font-normal text-gray-600 dark:text-gray-400 truncate">{summary}</span>}</span>
                <ChevronDown size={16} className="transition-transform group-open:rotate-180 shrink-0" aria-hidden />
            </summary>
            <div className="mt-3 space-y-4">{children}</div>
        </details>
    );
}

const artworkDetail = (a: Artwork): string => [
    [a.artist, a.artworkYear].filter(Boolean).join(', '),
    [a.medium, a.dimensions].filter(Boolean).join(', '),
    [a.customId ? `Ref ${a.customId}` : '', editionLabel(a.edition)].filter(Boolean).join(', '),
].filter(Boolean).join(' · ');

/** A document line for an inventory piece, with the setup's HSN and GST for art. */
export const artworkLine = (a: Artwork, s: BillingSettings): DocLine => ({
    key: crypto.randomUUID(), artworkId: a.id, description: a.title, detail: artworkDetail(a), hsn: s.defaultHsnArt,
    qty: 1, unit: 'Nos', ratePaise: Math.round(a.price * 100), discountPct: 0, gstRate: s.defaultGstArt,
});

function StateSelect({ id, value, onChange, foreign = false, disabled }: Readonly<{ id: string; value: string; onChange: (v: string) => void; foreign?: boolean; disabled?: boolean }>) {
    return (
        <Select id={id} value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>
            <option value="">Choose state…</option>
            {STATES.filter(st => foreign || st.code !== '96').map(st => <option key={st.code} value={st.code}>{st.name} ({st.code})</option>)}
        </Select>
    );
}

/** Party edits also move the place of supply with the delivery state, until it is picked by hand. */
function withParty(prev: BillingDoc, patch: Partial<Party>, posTouched: boolean): BillingDoc {
    const party = { ...prev.party, ...patch };
    if (posTouched || prev.supplyType !== 'regular') return { ...prev, party };
    const delivery = party.sameShipping ? party.state : party.shipState || party.state;
    return { ...prev, party, placeOfSupply: delivery || prev.placeOfSupply };
}

/** A saved contact fills what it has; GSTIN, state and address come from that customer's latest document. */
function partyFromContact(c: Contact, docs: readonly BillingDoc[], selfId: string): Partial<Party> {
    const digits = (v: string) => v.replaceAll(/\D/g, '').slice(-10);
    const phoneMatch = (p: Party) => !!c.phone && digits(p.phone) === digits(c.phone);
    const emailMatch = (p: Party) => !!c.email && p.email.toLowerCase() === c.email.toLowerCase();
    const last = docs.filter(x => x.id !== selfId && (phoneMatch(x.party) || emailMatch(x.party) || x.party.name === c.name))
        .sort((x, y) => y.date - x.date)[0]?.party;
    const known = last ? { gstin: last.gstin, state: last.state, address: last.address, pincode: last.pincode } : {};
    return { name: c.name, phone: c.phone || '', email: c.email || '', ...known };
}

/** A typed-in line; `service` (framing, packing…) takes the setup's SAC and service GST. */
function blankLine(s: BillingSettings, key: string, description: string, service: boolean): DocLine {
    return service
        ? { key, artworkId: '', description, detail: '', hsn: s.defaultSacService, qty: 1, unit: 'Job', ratePaise: 0, discountPct: 0, gstRate: s.defaultGstService }
        : { key, artworkId: '', description, detail: '', hsn: s.defaultHsnArt, qty: 1, unit: 'Nos', ratePaise: 0, discountPct: 0, gstRate: s.defaultGstArt };
}

function modeTextOf(mode: TaxMode, d: BillingDoc): string {
    if (mode === 'intra') return `CGST + ${sgstLabel(d.placeOfSupply)}: customer in the same state`;
    if (mode === 'inter') return 'IGST: customer in another state, export or SEZ';
    if (mode === 'zero') return 'Zero-rated under LUT: no tax charged';
    return d.kind === 'challan' ? 'Values only, no tax on this challan' : 'Bill of supply: no tax charged';
}

/** Saves, then (when asked) issues. Answers with the document as it ended up, or undefined when the save failed. */
async function persist(b: BillingApi, d: BillingDoc, issue: boolean, title: string): Promise<BillingDoc | undefined> {
    let saved: BillingDoc | undefined;
    if (!await attempt(async () => { saved = await b.saveDoc(d); })) return undefined;
    if (issue && saved) {
        const draft = saved;
        const ok = await attempt(async () => { saved = await b.issueDoc(draft); }, `${title} issued`);
        if (!ok) toast('Saved as a draft.', { icon: '💾' });
    }
    return saved;
}

interface EditorProps {
    initial: BillingDoc;
    onClose: () => void;
    onSaved: (doc: BillingDoc) => void;
    onSetup: (section: SettingsSection) => void;
}

/** The editor's state and actions, shared by its sections. */
function useDocEditor({ initial, onClose, onSaved, onSetup }: EditorProps) {
    const b = useBilling();
    const s = b.settings;
    const [d, setD] = useState<BillingDoc>(initial);
    const [posTouched, setPosTouched] = useState(!!initial.number);
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set());
    // Problems show under their fields once a save or issue was refused, not on a blank form.
    const [showErrors, setShowErrors] = useState(false);
    const locked = isLocked(initial);
    const title = kindLabel(d.kind, s.registration);

    const set = (patch: Partial<BillingDoc>) => setD(prev => ({ ...prev, ...patch }));
    const setTransport = (patch: Partial<Transport>) => setD(prev => ({ ...prev, transport: { ...prev.transport, ...patch } }));
    const setLine = (key: string, patch: Partial<DocLine>) => setD(prev => ({ ...prev, lines: prev.lines.map(l => (l.key === key ? { ...l, ...patch } : l)) }));
    const setParty = (patch: Partial<Party>) => setD(prev => withParty(prev, patch, posTouched));
    // Line changes build on the latest lines, so quick taps never drop one.
    const setLines = (change: (lines: DocLine[]) => DocLine[]) => setD(prev => ({ ...prev, lines: change(prev.lines) }));

    const selectedArt = useMemo(() => new Set(d.lines.map(l => l.artworkId).filter(Boolean)), [d.lines]);
    const toggleArtwork = (id: string) => {
        const a = b.artworks.find(x => x.id === id);
        if (a) setLines(lines => (lines.some(l => l.artworkId === id) ? lines.filter(l => l.artworkId !== id) : [...lines, artworkLine(a, s)]));
    };
    const addLine = (description = '', service = false) => {
        const key = crypto.randomUUID();
        setLines(lines => [...lines, blankLine(s, key, description, service)]);
        requestAnimationFrame(() => document.getElementById(`line-${description ? 'rate' : 'desc'}-${key}`)?.focus());
    };

    const totals = docTotals(d, s);
    const mode = taxModeOf(d, currentSeller(s, d.storeId));
    const problems = locked ? [] : issueProblems(d, s);

    const errors: Record<string, string> = {};
    if (showErrors) for (const p of problems) { const f = problemField(p); if (f) errors[f] = errors[f] ? `${errors[f]} ${p}` : p; }

    const refuse = (missing: string[]) => {
        setShowErrors(true);
        toast.error(missing.length > 1 ? `${missing[0]} (and ${missing.length - 1} more)` : missing[0]);
        const f = missing.map(problemField).find(Boolean) ?? '';
        const line = /^line-(\d+)$/.exec(f);
        const id = line ? `line-desc-${d.lines[Number(line[1])]?.key}` : f;
        // After the re-render that opens folded sections.
        requestAnimationFrame(() => {
            const el = document.getElementById(id);
            el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el?.focus({ preventScroll: true });
        });
    };

    const save = (issue: boolean) => {
        const missing = issue || d.kind === 'proforma' ? problems : problems.filter(p => problemField(p) === 'p-name');
        if (missing.length) return refuse(missing);
        if (uploading.size > 0) return toast.error('Wait for the photos to finish uploading');
        setBusy(true);
        void persist(b, d, issue, title).then(saved => {
            setBusy(false);
            if (saved) onSaved(saved);
        });
    };

    return {
        d, s, b, set, setParty, setTransport, setLine, setLines, setPosTouched, setUploading, toggleArtwork, addLine, selectedArt, totals, mode,
        problems, errors, locked, title, busy, save, confirmDelete, setConfirmDelete, onClose, onSetup,
        modeText: modeTextOf(mode, d),
        isNote: d.kind === 'credit' || d.kind === 'debit',
        source: d.sourceId ? b.docs.find(x => x.id === d.sourceId) : undefined,
        existing: b.docs.some(x => x.id === d.id),
        issuable: ISSUED_KINDS.has(d.kind) && !locked,
        gstinErr: d.party.gstin ? gstinProblem(d.party.gstin) : null,
        pickContact: (c: Contact) => setParty(partyFromContact(c, b.docs, d.id)),
        // Available pieces, plus any already on this document.
        pickable: b.artworks.filter(a => (a.status === 'Available' && stockOf(a) > 0) || selectedArt.has(a.id)),
    };
}

type Editor = ReturnType<typeof useDocEditor>;

export function DocEditor(props: Readonly<EditorProps>) {
    const ed = useDocEditor(props);
    const { d, locked, issuable, busy, save, existing, title, onClose } = ed;
    const verb = existing ? 'Edit' : 'New';
    const sheetTitle = locked ? d.number : `${verb} ${title.toLowerCase()}`;
    return (
        <Sheet title={sheetTitle} subtitle={locked ? 'Issued: only these details can change' : undefined} onClose={onClose} close="close" z="z-[70]"
            actions={issuable && (
                <button type="button" onClick={() => save(false)} disabled={busy}
                    className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs active-scale disabled:opacity-60 flex items-center gap-1">
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    Save draft
                </button>
            )}>
            {locked ? (
                <div className="neu-inset rounded-2xl p-3 flex items-center gap-2 text-[12px] text-gray-700 dark:text-gray-300">
                    <Lock size={14} className="shrink-0" /> Issued documents can’t change their customer, items or amounts. Use a credit or debit note for that.
                </div>
            ) : (
                <>
                    <DocumentSection ed={ed} />
                    <CustomerSection ed={ed} />
                    <ShippingSection ed={ed} />
                    <ItemsSection ed={ed} />
                    <SummarySection ed={ed} />
                    <MoreOptionsSection ed={ed} />
                    <ExportSection ed={ed} />
                </>
            )}
            <DatesSection ed={ed} />
            <TransportSection ed={ed} />
            <EInvoiceSection ed={ed} />
            <NotesSection ed={ed} />
            <ChecklistSection ed={ed} />
            <EditorFooter ed={ed} />
        </Sheet>
    );
}

function DocumentSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, s, set, totals, source, isNote, errors } = ed;
    return (
        <CardSection title="Document">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Date" htmlFor="doc-date"><Input id="doc-date" type="date" value={dateInput(d.date)} onChange={e => set({ date: fromDateInput(e.target.value) ?? d.date })} /></Field>
                {s.stores.length > 1 && (
                    <Field label="Store" htmlFor="doc-store" hint="The seller details, GSTIN and number series come from the store.">
                        <Select id="doc-store" value={d.storeId} onChange={e => set({ storeId: e.target.value })}>
                            {s.stores.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                        </Select>
                    </Field>
                )}
                {d.kind === 'proforma' && <>
                    <Field label="Valid until" htmlFor="doc-valid"><Input id="doc-valid" type="date" value={dateInput(d.validUntil)} onChange={e => set({ validUntil: fromDateInput(e.target.value) })} /></Field>
                    <Field label="Advance requested (₹)" htmlFor="doc-adv" hint={`${s.advancePct}% of the total is ${rupeesText(Math.round(totals.total * s.advancePct / 100))}`}>
                        <div className="flex gap-2">
                            <Input id="doc-adv" type="number" inputMode="decimal" min={0} value={d.advancePaise ? d.advancePaise / 100 : ''} onChange={e => set({ advancePaise: toPaise(e.target.value) || 0 })} />
                            <Button type="button" onClick={() => set({ advancePaise: Math.round(totals.total * s.advancePct / 100) })} className="shrink-0 !px-3 text-xs">{s.advancePct}%</Button>
                        </div>
                    </Field>
                </>}
                {d.kind === 'tax' && (
                    <Field label="Due date" htmlFor="doc-due"><Input id="doc-due" type="date" value={dateInput(d.dueDate)} onChange={e => set({ dueDate: fromDateInput(e.target.value) })} /></Field>
                )}
                {d.kind === 'challan' && <>
                    <Field label="Purpose" htmlFor="doc-purpose" error={errors['doc-purpose']}>
                        <Select id="doc-purpose" value={d.challanPurpose} onChange={e => {
                            const challanPurpose = e.target.value as ChallanPurpose;
                            set({ challanPurpose, challanTax: challanPurpose === 'sale' || challanPurpose === 'transfer' });
                        }}>
                            {(Object.keys(PURPOSE_LABEL) as ChallanPurpose[]).map(k => <option key={k} value={k}>{PURPOSE_LABEL[k]}</option>)}
                        </Select>
                    </Field>
                    {d.challanPurpose && RETURNABLE.has(d.challanPurpose) && (
                        <Field label="Return by" htmlFor="doc-return"><Input id="doc-return" type="date" value={dateInput(d.returnBy)} onChange={e => set({ returnBy: fromDateInput(e.target.value) })} /></Field>
                    )}
                </>}
                {isNote && <>
                    <Field label="Against invoice"><p className="neu-value">{source ? `${source.number} · ${source.party.name}` : 'Missing'}</p></Field>
                    <Field label="Reason *" htmlFor="doc-reason" error={errors['doc-reason']}>
                        <Input id="doc-reason" list="note-reasons" value={d.noteReason ?? ''} onChange={e => set({ noteReason: e.target.value })} placeholder="e.g. Sales return" />
                        <datalist id="note-reasons">{NOTE_REASONS.map(r => <option key={r} value={r} />)}</datalist>
                    </Field>
                </>}
            </div>
            {d.kind === 'challan' && d.challanPurpose === 'transfer' && (
                <p className="text-[12px] text-gold-700 dark:text-gold-300 flex gap-2"><AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    Moving stock to a store with a different GSTIN is a sale between them: issue a tax invoice instead. Same GSTIN: a challan is right.</p>
            )}
            {d.kind === 'challan' && <ToggleRow title="Show tax on the challan" description="For goods moving as part of a sale or transfer." checked={!!d.challanTax} onChange={() => set({ challanTax: !d.challanTax })} />}
        </CardSection>
    );
}

/** What most bills never touch: reference, supply type, GST-inclusive prices, reverse charge. */
function MoreOptionsSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, s, set } = ed;
    const taxed = d.kind !== 'challan' || !!d.challanTax;
    const summary = [
        d.reference && `Ref ${d.reference}`,
        d.kind === 'tax' && d.supplyType !== 'regular' && SUPPLY_LABEL[d.supplyType],
        taxed && (d.priceIncludesTax ? 'Prices include GST' : 'GST added to prices'),
        d.reverseCharge && 'Reverse charge',
    ].filter(Boolean).join(' · ');
    return (
        <Fold title="More options" summary={summary} open={!!d.reference || d.supplyType !== 'regular' || d.reverseCharge || d.priceIncludesTax !== s.pricesIncludeTax}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Reference" htmlFor="doc-ref" hint="PO number, order, earlier document…"><Input id="doc-ref" value={d.reference} onChange={e => set({ reference: e.target.value })} maxLength={80} /></Field>
                {d.kind === 'tax' && (
                    <Field label="Supply type" htmlFor="doc-supply" help={HELP.supply}>
                        <Select id="doc-supply" value={d.supplyType} onChange={e => {
                            const supplyType = e.target.value as SupplyType;
                            set({ supplyType, placeOfSupply: supplyType.startsWith('export') ? '96' : d.party.state || d.placeOfSupply });
                        }}>
                            {(Object.keys(SUPPLY_LABEL) as SupplyType[]).map(k => <option key={k} value={k}>{SUPPLY_LABEL[k]}</option>)}
                        </Select>
                    </Field>
                )}
            </div>
            <div className="space-y-1">
                {taxed && <ToggleRow title="Prices include GST" description="Rates you type already include tax; the taxable value is worked out from them." checked={d.priceIncludesTax} onChange={() => set({ priceIncludesTax: !d.priceIncludesTax })} />}
                {d.kind === 'tax' && <ToggleRow title="Reverse charge" description="The buyer pays the GST, not you." checked={d.reverseCharge} onChange={() => set({ reverseCharge: !d.reverseCharge })} />}
            </div>
        </Fold>
    );
}

function CustomerSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, b, setParty, gstinErr, pickContact, errors } = ed;
    return (
        <CardSection title={d.kind === 'challan' ? 'Consignee' : 'Customer'} hint={d.kind === 'proforma' ? 'Name, plus a phone number or email.' : 'Add the GSTIN for a registered business (B2B).'}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name *" htmlFor="p-name" className="sm:col-span-2" error={errors['p-name']}>
                    <ContactSuggest contacts={b.contacts} query={d.party.name} onPick={pickContact}>
                        {p => <input id="p-name" className="neu-field" value={d.party.name} onChange={e => setParty({ name: e.target.value })} placeholder="Customer or business name" {...p} />}
                    </ContactSuggest>
                </Field>
                <Field label="Phone" htmlFor="p-phone" error={errors['p-phone']}>
                    <ContactSuggest contacts={b.contacts} query={d.party.phone} onPick={pickContact}>
                        {p => <input id="p-phone" type="tel" className="neu-field" value={d.party.phone} onChange={e => setParty({ phone: e.target.value })} placeholder="+91 98765 43210" {...p} />}
                    </ContactSuggest>
                </Field>
                <Field label="Email" htmlFor="p-email"><Input id="p-email" type="email" value={d.party.email} onChange={e => setParty({ email: e.target.value })} placeholder="name@example.com" /></Field>
                <Field label="GSTIN" htmlFor="p-gstin" help={HELP.gstin} error={errors['p-gstin']} hint={gstinErr ?? (d.party.gstin ? 'Valid GSTIN ✓' : 'Leave empty for a customer without GST (B2C).')}>
                    <Input id="p-gstin" value={d.party.gstin} maxLength={15} aria-invalid={!!gstinErr}
                        onChange={e => {
                            const gstin = e.target.value.toUpperCase().replaceAll(/\s/g, '');
                            const st = gstin.length === 15 && !gstinProblem(gstin) ? stateOfGstin(gstin) : '';
                            setParty({ gstin, ...(st ? { state: st } : {}) });
                        }} placeholder="27ABCDE1234F1Z5" className={gstinErr ? '!ring-1 !ring-red-400' : ''} />
                </Field>
                <Field label={d.kind === 'proforma' ? 'State' : 'State *'} htmlFor="p-state" error={errors['p-state']}><StateSelect id="p-state" value={d.party.state} onChange={v => setParty({ state: v })} /></Field>
                <Field label="Billing address" htmlFor="p-addr" className="sm:col-span-2"><Textarea id="p-addr" rows={2} className="resize-none" value={d.party.address} onChange={e => setParty({ address: e.target.value })} /></Field>
                <Field label="PIN code" htmlFor="p-pin"><Input id="p-pin" inputMode="numeric" maxLength={6} value={d.party.pincode} onChange={e => setParty({ pincode: e.target.value.replaceAll(/\D/g, '') })} /></Field>
            </div>
        </CardSection>
    );
}

/** Shipping and place of supply fold away: the place follows the customer's state on its own. */
function ShippingSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, setParty, modeText, setPosTouched, errors } = ed;
    const where = d.party.sameShipping ? 'Ships to the billing address' : `Ships to ${d.party.shipName || d.party.name || 'another address'}`;
    return (
        <Fold title="Shipping & place of supply" summary={`${where} · ${stateLabel(d.placeOfSupply) || 'no place of supply yet'}`} open={!d.party.sameShipping || !!errors['p-pos']}>
            <ToggleRow title="Ship to the same address" checked={d.party.sameShipping} onChange={() => setParty({ sameShipping: !d.party.sameShipping })} />
            {!d.party.sameShipping && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Ship to name" htmlFor="p-sname"><Input id="p-sname" value={d.party.shipName} onChange={e => setParty({ shipName: e.target.value })} placeholder={d.party.name} /></Field>
                    <Field label="Ship to state" htmlFor="p-sstate"><StateSelect id="p-sstate" value={d.party.shipState} onChange={v => setParty({ shipState: v })} /></Field>
                    <Field label="Shipping address" htmlFor="p-saddr" className="sm:col-span-2"><Textarea id="p-saddr" rows={2} className="resize-none" value={d.party.shipAddress} onChange={e => setParty({ shipAddress: e.target.value })} /></Field>
                    <Field label="PIN code" htmlFor="p-spin"><Input id="p-spin" inputMode="numeric" maxLength={6} value={d.party.shipPincode} onChange={e => setParty({ shipPincode: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                </div>
            )}
            <Field label="Place of supply *" htmlFor="p-pos" hint={modeText} help={HELP.pos} error={errors['p-pos']}>
                <StateSelect id="p-pos" foreign value={d.placeOfSupply} onChange={v => { setPosTouched(true); set({ placeOfSupply: v }); }} />
            </Field>
        </Fold>
    );
}

function ItemsSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, setLine, setLines, totals, mode, isNote, selectedArt, toggleArtwork, addLine, pickable, setUploading, errors } = ed;
    return (
        <CardSection title="Items" actions={<span className="text-[11px] neu-inset px-2 py-0.5 rounded-[3px] text-gray-600 dark:text-gray-300 uppercase tracking-wider">{d.lines.length} lines</span>}>
            {!isNote && (
                <ArtworkPicker artworks={pickable} selected={selectedArt} onToggle={toggleArtwork} scroll statusFilters={false}
                    searchPlaceholder="Search available pieces…" detail={a => `₹${a.price.toLocaleString('en-IN')}${a.plusGst ? ' + GST' : ''}`} />
            )}
            <datalist id="billing-units">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
            {d.lines.map((l, i) => (
                <LineEditor key={l.key} line={l} index={i} total={totals.lines[i]?.total ?? 0} taxed={mode !== 'none'} challan={d.kind === 'challan'} error={errors[`line-${i}`]}
                    onChange={patch => setLine(l.key, patch)} onRemove={() => setLines(lines => lines.filter(x => x.key !== l.key))}
                    onUploading={busy => setUploading(prev => {
                        const next = new Set(prev);
                        if (busy) next.add(l.key); else next.delete(l.key);
                        return next;
                    })} />
            ))}
            {errors.items && <p id="items" tabIndex={-1} className="text-[11px] text-red-600 dark:text-red-400">{errors.items}</p>}
            <div className="flex flex-wrap gap-2 items-center">
                <Button type="button" onClick={() => addLine()} icon={<Plus size={14} />} className="!py-2 text-xs">Item not in inventory</Button>
                {!isNote && CHARGES.map(c => <Pill key={c} onClick={() => addLine(c, true)}>+ {c}</Pill>)}
            </div>
        </CardSection>
    );
}

function SummarySection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, totals, mode } = ed;
    return (
        <CardSection title="Summary">
            {/* A challan just records value moved; keep the field only if an old one already has a discount. */}
            {(d.kind !== 'challan' || d.billDiscountPaise > 0) && <Field label="Discount on the whole bill (₹)" htmlFor="doc-billdisc" hint="Spread over the items before tax, as GST requires.">
                <Input id="doc-billdisc" type="number" inputMode="decimal" min={0} value={d.billDiscountPaise ? d.billDiscountPaise / 100 : ''} onChange={e => set({ billDiscountPaise: Math.max(0, toPaise(e.target.value) || 0) })} />
            </Field>}
            <TotalsBlock totals={totals} mode={mode} pos={d.placeOfSupply} />
        </CardSection>
    );
}

function ExportSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, errors } = ed;
    if (d.kind !== 'tax' || d.supplyType === 'regular') return null;
    return (
            <CardSection title="Export / SEZ details">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([['lutNo', 'LUT / bond number'], ['currency', 'Currency'], ['exchangeRate', 'Exchange rate (₹)'], ['portCode', 'Port code'], ['shippingBillNo', 'Shipping bill No.'], ['shippingBillDate', 'Shipping bill date']] as const).map(([k, label]) => (
                        <Field key={k} label={label} htmlFor={`ex-${k}`} error={errors[`ex-${k}`]}>
                            <Input id={`ex-${k}`} type={k === 'shippingBillDate' ? 'date' : 'text'} value={d.exportInfo[k]} onChange={e => set({ exportInfo: { ...d.exportInfo, [k]: e.target.value } })} />
                        </Field>
                    ))}
                </div>
            </CardSection>
    );
}

function DatesSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, locked } = ed;
    if (!locked || (d.kind !== 'tax' && d.kind !== 'challan')) return null;
    return (
            <CardSection title="Dates">
                {d.kind === 'tax' && <Field label="Due date" htmlFor="doc-due2"><Input id="doc-due2" type="date" value={dateInput(d.dueDate)} onChange={e => set({ dueDate: fromDateInput(e.target.value) })} /></Field>}
                {d.kind === 'challan' && <Field label="Return by" htmlFor="doc-ret2"><Input id="doc-ret2" type="date" value={dateInput(d.returnBy)} onChange={e => set({ returnBy: fromDateInput(e.target.value) })} /></Field>}
            </CardSection>
    );
}

function TransportSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, setTransport, totals } = ed;
    if (d.kind !== 'tax' && d.kind !== 'challan') return null;
    const needsEway = totals.total > EWAY_LIMIT && !d.ewayBillNo;
    // Starts open when something is filled in or an e-way bill is likely needed.
    const filled = !!d.ewayBillNo || Object.values(d.transport).some(Boolean);
    return (
        <Fold title="Transport & e-way bill" summary={needsEway ? 'Goods worth over ₹50,000 moving by vehicle usually need an e-way bill.' : undefined} open={filled || needsEway}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Mode" htmlFor="tr-mode">
                        <Select id="tr-mode" value={d.transport.mode} onChange={e => setTransport({ mode: e.target.value as Transport['mode'] })}>
                            <option value="">-</option>
                            {['Road', 'Rail', 'Air', 'Ship', 'Courier', 'Hand delivery'].map(m => <option key={m}>{m}</option>)}
                        </Select>
                    </Field>
                    <Field label="Transporter" htmlFor="tr-name"><Input id="tr-name" value={d.transport.transporter} onChange={e => setTransport({ transporter: e.target.value })} /></Field>
                    <Field label="Vehicle No." htmlFor="tr-veh"><Input id="tr-veh" value={d.transport.vehicleNo} onChange={e => setTransport({ vehicleNo: e.target.value.toUpperCase() })} placeholder="MH01AB1234" /></Field>
                    <Field label="LR / docket No." htmlFor="tr-lr"><Input id="tr-lr" value={d.transport.lrNo} onChange={e => setTransport({ lrNo: e.target.value })} /></Field>
                    <Field label="Dispatch date" htmlFor="tr-date"><Input id="tr-date" type="date" value={d.transport.dispatchDate} onChange={e => setTransport({ dispatchDate: e.target.value })} /></Field>
                    <Field label="E-way bill No." htmlFor="tr-eway" help={HELP.eway}><Input id="tr-eway" inputMode="numeric" value={d.ewayBillNo} onChange={e => set({ ewayBillNo: e.target.value.replaceAll(/\D/g, '').slice(0, 12) })} /></Field>
                </div>
        </Fold>
    );
}

function EInvoiceSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, isNote } = ed;
    if (d.kind !== 'tax' && !isNote) return null;
    return (
            <Fold title="E-invoice" summary={d.irn ? `IRN ${d.irn.slice(0, 12)}…` : 'Only if your turnover is above ₹5 crore'} open={!!d.irn}>
                <p className="text-[11px] text-gray-600 dark:text-gray-400">Paste the IRN details from the e-invoice portal.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="IRN" htmlFor="ei-irn" className="sm:col-span-2" help={HELP.irn}><Input id="ei-irn" value={d.irn} maxLength={64} onChange={e => set({ irn: e.target.value.trim() })} /></Field>
                    <Field label="Ack No." htmlFor="ei-ack"><Input id="ei-ack" value={d.ackNo} onChange={e => set({ ackNo: e.target.value })} /></Field>
                    <Field label="Ack date" htmlFor="ei-ackd"><Input id="ei-ackd" type="date" value={d.ackDate} onChange={e => set({ ackDate: e.target.value })} /></Field>
                </div>
            </Fold>
    );
}

function NotesSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, set, locked } = ed;
    return (
        <Fold title="Notes">
            {!locked && <>
                <Field label="Notes (printed)" htmlFor="doc-notes"><Textarea id="doc-notes" rows={2} className="resize-none" value={d.notes} onChange={e => set({ notes: e.target.value })} /></Field>
                {d.kind !== 'challan' && <Field label="Terms & conditions (printed)" htmlFor="doc-terms"><Textarea id="doc-terms" rows={3} className="resize-none" value={d.terms} onChange={e => set({ terms: e.target.value })} /></Field>}
            </>}
            <Field label="Internal note" htmlFor="doc-internal" hint="Only your team sees this. Never printed."><Textarea id="doc-internal" rows={2} className="resize-none" value={d.internalNote} onChange={e => set({ internalNote: e.target.value })} /></Field>
        </Fold>
    );
}

function ChecklistSection({ ed }: Readonly<{ ed: Editor }>) {
    const { d, problems, onSetup, locked } = ed;
    const unplaced = problems.filter(p => !problemField(p));
    if (locked || unplaced.length === 0) return null;
    return (
            <CardSection title={d.kind === 'proforma' ? 'Before saving' : 'Before issuing'}>
                <ul className="space-y-1.5 text-[12px] text-gray-700 dark:text-gray-300">
                    {unplaced.map(p => <li key={p} className="flex gap-2"><AlertTriangle size={13} className="text-gold-600 shrink-0 mt-0.5" />{p}</li>)}
                </ul>
                {unplaced.includes('Finish billing setup first.') && <Button type="button" onClick={() => onSetup('business')}>Open billing setup</Button>}
            </CardSection>
    );
}

function EditorFooter({ ed }: Readonly<{ ed: Editor }>) {
    const { d, b, problems, issuable, title, busy, save, existing, confirmDelete, setConfirmDelete, onClose, totals, locked } = ed;
    const left = issuable || d.kind === 'proforma' ? problems.length : 0;
    let label = 'Save';
    if (issuable) label = 'Save & issue';
    else if (!locked) label = `Save ${title.toLowerCase()}`;
    return (
        <>
            {/* Total and the one main button stay in reach while scrolling. Negative bottom cancels the sheet's bottom padding, so the bar meets the screen edge. */}
            <div className="sticky bottom-[calc(-6rem-var(--safe-bottom-ui))] lg:-bottom-8 z-10 -mx-3 lg:-mx-6 px-3 lg:px-6 py-3 bg-[var(--neu-bg)] border-t border-[var(--neu-line)] flex items-center gap-3">
                <div className="min-w-0 flex-1">
                    <p className="text-[10px] uppercase tracking-widest text-gray-600 dark:text-gray-400">{left ? `Total · ${left} to fill` : 'Total'}</p>
                    <p className="font-serif text-lg text-brand-900 dark:text-gold-400 truncate">{rupeesText(totals.total)}</p>
                </div>
                <Button variant="primary" disabled={busy} onClick={() => save(issuable)} className="shrink-0">
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null} {label}
                </Button>
            </div>
            {issuable && <p className="text-[11px] text-center text-gray-600 dark:text-gray-400">Issuing gives it the next number and locks it. {!b.online && 'You’re offline: save the draft now and issue it once you’re back online.'}</p>}

            {existing && (d.kind === 'proforma' || d.status === 'Draft') && (
                <button type="button" onClick={() => setConfirmDelete(true)} className="neu-button neu-button-danger w-full">
                    <Trash2 size={14} /> Delete {d.status === 'Draft' && d.kind !== 'proforma' ? 'draft' : title.toLowerCase()}
                </button>
            )}
            <TypeDeleteDialog isOpen={confirmDelete} title={`Delete ${title.toLowerCase()}`} itemName={`${d.number || 'Draft'}: ${d.party.name || 'no customer'}`}
                message="this can’t be undone" onClose={() => setConfirmDelete(false)}
                onConfirm={() => { setConfirmDelete(false); void attempt(() => b.deleteDoc(d.id), 'Deleted').then(ok => { if (ok) onClose(); }); }} />
        </>
    );
}

function LineEditor({ line: l, index, total, taxed, challan, error, onChange, onRemove, onUploading }: {
    readonly line: DocLine; readonly index: number; readonly total: number; readonly taxed: boolean; readonly challan: boolean; readonly error?: string;
    readonly onChange: (patch: Partial<DocLine>) => void; readonly onRemove: () => void; readonly onUploading: (busy: boolean) => void;
}) {
    const id = (f: string) => `line-${f}-${l.key}`;
    const rates = GST_RATES.includes(l.gstRate) ? GST_RATES : [...GST_RATES, l.gstRate].sort((a, z) => a - z);
    return (
        <div className="neu-inset rounded-2xl p-3 space-y-2">
            <div className="flex items-start gap-2">
                <span className="text-[11px] text-gray-500 mt-2.5 w-4 shrink-0">{index + 1}</span>
                <div className="flex-1 min-w-0 space-y-2">
                    <Input id={id('desc')} aria-label="Description" value={l.description} onChange={e => onChange({ description: e.target.value })} placeholder="Description" maxLength={200} />
                    <Input aria-label="Details" value={l.detail} onChange={e => onChange({ detail: e.target.value })} placeholder="Details (artist, medium, size…)" maxLength={240} className="!text-xs" />
                </div>
                <button type="button" onClick={onRemove} aria-label={`Remove ${l.description || 'line'}`} className="neu-icon-btn text-gray-600 dark:text-gray-300 active-scale shrink-0"><X size={16} /></button>
            </div>
            <div className="grid grid-cols-3 gap-2 pl-6">
                <Field label="Qty" htmlFor={id('qty')}><Input id={id('qty')} type="number" inputMode="decimal" min={0} step="any" value={l.qty} onChange={e => onChange({ qty: Number(e.target.value) })} /></Field>
                <Field label="Rate (₹)" htmlFor={id('rate')}><Input id={id('rate')} type="number" inputMode="decimal" min={0} step="0.01" value={l.ratePaise / 100} onChange={e => onChange({ ratePaise: toPaise(e.target.value) || 0 })} /></Field>
                <Field label="Disc %" htmlFor={id('disc')}><Input id={id('disc')} type="number" inputMode="decimal" min={0} max={100} value={l.discountPct || ''} onChange={e => onChange({ discountPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
            </div>
            {/* Filled from billing setup; most lines never need these. */}
            <details className="pl-6 group/tax" open={!!error?.includes('HSN')}>
                <summary className="cursor-pointer select-none list-none text-[11px] text-gray-600 dark:text-gray-400 flex items-center gap-1">
                    Tax details: HSN {l.hsn || '-'} · {l.unit}{taxed ? ` · GST ${l.gstRate}%` : ''}
                    <ChevronDown size={12} className="transition-transform group-open/tax:rotate-180" aria-hidden />
                </summary>
                <div className="grid grid-cols-3 gap-2 mt-2">
                    <Field label="HSN/SAC" htmlFor={id('hsn')} help={HELP.hsn}><Input id={id('hsn')} inputMode="numeric" maxLength={8} value={l.hsn} onChange={e => onChange({ hsn: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                    <Field label="Unit" htmlFor={id('unit')}><Input id={id('unit')} list="billing-units" value={l.unit} onChange={e => onChange({ unit: e.target.value })} /></Field>
                    <Field label="GST %" htmlFor={id('gst')} help={HELP.gst}>
                        <Select id={id('gst')} value={l.gstRate} onChange={e => onChange({ gstRate: Number(e.target.value) })} disabled={!taxed}>
                            {rates.map(r => <option key={r} value={r}>{r}%</option>)}
                        </Select>
                    </Field>
                </div>
            </details>
            {error && <p className="pl-6 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
            {!l.artworkId && (
                <div className="pl-6">
                    <PhotoAttachments
                        urls={l.photoUrls ?? []}
                        onAdd={urls => onChange({ photoUrls: [...(l.photoUrls ?? []), ...urls].slice(0, MAX_PHOTOS) })}
                        onRemove={url => onChange({ photoUrls: (l.photoUrls ?? []).filter(u => u !== url) })}
                        onUploadingChange={onUploading}
                    />
                </div>
            )}
            <p className="text-right text-xs text-gray-700 dark:text-gray-300 pr-1">{challan && !taxed ? 'Value' : 'Line total'} <span className="font-medium text-gray-900 dark:text-white">{rupeesText(total)}</span></p>
        </div>
    );
}

export function TotalsBlock({ totals: t, mode, pos }: Readonly<{ totals: ReturnType<typeof docTotals>; mode: ReturnType<typeof taxModeOf>; pos: string }>) {
    const row = (label: string, v: number, strong = false) => (
        <div key={label} className={`flex justify-between ${strong ? 'pt-3 items-center' : 'text-xs text-gray-600 dark:text-gray-400'}`}>
            <span className={strong ? 'font-bold text-gray-900 dark:text-gray-100 uppercase tracking-widest text-[11px]' : ''}>{label}</span>
            <span className={strong ? 'text-xl font-serif text-brand-900 dark:text-gold-400' : 'text-gray-900 dark:text-gray-100'}>{rupeesText(v)}</span>
        </div>
    );
    return (
        <div className="space-y-2">
            {t.discount > 0 && row('Gross', t.gross)}
            {t.discount > 0 && row('Discount', -t.discount)}
            {row(mode === 'none' ? 'Amount' : 'Taxable value', t.taxable)}
            {mode === 'intra' && row('CGST', t.cgst)}
            {mode === 'intra' && row(sgstLabel(pos), t.sgst)}
            {(mode === 'inter' || mode === 'zero') && row('IGST', t.igst)}
            {t.roundOff !== 0 && row('Round off', t.roundOff)}
            {row('Total', t.total, true)}
            <p className="text-[11px] text-gray-600 dark:text-gray-400 text-right italic">{amountInWords(t.total)}</p>
        </div>
    );
}
