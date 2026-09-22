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

interface FieldDef { key: string; label: string; hint: string; nullable?: boolean; max?: number; period?: string; default: unknown; alwaysOn?: boolean; enforced?: boolean }
interface PlanSchema { limits: FieldDef[]; modules: FieldDef[]; features: FieldDef[]; billingTypes: string[] }

interface Limits {
    limits: Record<string, number | null>;
    modules: Record<string, boolean>;
    features: Record<string, boolean>;
    integrations: string[];
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
    const [schema, setSchema] = useState<PlanSchema | null>(null);
    const [adding, setAdding] = useState(false);

    useEffect(() => { api<PlanSchema>('/admin/plans/schema').then(setSchema).catch(() => setSchema(null)); }, []);

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
                {adding && <NewVersionForm planId={planId} schema={schema} onDone={(p) => { setAdding(false); setPlan(p); }} />}
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
                                    {schema?.limits.map(f => `${f.label}: ${limitText(limits.limits[f.key] ?? null)}`).join(' · ')}
                                </p>
                                <p className="text-[11px] text-gray-600 dark:text-gray-400">
                                    Modules: {Object.entries(limits.modules).filter(([, on]) => on).map(([m]) => m).join(', ') || 'none'}
                                </p>
                                <p className="text-[11px] text-gray-600 dark:text-gray-400">
                                    Features: {Object.entries(limits.features).filter(([, on]) => on).map(([m]) => m).join(', ') || 'none'}
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

/** Every field comes from the server's schema, so the two never drift apart. */
const NewVersionForm: React.FC<{ planId: string; schema: PlanSchema | null; onDone: (plan: PlanDetail) => void }> = ({ planId, schema, onDone }) => {
    const [billingType, setBillingType] = useState('paid');
    const [priceMonthly, setPriceMonthly] = useState('999');
    const [priceAnnual, setPriceAnnual] = useState('9990');
    const [trialDays, setTrialDays] = useState('14');
    const [notes, setNotes] = useState('');
    const [limits, setLimits] = useState<Record<string, string>>({});
    const [flags, setFlags] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!schema) return;
        setLimits(Object.fromEntries(schema.limits.map(f => [f.key, f.default === null ? '' : String(f.default)])));
        setFlags(Object.fromEntries([...schema.modules, ...schema.features].map(f => [f.key, f.alwaysOn === true || f.default === true])));
    }, [schema]);

    if (!schema) return <p className="text-sm">Loading plan options\u2026</p>;

    const included = [...schema.modules, ...schema.features];
    const alwaysOn = included.filter(f => f.alwaysOn);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const plan = await api<PlanDetail>(`/admin/plans/${planId}/versions`, {
                method: 'POST',
                body: JSON.stringify({
                    billingType,
                    currency: 'INR',
                    // Prices are typed in rupees and stored in paise.
                    priceMonthly: Math.round(Number(priceMonthly || 0) * 100),
                    priceAnnual: Math.round(Number(priceAnnual || 0) * 100),
                    trialDays: Number(trialDays || 0),
                    notes,
                    limits: {
                        limits: Object.fromEntries(schema.limits.map(f => [f.key, limits[f.key]?.trim() === '' ? null : Number(limits[f.key])])),
                        modules: Object.fromEntries(schema.modules.map(f => [f.key, !!flags[f.key]])),
                        features: Object.fromEntries(schema.features.map(f => [f.key, !!flags[f.key]])),
                    },
                }),
            });
            toast.success('Draft version added');
            onDone(plan);
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    return (
        <form onSubmit={submit} className="neu-inset rounded-xl p-4 mb-4 space-y-5">
            <div className="grid gap-3 sm:grid-cols-4">
                <Field label="Billing type" htmlFor="v-type">
                    <Select id="v-type" value={billingType} onChange={e => setBillingType(e.target.value)}>
                        {schema.billingTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </Select>
                </Field>
                <Field label="Monthly price (\u20b9)" htmlFor="v-pm"><Input id="v-pm" inputMode="decimal" value={priceMonthly} onChange={e => setPriceMonthly(e.target.value)} /></Field>
                <Field label="Annual price (\u20b9)" htmlFor="v-pa"><Input id="v-pa" inputMode="decimal" value={priceAnnual} onChange={e => setPriceAnnual(e.target.value)} /></Field>
                <Field label="Trial days" htmlFor="v-td"><Input id="v-td" inputMode="numeric" value={trialDays} onChange={e => setTrialDays(e.target.value)} /></Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
                {schema.limits.map(f => (
                    <Field key={f.key} label={f.label} htmlFor={`lim-${f.key}`}
                        hint={`${f.hint}${f.nullable ? ' Blank = unlimited.' : ''}${f.enforced === false ? ' (not enforced yet)' : ''}`}>
                        <Input id={`lim-${f.key}`} inputMode="numeric" value={limits[f.key] ?? ''}
                            onChange={e => setLimits(l => ({ ...l, [f.key]: e.target.value }))} />
                    </Field>
                ))}
                <Field label="Reason for this version" htmlFor="v-notes" hint="Kept with the version, for your own records.">
                    <Input id="v-notes" value={notes} onChange={e => setNotes(e.target.value)} />
                </Field>
            </div>

            <fieldset className="border border-black/10 dark:border-white/10 rounded-xl p-3">
                <legend className="px-1 text-[11px] uppercase tracking-[0.14em] text-gray-700 dark:text-gray-200">Included features</legend>
                <div className="grid gap-x-6 sm:grid-cols-2">
                    {included.map(f => (
                        <label key={f.key} className="flex items-start gap-2 py-1.5 text-sm text-gray-800 dark:text-gray-200">
                            <input
                                type="checkbox"
                                className="mt-0.5"
                                checked={f.alwaysOn ? true : !!flags[f.key]}
                                disabled={!!f.alwaysOn}
                                onChange={() => setFlags(x => ({ ...x, [f.key]: !x[f.key] }))}
                            />
                            <span>
                                {f.label}
                                <span className="block text-[11px] text-gray-600 dark:text-gray-400">
                                    {f.hint}{f.enforced === false ? ' (not enforced yet)' : ''}
                                </span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            <p className="text-[11px] text-gray-600 dark:text-gray-400">
                {alwaysOn.length > 0 && `${alwaysOn.map(f => f.label).join(' and ')} ${alwaysOn.length === 1 ? 'is' : 'are'} part of every plan. `}
                Organizations already on this plan keep the version they were given until you move them.
            </p>

            <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={busy}>Create plan version</Button>
            </div>
        </form>
    );
};
