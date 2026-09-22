// Plans, versions and what each one allows.
//
// A published version is a contract and is shown read-only: changing a plan
// means adding a new version, which organizations move to explicitly.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Layers, Plus } from 'lucide-react';
import { Badge, Button, Card, Field, Input, SectionTitle, Select, ToggleRow } from '../components/ui';
import { api, type ApiError } from './api';

interface PlanRow {
    id: string; key: string; name: string; description: string; status: string; is_public: number;
    versions: number; published_version: number | null; organizations: number;
}

export interface PlanVersion {
    id: string; version: number; status: string; billing_type: string; currency: string;
    price_monthly: number; price_annual: number; trial_days: number; limits: string;
}

type PlanDetail = Omit<PlanRow, 'versions'> & { versions: PlanVersion[] };

interface Limits {
    maxMembers: number | null; maxStores: number | null; maxItems: number | null; storageMb: number | null;
    exports: boolean; catalogPdf: boolean; customRoles: boolean; branding: boolean;
    modules: Record<string, boolean>; auditRetentionDays: number; integrations: string[];
}

const money = (minor: number, currency: string) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

const limitText = (v: number | null) => (v === null ? 'unlimited' : String(v));

export const PlansPanel: React.FC = () => {
    const [plans, setPlans] = useState<PlanRow[] | null>(null);
    const [openId, setOpenId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');

    const load = useCallback(async () => {
        try { setPlans((await api<{ plans: PlanRow[] }>('/admin/plans')).plans); }
        catch (e) { toast.error((e as ApiError).message); }
    }, []);
    useEffect(() => { load(); }, [load]);

    const create = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const plan = await api<PlanRow>('/admin/plans', { method: 'POST', body: JSON.stringify({ name }) });
            setName('');
            setCreating(false);
            await load();
            setOpenId(plan.id);
        } catch (err) { toast.error((err as ApiError).message); }
    };

    if (openId) return <PlanDetailView planId={openId} onBack={() => { setOpenId(null); load(); }} />;

    return (
        <Card padding="lg">
            <SectionTitle actions={<Layers size={16} />}>Plans</SectionTitle>
            <div className="mb-4">
                <Button icon={<Plus size={16} />} onClick={() => setCreating(c => !c)}>New plan</Button>
            </div>
            {creating && (
                <form onSubmit={create} className="neu-inset rounded-xl p-4 mb-4 flex flex-wrap gap-2 items-end">
                    <Field label="Plan name" htmlFor="plan-name" className="flex-1 min-w-[12rem]">
                        <Input id="plan-name" required value={name} onChange={e => setName(e.target.value)} placeholder="Studio" />
                    </Field>
                    <Button type="submit" variant="primary">Create draft</Button>
                </form>
            )}
            {!plans ? <p className="text-sm">Loading…</p> : plans.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">No plans yet. Organizations without a plan get conservative default limits.</p>
            ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {plans.map(p => (
                        <li key={p.id}>
                            <button type="button" onClick={() => setOpenId(p.id)} className="w-full text-left py-3 flex flex-wrap items-center gap-2">
                                <span className="font-medium text-gray-900 dark:text-gray-100">{p.name}</span>
                                <Badge>{p.status}</Badge>
                                {!!p.is_public && <Badge>public</Badge>}
                                <span className="text-[12px] text-gray-600 dark:text-gray-400 ml-auto">
                                    {p.versions} version{p.versions === 1 ? '' : 's'}
                                    {p.published_version ? ` · v${p.published_version} published` : ' · none published'}
                                    {' · '}{p.organizations} organization{p.organizations === 1 ? '' : 's'}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

const PlanDetailView: React.FC<{ planId: string; onBack: () => void }> = ({ planId, onBack }) => {
    const [plan, setPlan] = useState<PlanDetail | null>(null);
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        try { setPlan(await api(`/admin/plans/${planId}`)); }
        catch (e) { toast.error((e as ApiError).message); }
    }, [planId]);
    useEffect(() => { load(); }, [load]);

    if (!plan) return <Card><p className="text-sm">Loading…</p></Card>;

    const save = async (body: Record<string, unknown>) => {
        try { setPlan(await api(`/admin/plans/${planId}`, { method: 'PATCH', body: JSON.stringify(body) })); }
        catch (e) { toast.error((e as ApiError).message); }
    };

    const setVersion = async (versionId: string, body: Record<string, unknown>) => {
        try {
            setPlan(await api(`/admin/plans/${planId}/versions/${versionId}`, { method: 'PATCH', body: JSON.stringify(body) }));
            toast.success('Saved');
        } catch (e) { toast.error((e as ApiError).message); }
    };

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <button type="button" onClick={onBack} className="text-[12px] text-gray-600 dark:text-gray-400 mb-2">← All plans</button>
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-serif text-xl text-gray-900 dark:text-gray-100">{plan.name}</h2>
                    <Badge>{plan.status}</Badge>
                </div>
                <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-1">Key: <span className="font-mono">{plan.key}</span></p>
                <div className="mt-3 space-y-1">
                    <ToggleRow title="Shown on the public pricing page" description="Only with a published version."
                        checked={plan.is_public === 1} onChange={() => save({ isPublic: plan.is_public !== 1 })} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    {plan.status !== 'published' && <Button variant="primary" onClick={() => save({ status: 'published' })}>Publish plan</Button>}
                    {plan.status === 'published' && <Button onClick={() => save({ status: 'retired' })}>Retire</Button>}
                </div>
            </Card>

            <Card padding="lg">
                <SectionTitle actions={<Button icon={<Plus size={16} />} onClick={() => setAdding(a => !a)}>New version</Button>}>
                    Versions
                </SectionTitle>
                {adding && <NewVersionForm planId={planId} onDone={(p) => { setAdding(false); setPlan(p); }} />}
                <ul className="space-y-3">
                    {plan.versions.map(v => {
                        const limits = JSON.parse(v.limits) as Limits;
                        return (
                            <li key={v.id} className="neu-inset rounded-xl p-3">
                                <div className="flex flex-wrap items-center gap-2 mb-2">
                                    <strong className="text-sm">v{v.version}</strong>
                                    <Badge>{v.status}</Badge>
                                    <Badge>{v.billing_type}</Badge>
                                    <span className="text-[12px] text-gray-600 dark:text-gray-400">
                                        {v.billing_type === 'paid'
                                            ? `${money(v.price_monthly, v.currency)}/month · ${money(v.price_annual, v.currency)}/year`
                                            : v.billing_type === 'trial' ? `${v.trial_days}-day trial` : 'no charge'}
                                    </span>
                                    <span className="ml-auto flex gap-2">
                                        {v.status === 'draft' && <Button variant="primary" onClick={() => setVersion(v.id, { status: 'published' })}>Publish</Button>}
                                        {v.status === 'published' && <Button onClick={() => setVersion(v.id, { status: 'retired' })}>Retire</Button>}
                                    </span>
                                </div>
                                <p className="text-[12px] text-gray-700 dark:text-gray-300">
                                    {limitText(limits.maxMembers)} members · {limitText(limits.maxStores)} stores · {limitText(limits.maxItems)} items · {limitText(limits.storageMb)} MB
                                    {limits.exports ? ' · exports' : ''}{limits.catalogPdf ? ' · catalog PDF' : ''}
                                    {limits.customRoles ? ' · custom roles' : ''}{limits.branding ? ' · branding' : ''}
                                </p>
                                <p className="text-[11px] text-gray-600 dark:text-gray-400">
                                    Modules: {Object.entries(limits.modules).filter(([, on]) => on).map(([m]) => m).join(', ') || 'none'}
                                </p>
                                {v.status === 'published' && (
                                    <p className="text-[11px] text-gray-600 dark:text-gray-400 mt-1">
                                        Published versions cannot be edited. Add a new version to change anything.
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            </Card>
        </div>
    );
};

const NewVersionForm: React.FC<{ planId: string; onDone: (plan: PlanDetail) => void }> = ({ planId, onDone }) => {
    const [billingType, setBillingType] = useState('paid');
    const [priceMonthly, setPriceMonthly] = useState('999');
    const [priceAnnual, setPriceAnnual] = useState('9990');
    const [trialDays, setTrialDays] = useState('14');
    const [maxMembers, setMaxMembers] = useState('5');
    const [maxStores, setMaxStores] = useState('1');
    const [maxItems, setMaxItems] = useState('1000');
    const [storageMb, setStorageMb] = useState('5120');
    const [exports, setExports] = useState(false);
    const [customRoles, setCustomRoles] = useState(false);
    const [branding, setBranding] = useState(false);
    const [attendance, setAttendance] = useState(false);

    const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            const plan = await api<PlanDetail>(`/admin/plans/${planId}/versions`, {
                method: 'POST',
                body: JSON.stringify({
                    billingType,
                    currency: 'INR',
                    // Prices are entered in rupees and stored in paise.
                    priceMonthly: Math.round(Number(priceMonthly || 0) * 100),
                    priceAnnual: Math.round(Number(priceAnnual || 0) * 100),
                    trialDays: Number(trialDays || 0),
                    limits: {
                        maxMembers: numOrNull(maxMembers), maxStores: numOrNull(maxStores),
                        maxItems: numOrNull(maxItems), storageMb: numOrNull(storageMb),
                        exports, customRoles, branding,
                        modules: { catalogs: true, invoices: true, inquiries: true, messaging: true, attendance, calendar: true },
                    },
                }),
            });
            toast.success('Draft version added');
            onDone(plan);
        } catch (err) { toast.error((err as ApiError).message); }
    };

    return (
        <form onSubmit={submit} className="neu-inset rounded-xl p-4 mb-4 grid gap-3 sm:grid-cols-3">
            <Field label="Billing type" htmlFor="v-type">
                <Select id="v-type" value={billingType} onChange={e => setBillingType(e.target.value)}>
                    <option value="free">Free</option>
                    <option value="trial">Trial</option>
                    <option value="paid">Paid</option>
                    <option value="custom">Custom</option>
                </Select>
            </Field>
            <Field label="Monthly price (₹)" htmlFor="v-pm"><Input id="v-pm" inputMode="decimal" value={priceMonthly} onChange={e => setPriceMonthly(e.target.value)} /></Field>
            <Field label="Annual price (₹)" htmlFor="v-pa"><Input id="v-pa" inputMode="decimal" value={priceAnnual} onChange={e => setPriceAnnual(e.target.value)} /></Field>
            <Field label="Trial days" htmlFor="v-td"><Input id="v-td" inputMode="numeric" value={trialDays} onChange={e => setTrialDays(e.target.value)} /></Field>
            <Field label="Members" htmlFor="v-mm" hint="Blank = unlimited"><Input id="v-mm" inputMode="numeric" value={maxMembers} onChange={e => setMaxMembers(e.target.value)} /></Field>
            <Field label="Stores" htmlFor="v-ms" hint="Blank = unlimited"><Input id="v-ms" inputMode="numeric" value={maxStores} onChange={e => setMaxStores(e.target.value)} /></Field>
            <Field label="Items" htmlFor="v-mi" hint="Blank = unlimited"><Input id="v-mi" inputMode="numeric" value={maxItems} onChange={e => setMaxItems(e.target.value)} /></Field>
            <Field label="Storage (MB)" htmlFor="v-sm" hint="Blank = unlimited"><Input id="v-sm" inputMode="numeric" value={storageMb} onChange={e => setStorageMb(e.target.value)} /></Field>
            <div className="sm:col-span-3 space-y-1">
                <ToggleRow title="Exports" checked={exports} onChange={() => setExports(v => !v)} />
                <ToggleRow title="Custom roles" checked={customRoles} onChange={() => setCustomRoles(v => !v)} />
                <ToggleRow title="Branding" checked={branding} onChange={() => setBranding(v => !v)} />
                <ToggleRow title="Attendance module" checked={attendance} onChange={() => setAttendance(v => !v)} />
            </div>
            <div className="sm:col-span-3"><Button type="submit" variant="primary">Add draft version</Button></div>
        </form>
    );
};
