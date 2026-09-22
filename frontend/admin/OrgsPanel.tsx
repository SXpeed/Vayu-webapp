// Organizations, members and each organization's own Razorpay account.
// Convenience only: every action is authorized and validated on the server.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowLeft, Building2, CreditCard, Gauge, Plus, UserPlus, Users } from 'lucide-react';
import { Badge, Button, Card, Field, Input, SectionTitle, Select } from '../components/ui';
import { api, guarded as sharedGuarded, type ApiError, type Reauth } from './api';

interface OrgRow {
    id: string; slug: string; name: string; business_type: string; status: string; is_demo: number;
    created_at: number; active_members: number; owner_email: string | null; razorpay_status: string | null;
}

interface Member { id: string; user_id: string; role: string; status: string; email: string; name: string }

interface OrgDetail {
    id: string; slug: string; name: string; business_type: string; status: string; country: string | null;
    timezone: string | null; is_demo: number; created_at: number; members: Member[];
}

interface Razorpay {
    connected: boolean; webhookUrl: string; mode?: 'test' | 'live'; keyIdHint?: string; hasWebhookSecret?: boolean;
    status?: string; lastVerifiedAt?: number | null; lastError?: string | null; updatedAt?: number;
}

const BUSINESS_TYPES: [string, string][] = [
    ['artist', 'Individual artist'], ['studio', 'Studio'], ['gallery', 'Gallery'],
    ['store', 'Single store'], ['multi_store', 'Multiple stores'], ['other', 'Other'],
];
const ROLES = ['owner', 'admin', 'manager', 'staff'];

const typeLabel = (t: string) => BUSINESS_TYPES.find(([v]) => v === t)?.[1] ?? t;

/** Runs a call; if the server wants a fresh sign-in, asks for it once and retries. */
const guarded = <T,>(reauth: Reauth, fn: () => Promise<T>) => sharedGuarded(reauth, fn, (m) => toast.error(m));

const json = (body: unknown) => ({ body: JSON.stringify(body) });

export const OrgsPanel: React.FC<{ reauth: Reauth; focusId?: string }> = ({ reauth, focusId }) => {
    const [openId, setOpenId] = useState<string | null>(focusId ?? null);
    useEffect(() => { if (focusId) setOpenId(focusId); }, [focusId]);
    return openId
        ? <OrgDetailView orgId={openId} reauth={reauth} onBack={() => setOpenId(null)} />
        : <OrgList onOpen={setOpenId} />;
};

/* ------------------------------ List ------------------------------- */

const OrgList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
    const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState<'org' | 'user' | null>(null);

    const load = useCallback(async () => {
        try {
            const r = await api<{ organizations: OrgRow[] }>(`/admin/orgs${q ? `?q=${encodeURIComponent(q)}` : ''}`);
            setOrgs(r.organizations);
        } catch (e) { toast.error((e as ApiError).message); }
    }, [q]);

    useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

    return (
        <Card padding="lg">
            <SectionTitle actions={<Building2 size={16} />}>Organizations</SectionTitle>
            <div className="flex flex-wrap gap-2 mb-4">
                <Input className="flex-1 min-w-[12rem]" placeholder="Search by name or address name…" value={q} onChange={e => setQ(e.target.value)} />
                <Button icon={<Plus size={16} />} onClick={() => setCreating(creating === 'org' ? null : 'org')}>New organization</Button>
                <Button icon={<UserPlus size={16} />} onClick={() => setCreating(creating === 'user' ? null : 'user')}>New account</Button>
            </div>
            {creating === 'user' && <NewAccountForm onDone={() => setCreating(null)} />}
            {creating === 'org' && <NewOrgForm onDone={(id) => { setCreating(null); if (id) onOpen(id); else load(); }} />}
            {!orgs ? <p className="text-sm">Loading…</p> : orgs.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">No organizations yet.</p>
            ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {orgs.map(o => (
                        <li key={o.id}>
                            <button type="button" onClick={() => onOpen(o.id)} className="w-full text-left py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="font-medium text-gray-900 dark:text-gray-100">{o.name}</span>
                                <span className="text-[12px] text-gray-600 dark:text-gray-400">{typeLabel(o.business_type)}</span>
                                {o.status !== 'active' && <Badge>{o.status}</Badge>}
                                {!!o.is_demo && <Badge>demo</Badge>}
                                <span className="text-[12px] text-gray-600 dark:text-gray-400 ml-auto">
                                    {o.owner_email ?? 'no owner'} · {o.active_members} member{o.active_members === 1 ? '' : 's'}
                                    {' · '}Razorpay: {o.razorpay_status ?? 'not connected'}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

function randomPassword(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return btoa(String.fromCodePoint(...bytes)).replace(/[+/=]/g, '').slice(0, 14);
}

const NewAccountForm: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState(randomPassword);
    const [busy, setBusy] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            await api('/admin/users', { method: 'POST', ...json({ name, email, temporaryPassword: password }) });
            toast.success(`Account created. Give ${email} the temporary password yourself.`);
            onDone();
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };
    return (
        <form onSubmit={submit} className="neu-inset rounded-xl p-4 mb-4 grid gap-3 sm:grid-cols-3">
            <Field label="Name" htmlFor="nu-name"><Input id="nu-name" required value={name} onChange={e => setName(e.target.value)} /></Field>
            <Field label="Email" htmlFor="nu-email"><Input id="nu-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} /></Field>
            <Field label="Temporary password" htmlFor="nu-pw" hint="Share it privately. Email invitations come later.">
                <Input id="nu-pw" required minLength={10} value={password} onChange={e => setPassword(e.target.value)} />
            </Field>
            <div className="sm:col-span-3"><Button type="submit" variant="primary" disabled={busy}>Create account</Button></div>
        </form>
    );
};

const NewOrgForm: React.FC<{ onDone: (id?: string) => void }> = ({ onDone }) => {
    const [name, setName] = useState('');
    const [businessType, setBusinessType] = useState('gallery');
    const [ownerEmail, setOwnerEmail] = useState('');
    const [isDemo, setIsDemo] = useState(false);
    const [busy, setBusy] = useState(false);
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        try {
            const org = await api<OrgDetail>('/admin/orgs', { method: 'POST', ...json({ name, businessType, ownerEmail, isDemo }) });
            toast.success(`${org.name} created`);
            onDone(org.id);
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };
    return (
        <form onSubmit={submit} className="neu-inset rounded-xl p-4 mb-4 grid gap-3 sm:grid-cols-3">
            <Field label="Business name" htmlFor="no-name"><Input id="no-name" required value={name} onChange={e => setName(e.target.value)} /></Field>
            <Field label="Business type" htmlFor="no-type">
                <Select id="no-type" value={businessType} onChange={e => setBusinessType(e.target.value)}>
                    {BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
            </Field>
            <Field label="Owner's account email" htmlFor="no-owner" hint="The account must exist (New account).">
                <Input id="no-owner" type="email" required value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} />
            </Field>
            <label className="sm:col-span-3 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" checked={isDemo} onChange={e => setIsDemo(e.target.checked)} /> Demo / test organization
            </label>
            <div className="sm:col-span-3"><Button type="submit" variant="primary" disabled={busy}>Create organization</Button></div>
        </form>
    );
};

/* ------------------------------ Detail ----------------------------- */

const OrgDetailView: React.FC<{ orgId: string; reauth: Reauth; onBack: () => void }> = ({ orgId, reauth, onBack }) => {
    const [org, setOrg] = useState<OrgDetail | null>(null);

    const load = useCallback(async () => {
        try { setOrg(await api<OrgDetail>(`/admin/orgs/${orgId}`)); } catch (e) { toast.error((e as ApiError).message); }
    }, [orgId]);
    useEffect(() => { load(); }, [load]);

    if (!org) return <Card><p className="text-sm">Loading…</p></Card>;

    const setStatus = async (status: 'active' | 'suspended') => {
        const reason = window.prompt(status === 'suspended' ? 'Why is this organization being suspended?' : 'Reason for reactivating?');
        if (!reason) return;
        const next = await guarded(reauth, () => api<OrgDetail>(`/admin/orgs/${orgId}/status`, { method: 'POST', ...json({ status, reason }) }));
        if (next) { setOrg(next); toast.success(status === 'suspended' ? 'Suspended' : 'Reactivated'); }
    };

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <button type="button" onClick={onBack} className="text-[12px] text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
                            <ArrowLeft size={14} /> All organizations
                        </button>
                        <h2 className="font-serif text-xl text-gray-900 dark:text-gray-100">{org.name}</h2>
                        <p className="text-[12px] text-gray-600 dark:text-gray-400">
                            {typeLabel(org.business_type)} · {org.slug} · created {new Date(org.created_at).toLocaleDateString()}
                            {org.is_demo ? ' · demo' : ''}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Badge>{org.status}</Badge>
                        {org.status === 'active' && <Button variant="danger" onClick={() => setStatus('suspended')}>Suspend</Button>}
                        {org.status === 'suspended' && <Button onClick={() => setStatus('active')}>Reactivate</Button>}
                    </div>
                </div>
            </Card>
            <SubscriptionCard orgId={org.id} reauth={reauth} />
            <MembersCard org={org} onChange={setOrg} />
            <RazorpayCard orgId={org.id} reauth={reauth} />
        </div>
    );
};

const MembersCard: React.FC<{ org: OrgDetail; onChange: (o: OrgDetail) => void }> = ({ org, onChange }) => {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('staff');

    const patch = async (m: Member, change: Partial<Pick<Member, 'role' | 'status'>>) => {
        try {
            onChange(await api<OrgDetail>(`/admin/orgs/${org.id}/members/${m.id}`, { method: 'PATCH', ...json(change) }));
        } catch (e) { toast.error((e as ApiError).message); }
    };

    const add = async (e: React.FormEvent) => {
        e.preventDefault();
        try {
            onChange(await api<OrgDetail>(`/admin/orgs/${org.id}/members`, { method: 'POST', ...json({ email, role }) }));
            setEmail('');
            toast.success('Member added');
        } catch (err) { toast.error((err as ApiError).message); }
    };

    return (
        <Card padding="lg">
            <SectionTitle actions={<Users size={16} />}>Members</SectionTitle>
            <ul className="divide-y divide-black/5 dark:divide-white/10 mb-4">
                {org.members.map(m => (
                    <li key={m.id} className="py-2 flex flex-wrap items-center gap-2">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-gray-900 dark:text-gray-100 truncate">{m.name}</p>
                            <p className="text-[12px] text-gray-600 dark:text-gray-400 truncate">{m.email}</p>
                        </div>
                        <Select aria-label={`Role for ${m.email}`} className="w-32" value={m.role} onChange={e => patch(m, { role: e.target.value })}>
                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                        </Select>
                        <Button onClick={() => patch(m, { status: m.status === 'active' ? 'disabled' : 'active' })}>
                            {m.status === 'active' ? 'Disable' : 'Enable'}
                        </Button>
                    </li>
                ))}
            </ul>
            <form onSubmit={add} className="flex flex-wrap gap-2">
                <Input className="flex-1 min-w-[12rem]" type="email" required placeholder="Existing account email" value={email} onChange={e => setEmail(e.target.value)} />
                <Select aria-label="Role" className="w-32" value={role} onChange={e => setRole(e.target.value)}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </Select>
                <Button type="submit" icon={<UserPlus size={16} />}>Add member</Button>
            </form>
        </Card>
    );
};

interface Entitlements {
    limits: {
        limits: Record<string, number | null>;
        modules: Record<string, boolean>;
        features: Record<string, boolean>;
    };
    plan: { key: string; name: string; version: number; billingType: string } | null;
    subscription: { status: string; trialEndsAt: number | null; paymentWaived: boolean };
    overrides: Record<string, unknown>;
    active: boolean;
    seats: { used: number; limit: number | null; remaining: number | null; overLimit: boolean };
}

interface PlanOption { id: string; name: string; versionId: string; version: number; billingType: string }

const SubscriptionCard: React.FC<{ orgId: string; reauth: Reauth }> = ({ orgId, reauth }) => {
    const [info, setInfo] = useState<Entitlements | null>(null);
    const [options, setOptions] = useState<PlanOption[]>([]);
    const [choice, setChoice] = useState('');

    const load = useCallback(async () => {
        try {
            setInfo(await api<Entitlements>(`/admin/orgs/${orgId}/subscription`));
            const { plans } = await api<{ plans: { id: string; name: string }[] }>('/admin/plans');
            const opts: PlanOption[] = [];
            for (const p of plans) {
                const detail = await api<{ name: string; versions: { id: string; version: number; status: string; billing_type: string }[] }>(`/admin/plans/${p.id}`);
                for (const v of detail.versions.filter(v => v.status === 'published')) {
                    opts.push({ id: p.id, name: detail.name, versionId: v.id, version: v.version, billingType: v.billing_type });
                }
            }
            setOptions(opts);
        } catch (e) { toast.error((e as ApiError).message); }
    }, [orgId]);
    useEffect(() => { load(); }, [load]);

    if (!info) return <Card><p className="text-sm">Loading plan…</p></Card>;

    const act = async (path: string, body: Record<string, unknown>) => {
        const next = await guarded(reauth, () => api<Entitlements>(`/admin/orgs/${orgId}${path}`, { method: 'POST', ...json(body) }));
        if (next) { toast.success('Updated'); load(); }
    };

    const assign = (waive: boolean) => {
        if (!choice) { toast.error('Choose a plan version first'); return; }
        const reason = waive ? window.prompt('Why is payment being waived?') : 'Plan assigned from the control panel';
        if (!reason) return;
        act('/subscription', { planVersionId: choice, waivePayment: waive, reason });
    };

    const extend = () => {
        const days = window.prompt('Extend the trial by how many days?', '14');
        if (!days) return;
        const reason = window.prompt('Reason?');
        if (!reason) return;
        act('/subscription/extend-trial', { days: Number(days), reason });
    };

    const override = () => {
        const value = window.prompt('New member limit for this organization only (blank = unlimited)');
        if (value === null) return;
        const reason = window.prompt('Reason (recorded in the audit log)');
        if (!reason) return;
        act('/entitlements', { key: 'maxMembers', value: value.trim() === '' ? null : Number(value), reason });
    };

    return (
        <Card padding="lg">
            <SectionTitle actions={<Gauge size={16} />}>Plan and limits</SectionTitle>
            <div className="neu-inset rounded-xl p-3 text-[13px] space-y-1 text-gray-800 dark:text-gray-200">
                <p>Plan: <strong>{info.plan ? `${info.plan.name} v${info.plan.version} (${info.plan.billingType})` : 'none — default limits'}</strong></p>
                <p>Status: <strong>{info.subscription.status}</strong>
                    {info.subscription.paymentWaived ? ' · payment waived' : ''}
                    {info.subscription.trialEndsAt ? ` · trial ends ${new Date(info.subscription.trialEndsAt).toLocaleDateString()}` : ''}</p>
                <p>Members: {info.seats.used} of {info.seats.limit ?? 'unlimited'}
                    {info.seats.overLimit && <span className="text-amber-700 dark:text-amber-400"> · over the limit: existing members keep working, new ones are blocked until someone is disabled</span>}</p>
                <p className="text-[12px] text-gray-600 dark:text-gray-400">
                    Products {info.limits.limits.maxItems ?? '∞'} · stores {info.limits.limits.maxStores ?? '∞'}
                    {' · '}storage {info.limits.limits.storageMb ?? '∞'} MB · PDFs/month {info.limits.limits.pdfGenerationsPerMonth ?? '∞'}
                    {Object.keys(info.overrides).length > 0 && ` · overrides: ${Object.keys(info.overrides).join(', ')}`}
                </p>
                <p className="text-[12px] text-gray-600 dark:text-gray-400">
                    Included: {[...Object.entries(info.limits.modules), ...Object.entries(info.limits.features)]
                        .filter(([, on]) => on).map(([k]) => k).join(', ') || 'nothing'}
                </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 items-end">
                <Field label="Change plan" htmlFor="sub-plan" className="flex-1 min-w-[14rem]">
                    <Select id="sub-plan" value={choice} onChange={e => setChoice(e.target.value)}>
                        <option value="">Choose a published version…</option>
                        {options.map(o => <option key={o.versionId} value={o.versionId}>{o.name} v{o.version} ({o.billingType})</option>)}
                    </Select>
                </Field>
                <Button variant="primary" onClick={() => assign(false)}>Assign</Button>
                <Button onClick={() => assign(true)}>Assign &amp; waive payment</Button>
                <Button onClick={extend}>Extend trial</Button>
                <Button onClick={override}>Override member limit</Button>
            </div>
        </Card>
    );
};

const RazorpayCard: React.FC<{ orgId: string; reauth: Reauth }> = ({ orgId, reauth }) => {
    const [info, setInfo] = useState<Razorpay | null>(null);
    const [editing, setEditing] = useState(false);
    const [keyId, setKeyId] = useState('');
    const [keySecret, setKeySecret] = useState('');
    const [webhookSecret, setWebhookSecret] = useState('');
    const [busy, setBusy] = useState(false);

    const path = `/admin/orgs/${orgId}/payments/razorpay`;
    const load = useCallback(async () => {
        try { setInfo(await api<Razorpay>(path)); } catch (e) { toast.error((e as ApiError).message); }
    }, [path]);
    useEffect(() => { load(); }, [load]);

    if (!info) return <Card><p className="text-sm">Loading payments…</p></Card>;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const next = await guarded(reauth, () => api<Razorpay>(path, { method: 'PUT', ...json({ keyId, keySecret, webhookSecret }) }));
        setBusy(false);
        if (next) {
            setInfo(next);
            setEditing(false);
            setKeySecret('');
            setWebhookSecret('');
            toast.success('Razorpay keys saved. Click Verify to test them.');
        }
    };

    const verify = async () => {
        setBusy(true);
        const r = await guarded(reauth, () => api<{ status: string; error: string | null }>(`${path}/verify`, { method: 'POST' }));
        setBusy(false);
        if (r) {
            if (r.status === 'verified') toast.success('Razorpay accepted the keys'); else toast.error(r.error ?? 'Verification failed');
            load();
        }
    };

    const disconnect = async () => {
        if (!window.confirm('Disconnect this Razorpay account? Payment links and webhooks for this organization will stop working.')) return;
        const next = await guarded(reauth, () => api<Razorpay>(path, { method: 'DELETE' }));
        if (next) { setInfo(next); toast.success('Disconnected'); }
    };

    return (
        <Card padding="lg">
            <SectionTitle actions={<CreditCard size={16} />}>Razorpay (the organization's own account)</SectionTitle>
            <p className="text-[12px] mb-3 text-gray-600 dark:text-gray-400">
                Payments this organization collects from its customers go to this account, never to the platform's.
                Secrets are stored encrypted and never shown again.
            </p>

            {info.connected ? (
                <div className="neu-inset rounded-xl p-3 text-[13px] space-y-1 text-gray-800 dark:text-gray-200">
                    <p>Key: <span className="font-mono">{info.keyIdHint}</span> · {info.mode === 'live' ? 'Live mode' : 'Test mode'}</p>
                    <p>Status: <strong>{info.status}</strong>
                        {info.lastVerifiedAt ? ` · last verified ${new Date(info.lastVerifiedAt).toLocaleString()}` : ''}</p>
                    {info.lastError && <p className="text-red-600 dark:text-red-400">{info.lastError}</p>}
                    <p>Webhook secret: {info.hasWebhookSecret ? 'set' : 'not set (payment updates will not arrive)'}</p>
                </div>
            ) : (
                <p className="text-sm text-gray-700 dark:text-gray-300">No Razorpay account connected.</p>
            )}

            <div className="mt-3 text-[12px] space-y-1 text-gray-600 dark:text-gray-400">
                <p>Webhook URL for this organization (Razorpay → Settings → Webhooks):</p>
                <p className="font-mono break-all select-all text-gray-800 dark:text-gray-200">{info.webhookUrl}</p>
                <p>Events: payment_link.paid, payment_link.cancelled, payment_link.expired. Use the same secret as below.</p>
            </div>

            {editing ? (
                <form onSubmit={save} className="mt-4 grid gap-3">
                    <Field label="Key ID" htmlFor="rz-id" hint="Razorpay → Settings → API Keys. rzp_test_… for testing, rzp_live_… for real payments.">
                        <Input id="rz-id" required value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" />
                    </Field>
                    <Field label="Key secret" htmlFor="rz-secret">
                        <Input id="rz-secret" type="password" required value={keySecret} onChange={e => setKeySecret(e.target.value)} autoComplete="off" />
                    </Field>
                    <Field label="Webhook secret" htmlFor="rz-wh" hint={info.hasWebhookSecret ? 'Leave blank to keep the current one.' : 'The secret you type when creating the webhook in Razorpay.'}>
                        <Input id="rz-wh" type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} autoComplete="off" />
                    </Field>
                    <div className="flex gap-2">
                        <Button type="submit" variant="primary" disabled={busy}>Save keys</Button>
                        <Button onClick={() => setEditing(false)}>Cancel</Button>
                    </div>
                </form>
            ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="primary" onClick={() => setEditing(true)}>{info.connected ? 'Replace keys' : 'Connect Razorpay'}</Button>
                    {info.connected && <Button onClick={verify} disabled={busy}>Verify keys</Button>}
                    {info.connected && <Button variant="danger" onClick={disconnect}>Disconnect</Button>}
                </div>
            )}
        </Card>
    );
};
