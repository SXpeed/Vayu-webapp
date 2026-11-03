// Billing setup (the ⚙ on every Billing tab): business, stores, bank, numbering,
// tax defaults, printing. Every change saves straight away.

import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Plus, Trash2, CheckCircle2, AlertTriangle, Building2, Store, Landmark, Hash, Percent, Printer, SlidersHorizontal, BookOpen, Loader2 } from 'lucide-react';
import { Field, Input, Select, Textarea, ToggleRow, Button, Pill } from '../../components/ui';
import { useBilling } from './billingContext';
import {
    docNumberFor, KIND_LABEL, seriesKeyFor, setupProblems, stateOfGstin,
    type BankAccount, type BillingSettings, type BillingStore, type DocKind, type Registration,
} from '../../invoicing';
import { docNumberProblem, GST_RATES, gstinProblem, nextSeq, STATES } from '../../gstRules';
import { attempt, CardSection, readImage, Sheet } from './parts';

export type SettingsSection = 'business' | 'stores' | 'bank' | 'numbering' | 'tax' | 'print' | 'tally' | 'more';

const SECTIONS: { id: SettingsSection; label: string; Icon: React.ElementType }[] = [
    { id: 'business', label: 'Business', Icon: Building2 },
    { id: 'stores', label: 'Stores', Icon: Store },
    { id: 'bank', label: 'Bank', Icon: Landmark },
    { id: 'numbering', label: 'Numbering', Icon: Hash },
    { id: 'tax', label: 'Tax', Icon: Percent },
    { id: 'print', label: 'Print', Icon: Printer },
    { id: 'tally', label: 'Tally', Icon: BookOpen },
    { id: 'more', label: 'More', Icon: SlidersHorizontal },
];

const REGISTRATION: { id: Registration; label: string; hint: string }[] = [
    { id: 'regular', label: 'Regular GST', hint: 'You issue tax invoices and charge GST.' },
    { id: 'composition', label: 'Composition scheme', hint: 'You issue a Bill of Supply and can’t charge GST.' },
    { id: 'unregistered', label: 'Not registered', hint: 'Bill of Supply, no GSTIN.' },
];

function StateSelect({ id, value, onChange }: Readonly<{ id: string; value: string; onChange: (v: string) => void }>) {
    return (
        <Select id={id} value={value} onChange={e => onChange(e.target.value)}>
            <option value="">Choose state…</option>
            {STATES.filter(s => s.code !== '96').map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
        </Select>
    );
}

function GstinInput({ id, value, onChange }: Readonly<{ id: string; value: string; onChange: (gstin: string, state: string) => void }>) {
    const problem = value ? gstinProblem(value) : null;
    return (
        <Field label="GSTIN" htmlFor={id} hint={problem ?? (value ? 'Valid GSTIN ✓' : undefined)}>
            <Input id={id} value={value} maxLength={15} aria-invalid={!!problem} className={problem ? '!ring-1 !ring-red-400' : ''} placeholder="27ABCDE1234F1Z5"
                onChange={e => {
                    const g = e.target.value.toUpperCase().replaceAll(/\s/g, '');
                    onChange(g, g.length === 15 && !gstinProblem(g) ? stateOfGstin(g) : '');
                }} />
        </Field>
    );
}

function ImagePick({ label, value, onChange }: Readonly<{ label: string; value: string; onChange: (dataUrl: string) => void }>) {
    const id = `img-${label.replaceAll(' ', '-').toLowerCase()}`;
    return (
        <div>
            <span className="neu-label">{label}</span>
            <div className="flex items-center gap-3">
                <div className="w-20 h-14 rounded-lg neu-inset flex items-center justify-center overflow-hidden bg-white">
                    {value ? <img src={value} alt={label} className="max-w-full max-h-full object-contain" /> : <span className="text-[10px] text-gray-500">None</span>}
                </div>
                <label htmlFor={id} className="neu-button !py-2 text-xs cursor-pointer">Choose image</label>
                <input id={id} type="file" accept="image/*" className="sr-only" onChange={async e => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try { onChange(await readImage(f)); } catch { toast.error('That image couldn’t be read.'); }
                }} />
                {value && <button type="button" onClick={() => onChange('')} className="text-xs text-red-600 underline">Remove</button>}
            </div>
        </div>
    );
}

export function SettingsSheet({ initialSection, onClose }: Readonly<{ initialSection: SettingsSection; onClose: () => void }>) {
    const b = useBilling();
    // A draft, saved to the server when the sheet closes (not on every keystroke).
    const [draft, setDraft] = useState<BillingSettings>(b.settings);
    const s = draft;
    const [saving, setSaving] = useState(false);
    const [section, setSection] = React.useState<SettingsSection>(initialSection);
    const set = (patch: Partial<BillingSettings>) => setDraft(prev => ({ ...prev, ...patch }));
    const close = () => {
        if (s === b.settings) return onClose();
        setSaving(true);
        void attempt(() => b.saveSettings(s), 'Billing setup saved').then(ok => {
            setSaving(false);
            if (ok) onClose();
        });
    };
    const problems = setupProblems(s);

    const setStore = (id: string, patch: Partial<BillingStore>) => set({ stores: s.stores.map(st => (st.id === id ? { ...st, ...patch } : st)) });
    const addStore = () => set({
        stores: [...s.stores, { id: crypto.randomUUID(), name: `Store ${s.stores.length + 1}`, code: String.fromCodePoint(65 + s.stores.length), address: '', state: s.state, pincode: '', gstin: s.gstin, phone: '', email: '', bankId: '' }],
    });
    const removeStore = (id: string) => {
        if (b.docs.some(d => d.storeId === id)) return toast.error('Documents were made from this store, so it stays. Rename it instead.');
        set({ stores: s.stores.filter(st => st.id !== id) });
    };

    const setBank = (id: string, patch: Partial<BankAccount>) => set({ banks: s.banks.map(x => (x.id === id ? { ...x, ...patch } : x)) });
    const addBank = () => {
        const id = crypto.randomUUID();
        set({ banks: [...s.banks, { id, label: `Account ${s.banks.length + 1}`, accountName: s.legalName, accountNumber: '', ifsc: '', bankName: '', branch: '', upiId: '' }], defaultBankId: s.defaultBankId || id });
    };

    const now = Date.now();
    // Numbering previews are for the first store when there are several.
    const things = problems.length === 1 ? 'thing' : 'things';
    const progress = problems.length ? `${problems.length} ${things} left before issuing` : 'Ready to issue';
    const firstStore = s.stores.length > 1 ? ` (${s.stores[0].name})` : '';

    return (
        <Sheet title="Billing setup" subtitle={progress} onClose={close} close="close" z="z-[75]"
            actions={<button type="button" onClick={close} disabled={saving} className="text-gold-700 dark:text-gold-300 font-medium px-2 py-2 uppercase tracking-wider text-xs flex items-center gap-1 disabled:opacity-60">
                {saving && <Loader2 size={12} className="animate-spin" />} Done
            </button>}>
            <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 py-0.5">
                {SECTIONS.map(({ id, label, Icon }) => {
                    const missing = problems.some(p => p[0] === id);
                    return (
                        <Pill key={id} active={section === id} onClick={() => setSection(id)} className="shrink-0 flex items-center gap-1.5">
                            <Icon size={13} /> {label}{missing && <span className="w-1.5 h-1.5 rounded-full bg-gold-500" aria-label="needs attention" />}
                        </Pill>
                    );
                })}
            </div>

            {problems.length > 0 ? (
                <div className="neu-inset rounded-2xl p-3 text-[12px] text-gray-700 dark:text-gray-300">
                    <p className="font-semibold mb-1 flex items-center gap-1.5"><AlertTriangle size={13} className="text-gold-600" /> Needed before issuing tax invoices and challans</p>
                    <ul className="list-disc pl-5 space-y-0.5">{problems.map(([sec, p]) => <li key={p}><button type="button" className="underline" onClick={() => setSection(sec as SettingsSection)}>{p}</button></li>)}</ul>
                </div>
            ) : (
                <p className="text-[12px] text-green-700 dark:text-green-400 flex items-center gap-1.5"><CheckCircle2 size={14} /> Billing is set up. You can issue tax invoices and challans.</p>
            )}

            {section === 'business' && <>
                <CardSection title="Business">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="Legal name *" htmlFor="b-legal" hint="As on your GST registration." className="sm:col-span-2"><Input id="b-legal" value={s.legalName} onChange={e => set({ legalName: e.target.value })} /></Field>
                        <Field label="Trade name" htmlFor="b-trade"><Input id="b-trade" value={s.tradeName} onChange={e => set({ tradeName: e.target.value })} /></Field>
                        <Field label="GST registration" htmlFor="b-reg" hint={REGISTRATION.find(r => r.id === s.registration)?.hint}>
                            <Select id="b-reg" value={s.registration} onChange={e => set({ registration: e.target.value as Registration })}>
                                {REGISTRATION.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                            </Select>
                        </Field>
                        {s.registration !== 'unregistered' && <GstinInput id="b-gstin" value={s.gstin} onChange={(gstin, state) => set({ gstin, ...(state ? { state } : {}) })} />}
                        <Field label="PAN" htmlFor="b-pan"><Input id="b-pan" value={s.pan} maxLength={10} onChange={e => set({ pan: e.target.value.toUpperCase() })} /></Field>
                        <Field label="CIN" htmlFor="b-cin" hint="Companies only."><Input id="b-cin" value={s.cin} onChange={e => set({ cin: e.target.value.toUpperCase() })} /></Field>
                        <Field label="Registered address *" htmlFor="b-addr" className="sm:col-span-2"><Textarea id="b-addr" rows={2} className="resize-none" value={s.address} onChange={e => set({ address: e.target.value })} /></Field>
                        <Field label="State *" htmlFor="b-state"><StateSelect id="b-state" value={s.state} onChange={v => set({ state: v })} /></Field>
                        <Field label="PIN code" htmlFor="b-pin"><Input id="b-pin" inputMode="numeric" maxLength={6} value={s.pincode} onChange={e => set({ pincode: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                        <Field label="Phone" htmlFor="b-phone"><Input id="b-phone" type="tel" value={s.phone} onChange={e => set({ phone: e.target.value })} /></Field>
                        <Field label="Email" htmlFor="b-email"><Input id="b-email" type="email" value={s.email} onChange={e => set({ email: e.target.value })} /></Field>
                        <Field label="Website" htmlFor="b-web"><Input id="b-web" value={s.website} onChange={e => set({ website: e.target.value })} /></Field>
                    </div>
                </CardSection>
                <CardSection title="Logo & signature" hint="The logo heads every document; the signature sits above “Authorised Signatory”.">
                    <ImagePick label="Logo" value={s.logoImage} onChange={logoImage => set({ logoImage })} />
                    <Field label="Authorised signatory *" htmlFor="b-sign"><Input id="b-sign" value={s.signatoryName} onChange={e => set({ signatoryName: e.target.value })} placeholder="Name of the person signing" /></Field>
                    <ImagePick label="Signature or seal" value={s.signatureImage} onChange={signatureImage => set({ signatureImage })} />
                </CardSection>
            </>}

            {section === 'stores' && (
                <CardSection title="Stores" hint="Each store bills with its own address, GSTIN, bank and (optionally) its own number series. Documents pick the store they are billed from."
                    actions={<Button type="button" onClick={addStore} icon={<Plus size={14} />} className="!py-1.5 !px-3 text-xs">Add store</Button>}>
                    {s.stores.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No stores: documents use the business details. Add stores if you bill from more than one place.</p>}
                    {s.stores.map(st => {
                        const mismatch = st.gstin && st.state && !gstinProblem(st.gstin) && st.gstin.slice(0, 2) !== st.state;
                        return (
                            <div key={st.id} className="neu-inset rounded-2xl p-3 space-y-3">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <Field label="Store name" htmlFor={`st-name-${st.id}`}><Input id={`st-name-${st.id}`} value={st.name} onChange={e => setStore(st.id, { name: e.target.value })} /></Field>
                                    <Field label="Short code" htmlFor={`st-code-${st.id}`} hint="Added to the number prefix when each store numbers on its own.">
                                        <Input id={`st-code-${st.id}`} value={st.code} maxLength={3} onChange={e => setStore(st.id, { code: e.target.value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '') })} />
                                    </Field>
                                    <GstinInput id={`st-gstin-${st.id}`} value={st.gstin} onChange={(gstin, state) => setStore(st.id, { gstin, ...(state ? { state } : {}) })} />
                                    <Field label="State" htmlFor={`st-state-${st.id}`} hint={mismatch ? 'This GSTIN is registered in another state.' : undefined}><StateSelect id={`st-state-${st.id}`} value={st.state} onChange={v => setStore(st.id, { state: v })} /></Field>
                                    <Field label="Address" htmlFor={`st-addr-${st.id}`} className="sm:col-span-2"><Textarea id={`st-addr-${st.id}`} rows={2} className="resize-none" value={st.address} onChange={e => setStore(st.id, { address: e.target.value })} /></Field>
                                    <Field label="PIN code" htmlFor={`st-pin-${st.id}`}><Input id={`st-pin-${st.id}`} inputMode="numeric" maxLength={6} value={st.pincode} onChange={e => setStore(st.id, { pincode: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                                    <Field label="Phone" htmlFor={`st-phone-${st.id}`}><Input id={`st-phone-${st.id}`} type="tel" value={st.phone} onChange={e => setStore(st.id, { phone: e.target.value })} /></Field>
                                    <Field label="Bank account printed" htmlFor={`st-bank-${st.id}`}>
                                        <Select id={`st-bank-${st.id}`} value={st.bankId} onChange={e => setStore(st.id, { bankId: e.target.value })}>
                                            <option value="">Default account</option>
                                            {s.banks.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                                        </Select>
                                    </Field>
                                </div>
                                <button type="button" onClick={() => removeStore(st.id)} className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1"><Trash2 size={12} /> Remove store</button>
                            </div>
                        );
                    })}
                </CardSection>
            )}

            {section === 'bank' && (
                <CardSection title="Bank & UPI" hint="Printed on proformas and tax invoices so customers know where to pay."
                    actions={<Button type="button" onClick={addBank} icon={<Plus size={14} />} className="!py-1.5 !px-3 text-xs">Add account</Button>}>
                    {s.banks.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No bank account yet.</p>}
                    {s.banks.map(x => (
                        <div key={x.id} className="neu-inset rounded-2xl p-3 space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <Field label="Label" htmlFor={`bk-label-${x.id}`}><Input id={`bk-label-${x.id}`} value={x.label} onChange={e => setBank(x.id, { label: e.target.value })} /></Field>
                                <Field label="Account name" htmlFor={`bk-name-${x.id}`}><Input id={`bk-name-${x.id}`} value={x.accountName} onChange={e => setBank(x.id, { accountName: e.target.value })} /></Field>
                                <Field label="Account number" htmlFor={`bk-no-${x.id}`}><Input id={`bk-no-${x.id}`} inputMode="numeric" value={x.accountNumber} onChange={e => setBank(x.id, { accountNumber: e.target.value.replaceAll(/\s/g, '') })} /></Field>
                                <Field label="IFSC" htmlFor={`bk-ifsc-${x.id}`} hint={x.ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(x.ifsc) ? 'IFSC is 11 characters, like HDFC0000060.' : undefined}>
                                    <Input id={`bk-ifsc-${x.id}`} maxLength={11} value={x.ifsc} onChange={e => setBank(x.id, { ifsc: e.target.value.toUpperCase() })} />
                                </Field>
                                <Field label="Bank" htmlFor={`bk-bank-${x.id}`}><Input id={`bk-bank-${x.id}`} value={x.bankName} onChange={e => setBank(x.id, { bankName: e.target.value })} /></Field>
                                <Field label="Branch" htmlFor={`bk-branch-${x.id}`}><Input id={`bk-branch-${x.id}`} value={x.branch} onChange={e => setBank(x.id, { branch: e.target.value })} /></Field>
                                <Field label="UPI ID" htmlFor={`bk-upi-${x.id}`}><Input id={`bk-upi-${x.id}`} value={x.upiId} onChange={e => setBank(x.id, { upiId: e.target.value.trim() })} placeholder="name@bank" /></Field>
                            </div>
                            <div className="flex items-center justify-between">
                                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
                                    <input type="radio" name="default-bank" checked={s.defaultBankId === x.id} onChange={() => set({ defaultBankId: x.id })} /> Default account
                                </label>
                                <button type="button" onClick={() => set({ banks: s.banks.filter(y => y.id !== x.id), defaultBankId: s.defaultBankId === x.id ? '' : s.defaultBankId })} className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1"><Trash2 size={12} /> Remove</button>
                            </div>
                        </div>
                    ))}
                    <ToggleRow title="Print UPI ID" description="Shown with the bank details. (A scannable UPI QR needs a QR library; see README.)" checked={s.showUpiQr} onChange={() => set({ showUpiQr: !s.showUpiQr })} />
                </CardSection>
            )}

            {section === 'numbering' && (
                <CardSection title="Document numbers" hint="Numbers restart each financial year (April). Tax invoices, challans and notes are numbered when issued and never reused. GST allows 16 characters.">
                    <ToggleRow title="Each store numbers on its own" description="Adds the store code to the prefix (INVM/26-27/0001). Off: one series per GSTIN." checked={s.seriesPerStore} onChange={() => set({ seriesPerStore: !s.seriesPerStore })} />
                    {(Object.keys(KIND_LABEL) as DocKind[]).map(kind => {
                        const storeId = s.stores[0]?.id ?? '';
                        const sample = docNumberFor(s, kind, storeId, now, nextSeq(b.docs, seriesKeyFor(s, kind, storeId, now), s.series[kind].start));
                        const problem = docNumberProblem(sample);
                        return (
                            <div key={kind} className="grid grid-cols-[1fr_6rem_7rem] gap-2 items-end">
                                <Field label={`${KIND_LABEL[kind]} prefix`} htmlFor={`ser-${kind}`} hint={problem ?? `Next${firstStore}: ${sample}`}>
                                    <Input id={`ser-${kind}`} value={s.series[kind].prefix} maxLength={8}
                                        onChange={e => set({ series: { ...s.series, [kind]: { ...s.series[kind], prefix: e.target.value.toUpperCase().replaceAll(/[^A-Z0-9-]/g, '') } } })} />
                                </Field>
                                <Field label="Start at" htmlFor={`ser-start-${kind}`}>
                                    <Input id={`ser-start-${kind}`} type="number" min={1} value={s.series[kind].start}
                                        onChange={e => set({ series: { ...s.series, [kind]: { ...s.series[kind], start: Math.max(1, Math.floor(Number(e.target.value) || 1)) } } })} />
                                </Field>
                                <span className="text-[10px] text-gray-500 pb-3">e.g. continuing from Tally</span>
                            </div>
                        );
                    })}
                </CardSection>
            )}

            {section === 'tax' && (
                <CardSection title="Tax defaults" hint="New lines start with these; every line can be changed. Check rates with your CA.">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="HSN for artworks" htmlFor="t-hsn" hint="9701: paintings, drawings, collages."><Input id="t-hsn" inputMode="numeric" maxLength={8} value={s.defaultHsnArt} onChange={e => set({ defaultHsnArt: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                        <Field label="GST on artworks" htmlFor="t-gst-art"><Select id="t-gst-art" value={s.defaultGstArt} onChange={e => set({ defaultGstArt: Number(e.target.value) })}>{GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</Select></Field>
                        <Field label="SAC for services and charges" htmlFor="t-sac" hint="Framing, packing, installation…"><Input id="t-sac" inputMode="numeric" maxLength={8} value={s.defaultSacService} onChange={e => set({ defaultSacService: e.target.value.replaceAll(/\D/g, '') })} /></Field>
                        <Field label="GST on services" htmlFor="t-gst-svc"><Select id="t-gst-svc" value={s.defaultGstService} onChange={e => set({ defaultGstService: Number(e.target.value) })}>{GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}</Select></Field>
                        <Field label="HSN digits required" htmlFor="t-digits" hint="4 up to ₹5 crore turnover, 6 above.">
                            <Select id="t-digits" value={s.hsnMinDigits} onChange={e => set({ hsnMinDigits: Number(e.target.value) as 4 | 6 | 8 })}>{[4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}</Select>
                        </Field>
                    </div>
                    <ToggleRow title="Prices include GST by default" checked={s.pricesIncludeTax} onChange={() => set({ pricesIncludeTax: !s.pricesIncludeTax })} />
                    <ToggleRow title="Round totals to whole rupees" description="Adds a “Round off” line, like Tally." checked={s.roundOff} onChange={() => set({ roundOff: !s.roundOff })} />
                </CardSection>
            )}

            {section === 'print' && <>
                <CardSection title="Printing">
                    <ToggleRow title="Photos on proformas" checked={s.print.photosOnProforma} onChange={() => set({ print: { ...s.print, photosOnProforma: !s.print.photosOnProforma } })} />
                    <ToggleRow title="Photos on tax invoices" checked={s.print.photosOnInvoice} onChange={() => set({ print: { ...s.print, photosOnInvoice: !s.print.photosOnInvoice } })} />
                    <ToggleRow title="HSN-wise tax summary" checked={s.print.hsnSummary} onChange={() => set({ print: { ...s.print, hsnSummary: !s.print.hsnSummary } })} />
                    <p className="neu-label !mb-0 pt-2">Copies in each PDF</p>
                    {(['original', 'duplicate', 'triplicate'] as const).map(k => (
                        <ToggleRow key={k} title={{ original: 'Original (for recipient / consignee)', duplicate: 'Duplicate (for transporter)', triplicate: 'Triplicate (for supplier / consignor)' }[k]}
                            checked={s.print.copies[k]} onChange={() => set({ print: { ...s.print, copies: { ...s.print.copies, [k]: !s.print.copies[k] } } })} />
                    ))}
                    <Field label="Footer line" htmlFor="p-footer"><Input id="p-footer" value={s.print.footer} onChange={e => set({ print: { ...s.print, footer: e.target.value } })} /></Field>
                    <Field label="Jurisdiction" htmlFor="p-jur"><Input id="p-jur" value={s.jurisdiction} onChange={e => set({ jurisdiction: e.target.value })} placeholder="Subject to Mumbai jurisdiction" /></Field>
                </CardSection>
                <CardSection title="Default wording" hint="New documents start with these.">
                    <Field label="Terms & conditions" htmlFor="p-terms"><Textarea id="p-terms" rows={4} className="resize-none" value={s.terms} onChange={e => set({ terms: e.target.value })} /></Field>
                    <Field label="Notes" htmlFor="p-notes"><Textarea id="p-notes" rows={2} className="resize-none" value={s.notes} onChange={e => set({ notes: e.target.value })} /></Field>
                </CardSection>
            </>}

            {section === 'tally' && (
                <CardSection title="Tally export" hint="Reports → Tally (XML) makes a file for Gateway of Tally → Import → Vouchers. These names must match ledgers in your Tally company; customers are created under the group below.">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="Company name in Tally" htmlFor="tl-company" hint="Leave empty to import into the company that is open." className="sm:col-span-2">
                            <Input id="tl-company" value={s.tally.company} onChange={e => set({ tally: { ...s.tally, company: e.target.value } })} />
                        </Field>
                        {([
                            ['salesLedger', 'Sales ledger', 'Put {rate} in the name for one ledger per GST rate, e.g. “Sales @{rate}%”.'],
                            ['cgstLedger', 'CGST ledger', ''],
                            ['sgstLedger', 'SGST / UTGST ledger', ''],
                            ['igstLedger', 'IGST ledger', ''],
                            ['roundOffLedger', 'Round-off ledger', ''],
                            ['partyGroup', 'Customers group', 'Usually Sundry Debtors.'],
                        ] as const).map(([k, label, hint]) => (
                            <Field key={k} label={label} htmlFor={`tl-${k}`} hint={hint || undefined}>
                                <Input id={`tl-${k}`} value={s.tally[k]} onChange={e => set({ tally: { ...s.tally, [k]: e.target.value } })} />
                            </Field>
                        ))}
                    </div>
                </CardSection>
            )}

            {section === 'more' && (
                <CardSection title="Proformas & inventory">
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Proforma valid for (days)" htmlFor="m-valid"><Input id="m-valid" type="number" min={1} value={s.proformaValidityDays} onChange={e => set({ proformaValidityDays: Math.max(1, Number(e.target.value) || 15) })} /></Field>
                        <Field label="Advance asked (%)" htmlFor="m-adv"><Input id="m-adv" type="number" min={0} max={100} value={s.advancePct} onChange={e => set({ advancePct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
                    </div>
                    <ToggleRow title="Update inventory" description="Issuing a tax invoice marks pieces Sold; approval, exhibition and job-work challans mark them Reserved until they come back."
                        checked={s.inventoryEffects} onChange={() => set({ inventoryEffects: !s.inventoryEffects })} />
                </CardSection>
            )}
        </Sheet>
    );
}
