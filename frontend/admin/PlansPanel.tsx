// Plans: what each plan costs and allows.
//
//   #/plans            every plan as a card: price, headline limits, status
//   #/plans/:id        one plan: its versions on the left, settings on the right
//
// A published version is a contract and is shown locked. Changing a plan
// means a new version (start from any existing one), which organizations move
// to explicitly. The editor opens in a slide-over, so the page underneath
// never jumps, and every save updates the page in place.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Check, ChevronDown, Copy, Layers, Lock, Pencil, Plus, Send, Archive } from 'lucide-react';
import { Field, Input, Textarea, ToggleRow } from '../components/ui';
import { api, type ApiError } from './api';
import { Detail, Drawer, EmptyState, PageHeader, Section, Segmented, SkeletonCards, Skeleton, StatusPill, useDialogs } from './kit';

/* ─────────────────────────────── Types ──────────────────────────────── */

interface FieldDef { key: string; label: string; hint: string; nullable?: boolean; max?: number; period?: string; default: unknown; alwaysOn?: boolean; enforced?: boolean }
interface PlanSchema { limits: FieldDef[]; modules: FieldDef[]; features: FieldDef[]; billingTypes: string[] }

interface Limits { limits: Record<string, number | null>; modules: Record<string, boolean>; features: Record<string, boolean>; integrations: string[] }

interface PlanRow {
    id: string; key: string; name: string; description: string; status: string; is_public: number; sort_order: number;
    versions: number; drafts: number; organizations: number; published_version: number | null;
    billing_type: string | null; currency: string | null; price_monthly: number | null; price_annual: number | null;
    trial_days: number | null; published_limits: string | null;
}

export interface PlanVersion {
    id: string; version: number; status: string; billing_type: string; currency: string; price_monthly: number;
    price_annual: number; trial_days: number; limits: string; notes: string | null; created_at: number;
    published_at: number | null; organizations: number;
}

type PlanDetail = Omit<PlanRow, 'versions'> & { versions: PlanVersion[] };

/* ────────────────────────────── Helpers ─────────────────────────────── */

let schemaCache: Promise<PlanSchema> | null = null;
const loadSchema = () => (schemaCache ??= api<PlanSchema>('/admin/plans/schema').catch(e => { schemaCache = null; throw e; }));

function useSchema(): PlanSchema | null {
    const [schema, setSchema] = useState<PlanSchema | null>(null);
    useEffect(() => { loadSchema().then(setSchema).catch(() => setSchema(null)); }, []);
    return schema;
}

const parse = (json: string | null | undefined): Limits | null => {
    if (!json) return null;
    try { return JSON.parse(json) as Limits; } catch { return null; }
};

const money = (minor: number, currency = 'INR') =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);

const limitText = (v: number | null | undefined) => (v === null ? 'Unlimited' : v === undefined ? '—' : v.toLocaleString('en-IN'));

function priceLine(type: string | null, monthly: number | null, annual: number | null, trial: number | null, currency: string | null) {
    if (!type) return 'Not published yet';
    if (type === 'free') return 'Free';
    if (type === 'custom') return 'Custom pricing';
    if (type === 'trial') return `${trial ?? 0}-day trial`;
    return `${money(monthly ?? 0, currency ?? 'INR')} / month · ${money(annual ?? 0, currency ?? 'INR')} / year`;
}

const HEADLINE = ['maxMembers', 'maxItems', 'maxCatalogs', 'storageMb'];

/* ─────────────────────────────── Panel ──────────────────────────────── */

export const PlansPanel: React.FC<{ routeId?: string; go: (section: string, id?: string) => void }> = ({ routeId, go }) =>
    routeId
        ? <PlanDetailView key={routeId} planId={routeId} onBack={() => go('plans')} />
        : <PlanList onOpen={id => go('plans', id)} />;

/* ─────────────────────────────── List ───────────────────────────────── */

const PlanList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
    const dialogs = useDialogs();
    const schema = useSchema();
    const [plans, setPlans] = useState<PlanRow[] | null>(null);
    const [filter, setFilter] = useState('all');

    useEffect(() => {
        api<{ plans: PlanRow[] }>('/admin/plans').then(r => setPlans(r.plans)).catch(e => toast.error((e as ApiError).message));
    }, []);

    const create = async () => {
        const name = await dialogs.prompt({
            title: 'New plan', label: 'Plan name', placeholder: 'e.g. Studio', minLength: 2, confirmLabel: 'Create draft',
            hint: 'You set prices and limits in its first version next.',
        });
        if (!name) return;
        try {
            const plan = await api<PlanRow>('/admin/plans', { method: 'POST', body: JSON.stringify({ name }) });
            onOpen(plan.id);
        } catch (e) { toast.error((e as ApiError).message); }
    };

    const labelOf = (key: string) => schema?.limits.find(f => f.key === key)?.label ?? key;
    const shown = (plans ?? []).filter(p => filter === 'all' || p.status === filter);
    const count = (s: string) => (plans ?? []).filter(p => p.status === s).length;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Plans"
                description="What each plan costs and includes. Published versions are locked; a change is a new version that organizations move to when you say so."
                actions={<button type="button" className="neu-button neu-button-primary" onClick={create}><Plus size={16} /> New plan</button>}
            />
            {plans && plans.length > 0 && (
                <Segmented value={filter} onChange={setFilter} options={[
                    { value: 'all', label: 'All', count: plans.length },
                    { value: 'published', label: 'Published', count: count('published') },
                    { value: 'draft', label: 'Draft', count: count('draft') },
                    { value: 'retired', label: 'Retired', count: count('retired') },
                ]} />
            )}

            {!plans ? <SkeletonCards count={3} height={232} /> : plans.length === 0 ? (
                <Section>
                    <EmptyState icon={<Layers size={20} />} title="No plans yet"
                        body="Organizations without a plan get conservative default limits. Create a plan to sell."
                        action={<button type="button" className="neu-button neu-button-primary" onClick={create}><Plus size={16} /> Create the first plan</button>} />
                </Section>
            ) : shown.length === 0 ? (
                <Section><EmptyState title="Nothing here" body="No plans match this filter." /></Section>
            ) : (
                <div className="ac-grid-fit ac-enter-soft" style={{ ['--ac-min' as string]: '17rem' }}>
                    {shown.map(p => {
                        const limits = parse(p.published_limits);
                        return (
                            <button key={p.id} type="button" onClick={() => onOpen(p.id)} className="neu-card-interactive text-left p-5 flex flex-col min-w-0">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="font-serif text-xl leading-tight break-words">{p.name}</p>
                                        <p className="text-[12px] ac-faint font-mono mt-0.5 truncate">{p.key}</p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1 shrink-0">
                                        <StatusPill status={p.status} />
                                        {!!p.is_public && <StatusPill tone="accent">Public</StatusPill>}
                                    </div>
                                </div>
                                <p className="mt-4 text-sm font-medium">{priceLine(p.billing_type, p.price_monthly, p.price_annual, p.trial_days, p.currency)}</p>
                                {p.description && <p className="mt-1 text-[13px] ac-muted line-clamp-2">{p.description}</p>}
                                <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
                                    {HEADLINE.map(k => (
                                        <div key={k} className="min-w-0">
                                            <dt className="text-[11px] ac-faint truncate">{labelOf(k)}</dt>
                                            <dd className="text-sm tabular-nums">{limits ? limitText(limits.limits?.[k]) : '—'}</dd>
                                        </div>
                                    ))}
                                </dl>
                                <p className="mt-auto pt-4 text-[12px] ac-muted">
                                    {p.published_version ? `v${p.published_version} live` : 'No live version'}
                                    {p.drafts > 0 && ` · ${p.drafts} draft${p.drafts === 1 ? '' : 's'}`}
                                    {` · ${p.organizations} organization${p.organizations === 1 ? '' : 's'}`}
                                </p>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

/* ────────────────────────────── Detail ──────────────────────────────── */

type EditorState = { mode: 'create'; base?: PlanVersion } | { mode: 'edit'; base: PlanVersion };

const PlanDetailView: React.FC<{ planId: string; onBack: () => void }> = ({ planId, onBack }) => {
    const dialogs = useDialogs();
    const schema = useSchema();
    const [plan, setPlan] = useState<PlanDetail | null>(null);
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [showOlder, setShowOlder] = useState(false);

    useEffect(() => {
        api<PlanDetail>(`/admin/plans/${planId}`).then(setPlan).catch(e => toast.error((e as ApiError).message));
    }, [planId]);

    // Every change returns the updated plan, so the page updates in place.
    const patchPlan = useCallback(async (body: Record<string, unknown>, done?: string) => {
        try {
            setPlan(await api<PlanDetail>(`/admin/plans/${planId}`, { method: 'PATCH', body: JSON.stringify(body) }));
            if (done) toast.success(done);
            return true;
        } catch (e) { toast.error((e as ApiError).message); return false; }
    }, [planId]);

    const patchVersion = useCallback(async (versionId: string, body: Record<string, unknown>, done: string) => {
        try {
            setPlan(await api<PlanDetail>(`/admin/plans/${planId}/versions/${versionId}`, { method: 'PATCH', body: JSON.stringify(body) }));
            toast.success(done);
        } catch (e) { toast.error((e as ApiError).message); }
    }, [planId]);

    const current = useMemo(() => plan?.versions.find(v => v.status === 'published') ?? null, [plan]);
    const drafts = plan?.versions.filter(v => v.status === 'draft') ?? [];
    const older = plan?.versions.filter(v => v.status !== 'draft' && v.id !== current?.id) ?? [];

    if (!plan) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-64" />
                <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
                    <Skeleton className="h-80 rounded-[18px]" />
                    <Skeleton className="h-64 rounded-[18px]" />
                </div>
            </div>
        );
    }

    const publishVersion = async (v: PlanVersion) => {
        const ok = await dialogs.confirm({
            title: `Publish version ${v.version}?`,
            body: current
                ? `New organizations get version ${v.version}. The ${current.organizations} organization${current.organizations === 1 ? '' : 's'} on version ${current.version} stay on it until you move them.`
                : 'It becomes the version new organizations are given. Once published it cannot be edited.',
            confirmLabel: 'Publish',
        });
        if (ok) await patchVersion(v.id, { status: 'published' }, `Version ${v.version} published`);
    };

    const retireVersion = async (v: PlanVersion) => {
        const ok = await dialogs.confirm({
            title: `Retire version ${v.version}?`,
            body: `It can no longer be given to organizations. The ${v.organizations} already on it keep it.`,
            confirmLabel: 'Retire', danger: true,
        });
        if (ok) await patchVersion(v.id, { status: 'retired' }, `Version ${v.version} retired`);
    };

    const setPlanStatus = async (status: string) => {
        const text: Record<string, { title: string; body: string; label: string; danger?: boolean }> = {
            published: { title: `Publish ${plan.name}?`, body: 'It can then be assigned, and shown on the pricing page if it is public.', label: 'Publish plan' },
            retired: { title: `Retire ${plan.name}?`, body: 'It stops being offered. Organizations on it keep it.', label: 'Retire plan', danger: true },
            archived: { title: `Archive ${plan.name}?`, body: 'It is hidden from the list of active plans. Organizations on it keep it.', label: 'Archive', danger: true },
            draft: { title: `Move ${plan.name} back to draft?`, body: 'It stops being offered until you publish it again.', label: 'Move to draft' },
        };
        const t = text[status];
        if (await dialogs.confirm({ title: t.title, body: t.body, confirmLabel: t.label, danger: t.danger })) {
            await patchPlan({ status }, 'Plan updated');
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                back={{ label: 'All plans', onClick: onBack }}
                title={plan.name}
                meta={<><StatusPill status={plan.status} />{!!plan.is_public && <StatusPill tone="accent">Public</StatusPill>}</>}
                description={<span className="font-mono text-[12px]">{plan.key}</span>}
                actions={
                    <>
                        {plan.status !== 'published' && <button type="button" className="neu-button" onClick={() => setPlanStatus('published')}><Send size={15} /> Publish plan</button>}
                        <button type="button" className="neu-button neu-button-primary" onClick={() => setEditor({ mode: 'create', base: current ?? drafts[0] })}>
                            <Plus size={16} /> New version
                        </button>
                    </>
                }
            />

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start">
                <div className="space-y-5 min-w-0">
                    {plan.versions.length === 0 && (
                        <Section>
                            <EmptyState icon={<Layers size={20} />} title="No versions yet"
                                body="A version holds the prices, limits and features. Create one, then publish it."
                                action={<button type="button" className="neu-button neu-button-primary" onClick={() => setEditor({ mode: 'create' })}><Plus size={16} /> Create version 1</button>} />
                        </Section>
                    )}
                    {current && (
                        <VersionCard v={current} schema={schema} current
                            onDuplicate={() => setEditor({ mode: 'create', base: current })}
                            onRetire={() => retireVersion(current)} />
                    )}
                    {drafts.map(v => (
                        <VersionCard key={v.id} v={v} schema={schema} compare={current}
                            onEdit={() => setEditor({ mode: 'edit', base: v })}
                            onPublish={() => publishVersion(v)} />
                    ))}
                    {older.length > 0 && (
                        <div>
                            <button type="button" onClick={() => setShowOlder(s => !s)} className="inline-flex items-center gap-1.5 text-[13px] ac-muted hover:text-[var(--ac-text)]">
                                <ChevronDown size={15} style={{ transform: showOlder ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
                                {showOlder ? 'Hide' : 'Show'} {older.length} earlier version{older.length === 1 ? '' : 's'}
                            </button>
                            {showOlder && (
                                <div className="mt-4 space-y-5 ac-enter-soft">
                                    {older.map(v => (
                                        <VersionCard key={v.id} v={v} schema={schema}
                                            onDuplicate={() => setEditor({ mode: 'create', base: v })}
                                            onRetire={v.status === 'published' ? () => retireVersion(v) : undefined} />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <aside className="space-y-5 min-w-0 lg:sticky lg:top-6">
                    <PlanSettings plan={plan} onSave={patchPlan} />
                    <Section title="Status" description="Where this plan can be used.">
                        <div className="flex flex-wrap gap-2">
                            {plan.status === 'published' && <button type="button" className="neu-button neu-button-danger" onClick={() => setPlanStatus('retired')}>Retire plan</button>}
                            {plan.status === 'retired' && <button type="button" className="neu-button" onClick={() => setPlanStatus('published')}>Offer again</button>}
                            {plan.status !== 'archived' && plan.status !== 'published' && <button type="button" className="neu-button" onClick={() => setPlanStatus('archived')}><Archive size={15} /> Archive</button>}
                            {plan.status === 'archived' && <button type="button" className="neu-button" onClick={() => setPlanStatus('draft')}>Restore as draft</button>}
                        </div>
                        <p className="mt-3 text-[12px] ac-muted">
                            {plan.versions.reduce((n, v) => n + (v.organizations ?? 0), 0)} organization(s) are on some version of this plan.
                            Nothing changes for them when you retire or archive it.
                        </p>
                    </Section>
                </aside>
            </div>

            <VersionEditor
                open={!!editor}
                state={editor}
                planId={plan.id}
                schema={schema}
                current={current}
                onClose={() => setEditor(null)}
                onSaved={p => { setPlan(p); setEditor(null); }}
            />
        </div>
    );
};

/* ──────────────────────────── Plan settings ─────────────────────────── */

const PlanSettings: React.FC<{ plan: PlanDetail; onSave: (body: Record<string, unknown>, done?: string) => Promise<boolean> }> = ({ plan, onSave }) => {
    const [name, setName] = useState(plan.name);
    const [description, setDescription] = useState(plan.description ?? '');
    const [sortOrder, setSortOrder] = useState(String(plan.sort_order ?? 0));
    const [busy, setBusy] = useState(false);
    useEffect(() => { setName(plan.name); setDescription(plan.description ?? ''); setSortOrder(String(plan.sort_order ?? 0)); }, [plan.name, plan.description, plan.sort_order]);
    const dirty = name !== plan.name || description !== (plan.description ?? '') || Number(sortOrder) !== (plan.sort_order ?? 0);

    return (
        <Section title="Plan details">
            <form className="space-y-4" onSubmit={async e => {
                e.preventDefault();
                setBusy(true);
                await onSave({ name, description, sortOrder: Number(sortOrder) || 0 }, 'Saved');
                setBusy(false);
            }}>
                <Field label="Name" htmlFor="pl-name"><Input id="pl-name" value={name} onChange={e => setName(e.target.value)} required /></Field>
                <Field label="Description" htmlFor="pl-desc" hint="Shown on the pricing page.">
                    <Textarea id="pl-desc" rows={3} value={description} onChange={e => setDescription(e.target.value)} />
                </Field>
                <Field label="Order on the pricing page" htmlFor="pl-sort" hint="Lower numbers come first.">
                    <Input id="pl-sort" inputMode="numeric" value={sortOrder} onChange={e => setSortOrder(e.target.value.replace(/[^\d]/g, ''))} />
                </Field>
                <ToggleRow title="Shown on the pricing page" description="Needs a published version."
                    checked={plan.is_public === 1} onChange={() => onSave({ isPublic: plan.is_public !== 1 }, plan.is_public ? 'Hidden from pricing' : 'Shown on pricing')} />
                {/* The button is always there, so saving never makes the form jump. */}
                <button type="submit" className="neu-button neu-button-primary w-full" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save details'}</button>
            </form>
        </Section>
    );
};

/* ──────────────────────────── Version card ──────────────────────────── */

const VersionCard: React.FC<{
    v: PlanVersion; schema: PlanSchema | null; current?: boolean; compare?: PlanVersion | null;
    onEdit?: () => void; onPublish?: () => void; onDuplicate?: () => void; onRetire?: () => void;
}> = ({ v, schema, current = false, compare, onEdit, onPublish, onDuplicate, onRetire }) => {
    const limits = parse(v.limits);
    const was = compare ? parse(compare.limits) : null;
    const flags = schema ? [...schema.modules.map(f => ({ ...f, group: 'modules' as const })), ...schema.features.map(f => ({ ...f, group: 'features' as const }))] : [];
    const on = flags.filter(f => limits?.[f.group]?.[f.key]);

    return (
        <section className={`neu-card p-5 min-w-0 ${current ? 'ac-current' : ''}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold">Version {v.version}</h3>
                        {current ? <StatusPill tone="ok">Live</StatusPill> : <StatusPill status={v.status} />}
                        <StatusPill tone="neutral">{v.billing_type}</StatusPill>
                        {v.status === 'published' && <span className="inline-flex items-center gap-1 text-[12px] ac-faint"><Lock size={12} /> locked</span>}
                    </div>
                    <p className="mt-1.5 text-sm font-medium">{priceLine(v.billing_type, v.price_monthly, v.price_annual, v.trial_days, v.currency)}</p>
                    {v.billing_type === 'paid' && v.trial_days > 0 && <p className="text-[12px] ac-muted">{v.trial_days}-day trial</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                    {onEdit && <button type="button" className="neu-button" onClick={onEdit}><Pencil size={15} /> Edit</button>}
                    {onPublish && <button type="button" className="neu-button neu-button-primary" onClick={onPublish}><Send size={15} /> Publish</button>}
                    {onDuplicate && <button type="button" className="neu-button" onClick={onDuplicate}><Copy size={15} /> New version from this</button>}
                    {onRetire && <button type="button" className="neu-button neu-button-danger" onClick={onRetire}>Retire</button>}
                </div>
            </div>

            {!schema || !limits ? <Skeleton className="mt-5 h-24" /> : (
                <>
                    <dl className="mt-5 ac-grid-fit !gap-x-5 !gap-y-3" style={{ ['--ac-min' as string]: '9.5rem' }}>
                        {schema.limits.map(f => {
                            const value = limits.limits?.[f.key];
                            const before = was?.limits?.[f.key];
                            const changed = was && before !== value;
                            return (
                                <Detail key={f.key} label={f.label}>
                                    <span className="tabular-nums">{limitText(value)}</span>
                                    {changed && <span className="ml-1.5 text-[11px] ac-faint">was {limitText(before)}</span>}
                                </Detail>
                            );
                        })}
                    </dl>
                    <div className="mt-5 flex flex-wrap gap-1.5">
                        {on.map(f => <StatusPill key={f.key} tone={f.alwaysOn ? 'neutral' : 'accent'}>{f.label}</StatusPill>)}
                        {on.length === 0 && <span className="text-[13px] ac-muted">No features switched on.</span>}
                    </div>
                </>
            )}

            <p className="mt-4 text-[12px] ac-muted">
                {v.organizations} organization{v.organizations === 1 ? '' : 's'} on this version
                {v.published_at ? ` · published ${new Date(v.published_at).toLocaleDateString()}` : ` · drafted ${new Date(v.created_at).toLocaleDateString()}`}
                {v.notes ? ` · ${v.notes}` : ''}
            </p>
        </section>
    );
};

/* ─────────────────────────── Version editor ─────────────────────────── */

interface LimitDraft { unlimited: boolean; value: string }

const BILLING: { value: string; label: string; hint: string }[] = [
    { value: 'free', label: 'Free', hint: 'No charge. Goes live on assignment.' },
    { value: 'trial', label: 'Trial', hint: 'Free for a set number of days.' },
    { value: 'paid', label: 'Paid', hint: 'Monthly and yearly prices. Waits for payment.' },
    { value: 'custom', label: 'Custom', hint: 'Priced per agreement.' },
];

const VersionEditor: React.FC<{
    open: boolean; state: EditorState | null; planId: string; schema: PlanSchema | null; current: PlanVersion | null;
    onClose: () => void; onSaved: (plan: PlanDetail) => void;
}> = ({ open, state, planId, schema, current, onClose, onSaved }) => {
    const dialogs = useDialogs();
    const [billing, setBilling] = useState('paid');
    const [monthly, setMonthly] = useState('');
    const [annual, setAnnual] = useState('');
    const [trial, setTrial] = useState('14');
    const [notes, setNotes] = useState('');
    const [limits, setLimits] = useState<Record<string, LimitDraft>>({});
    const [flags, setFlags] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [touched, setTouched] = useState(false);

    // Fill the form from the version being edited or copied, or from defaults.
    useEffect(() => {
        if (!open || !schema) return;
        const base = state?.base;
        const l = base ? parse(base.limits) : null;
        setBilling(base?.billing_type ?? 'paid');
        setMonthly(base ? String((base.price_monthly ?? 0) / 100) : '999');
        setAnnual(base ? String((base.price_annual ?? 0) / 100) : '9990');
        setTrial(String(base?.trial_days ?? 14));
        setNotes(state?.mode === 'edit' ? base?.notes ?? '' : '');
        setLimits(Object.fromEntries(schema.limits.map(f => {
            // A version saved before a limit existed has no value for it.
            const v: number | null | undefined = l ? l.limits?.[f.key] : (f.default as number | null);
            return [f.key, { unlimited: v === null && !!f.nullable, value: v === null || v === undefined ? '' : String(v) }];
        })));
        setFlags(Object.fromEntries([...schema.modules, ...schema.features].map(f => {
            const group = schema.modules.includes(f) ? 'modules' : 'features';
            const v = l ? l[group]?.[f.key] : (f.default as boolean);
            return [f.key, f.alwaysOn ? true : !!v];
        })));
        setTouched(false);
    }, [open, state, schema]);

    const was = current ? parse(current.limits) : null;
    const title = state?.mode === 'edit' ? `Edit draft version ${state.base.version}` : state?.base ? `New version from v${state.base.version}` : 'New version';

    const close = async () => {
        if (touched && !(await dialogs.confirm({ title: 'Discard changes?', body: 'What you changed in this version will be lost.', confirmLabel: 'Discard', danger: true }))) return;
        onClose();
    };

    const save = async () => {
        if (!schema) return;
        const toMinor = (s: string) => Math.round((Number(s.replace(/,/g, '')) || 0) * 100);
        const body = {
            billingType: billing, currency: 'INR',
            priceMonthly: billing === 'paid' ? toMinor(monthly) : 0,
            priceAnnual: billing === 'paid' ? toMinor(annual) : 0,
            trialDays: billing === 'trial' || billing === 'paid' ? Number(trial) || 0 : 0,
            notes,
            limits: {
                limits: Object.fromEntries(schema.limits.map(f => {
                    const d = limits[f.key];
                    return [f.key, d?.unlimited ? null : d?.value === '' ? (f.nullable ? null : 1) : Number(d?.value)];
                })),
                modules: Object.fromEntries(schema.modules.map(f => [f.key, !!flags[f.key]])),
                features: Object.fromEntries(schema.features.map(f => [f.key, !!flags[f.key]])),
            },
        };
        setBusy(true);
        try {
            const plan = state?.mode === 'edit'
                ? await api<PlanDetail>(`/admin/plans/${planId}/versions/${state.base.id}`, { method: 'PATCH', body: JSON.stringify(body) })
                : await api<PlanDetail>(`/admin/plans/${planId}/versions`, { method: 'POST', body: JSON.stringify(body) });
            toast.success(state?.mode === 'edit' ? 'Draft saved' : 'Draft version created — publish it when ready');
            onSaved(plan);
        } catch (e) { toast.error((e as ApiError).message); }
        finally { setBusy(false); }
    };

    const change = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) => (v: React.SetStateAction<T>) => { setTouched(true); setter(v); };
    const setLimit = (key: string, next: Partial<LimitDraft>) => { setTouched(true); setLimits(l => ({ ...l, [key]: { ...l[key], ...next } })); };
    const toggleFlag = (key: string) => { setTouched(true); setFlags(x => ({ ...x, [key]: !x[key] })); };

    return (
        <Drawer open={open} onClose={close} width={820} title={title}
            subtitle="Saved as a draft. Publish it when it is right — published versions cannot change."
            footer={
                <>
                    <button type="button" className="neu-button" onClick={close}>Cancel</button>
                    <button type="button" className="neu-button neu-button-primary" disabled={busy || !schema} onClick={save}>
                        <Check size={16} /> {busy ? 'Saving…' : state?.mode === 'edit' ? 'Save draft' : 'Create draft'}
                    </button>
                </>
            }>
            {!schema ? <SkeletonCards count={4} height={80} /> : (
                <>
                    <Section title="Billing">
                        <Segmented value={billing} onChange={change(setBilling)} options={BILLING.map(b => ({ value: b.value, label: b.label }))} />
                        <p className="mt-2 text-[12px] ac-muted">{BILLING.find(b => b.value === billing)?.hint}</p>
                        {/* Fields stay in the layout and are disabled when they do not apply, so switching type never shifts the form. */}
                        <div className="mt-4 ac-grid-fit" style={{ ['--ac-min' as string]: '11rem' }}>
                            <Field label="Monthly price (₹)" htmlFor="ve-m">
                                <Input id="ve-m" inputMode="decimal" disabled={billing !== 'paid'} value={billing === 'paid' ? monthly : ''} placeholder={billing === 'paid' ? '' : 'Not charged'} onChange={e => change(setMonthly)(e.target.value)} />
                            </Field>
                            <Field label="Yearly price (₹)" htmlFor="ve-a">
                                <Input id="ve-a" inputMode="decimal" disabled={billing !== 'paid'} value={billing === 'paid' ? annual : ''} placeholder={billing === 'paid' ? '' : 'Not charged'} onChange={e => change(setAnnual)(e.target.value)} />
                            </Field>
                            <Field label="Trial days" htmlFor="ve-t">
                                <Input id="ve-t" inputMode="numeric" disabled={billing !== 'trial' && billing !== 'paid'} value={billing === 'trial' || billing === 'paid' ? trial : ''} placeholder="No trial" onChange={e => change(setTrial)(e.target.value.replace(/[^\d]/g, ''))} />
                            </Field>
                        </div>
                    </Section>

                    <Section title="Limits" description={was ? `Compared with the live version ${current?.version}.` : undefined}>
                        <div className="ac-grid-fit" style={{ ['--ac-min' as string]: '15rem' }}>
                            {schema.limits.map(f => {
                                const d = limits[f.key] ?? { unlimited: false, value: '' };
                                const value = d.unlimited ? null : d.value === '' ? undefined : Number(d.value);
                                const before = was?.limits?.[f.key];
                                const changed = was !== null && value !== undefined && value !== before;
                                return (
                                    <div key={f.key} className="min-w-0">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <label htmlFor={`lim-${f.key}`} className="neu-label !mb-1.5 truncate">{f.label}</label>
                                            {changed && <span className="text-[11px] ac-faint whitespace-nowrap">was {limitText(before)}</span>}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Input id={`lim-${f.key}`} inputMode="numeric" className="flex-1 min-w-0 tabular-nums" disabled={d.unlimited}
                                                value={d.unlimited ? '' : d.value} placeholder={d.unlimited ? 'Unlimited' : '0'}
                                                onChange={e => setLimit(f.key, { value: e.target.value.replace(/[^\d]/g, '') })} />
                                            {f.nullable && (
                                                <button type="button" onClick={() => setLimit(f.key, { unlimited: !d.unlimited })} aria-pressed={d.unlimited}
                                                    title="Unlimited" className={`neu-button !px-3 !h-10 ${d.unlimited ? '!text-[var(--ac-accent)] ![box-shadow:var(--ac-press)]' : ''}`}>∞</button>
                                            )}
                                        </div>
                                        <p className="mt-1 text-[11px] ac-faint">{f.hint}{f.enforced === false ? ' Not enforced yet.' : ''}</p>
                                    </div>
                                );
                            })}
                        </div>
                    </Section>

                    <Section title="Included features" description="Tick what this version includes. Locked items are part of every plan.">
                        <div className="ac-grid-fit !gap-3" style={{ ['--ac-min' as string]: '15rem' }}>
                            {[...schema.modules, ...schema.features].map(f => {
                                const checked = f.alwaysOn ? true : !!flags[f.key];
                                return (
                                    <label key={f.key} className={`ac-check ${checked ? 'is-on' : ''} ${f.alwaysOn ? 'is-locked' : ''}`}>
                                        <input type="checkbox" className="sr-only" checked={checked} disabled={!!f.alwaysOn} onChange={() => toggleFlag(f.key)} />
                                        <span className="box">{checked && (f.alwaysOn ? <Lock size={11} /> : <Check size={13} strokeWidth={3} />)}</span>
                                        <span className="min-w-0">
                                            <span className="block text-sm font-medium">{f.label}</span>
                                            <span className="block text-[11px] ac-muted">{f.hint}{f.enforced === false ? ' Not enforced yet.' : ''}</span>
                                        </span>
                                    </label>
                                );
                            })}
                        </div>
                    </Section>

                    <Section title="Note">
                        <Field label="Reason for this version" htmlFor="ve-notes" hint="For your own records.">
                            <Input id="ve-notes" value={notes} onChange={e => change(setNotes)(e.target.value)} placeholder="e.g. Raised the product limit" />
                        </Field>
                    </Section>
                </>
            )}
        </Drawer>
    );
};

