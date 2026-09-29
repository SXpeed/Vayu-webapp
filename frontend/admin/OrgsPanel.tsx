// Organizations, members and each organization's own Razorpay account.
// Convenience only: every action is authorized and validated on the server.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Building2, ChevronDown, CreditCard, Gauge, Layers, Plus, UserPlus, Users } from 'lucide-react';
import { Button, Card, Field, Input, Select } from '../components/ui';
import { Avatar, Detail, EmptyState, PageHeader, STAT_TILE_H, Section, Skeleton, SkeletonRows, StatTile, StatusPill, useDialogs, type Tone } from './kit';
import { api, guarded as sharedGuarded, timeAgo, type ApiError, type Reauth } from './api';
import { FEATURE_FIELDS, LIMIT_FIELDS, MODULE_FIELDS } from '../platform/planFields';
import { AppDataCard } from './AppDataCard';
import { OrgLogoCard } from './OrgLogoCard';

interface OrgRow {
    id: string; slug: string; name: string; business_type: string; status: string; is_demo: number;
    created_at: number; active_members: number; owner_email: string | null; razorpay_status: string | null;
}

interface Member { id: string; user_id: string; role: string; status: string; email: string; name: string }

interface OrgDetail {
    id: string; slug: string; name: string; business_type: string; status: string; country: string | null;
    timezone: string | null; is_demo: number; created_at: number; members: Member[];
    /** Which data it works on in the app (platform/originalApp.ts). */
    app_storage?: 'own' | 'original';
    /** Its own app logo, or null for the platform's. */
    logoUrl?: string | null;
}

interface Razorpay {
    connected: boolean; webhookUrl: string; mode?: 'test' | 'live'; keyIdHint?: string; hasWebhookSecret?: boolean;
    status?: string; lastVerifiedAt?: number | null; lastError?: string | null; updatedAt?: number;
    /** The retired "use for the app's payment links" setting still names this account (clear it). */
    legacyAppAccount?: boolean;
    /** Test-mode keys may make customer payment links in production. */
    allowTestLinks?: boolean;
    /** After a webhook secret change, the old one still verifies Razorpay's retries until then. */
    previousWebhookSecretUntil?: number | null;
    webhookHealth?: {
        state: 'healthy' | 'attention' | 'no_events' | 'unknown'; detail: string;
        lastVerifiedAt: number | null; verifiedCount: number; processingFailures: number;
        missedByWebhook: number; reconciledAt: number | null; rejected24h: number;
    };
}

const HEALTH_TONE: Record<string, Tone> = { healthy: 'ok', attention: 'bad', no_events: 'neutral', unknown: 'warn' };
const HEALTH_LABEL: Record<string, string> = { healthy: 'Arriving', attention: 'Needs attention', no_events: 'No events yet', unknown: 'Not recorded' };

/** Webhook health from verified deliveries and the scheduled check; rejected deliveries are shown but never count against it. */
const WebhookHealthRow: React.FC<{ info: Razorpay }> = ({ info }) => {
    const h = info.webhookHealth;
    if (!h) return null;
    const facts = [
        h.lastVerifiedAt ? `last verified ${timeAgo(h.lastVerifiedAt)}` : '',
        h.reconciledAt ? `checked with Razorpay ${timeAgo(h.reconciledAt)}` : '',
        h.rejected24h ? `${h.rejected24h} rejected in 24 h (not counted: anyone can send these)` : '',
    ].filter(Boolean).join(' · ');
    return (
        <div className="col-span-2">
            <Detail label="Webhook">
                <span className="flex flex-col gap-1">
                    <span><StatusPill tone={HEALTH_TONE[h.state] ?? 'neutral'}>{HEALTH_LABEL[h.state] ?? h.state}</StatusPill></span>
                    <span className="text-[12px] ac-muted">{h.detail}{facts ? ` (${facts})` : ''}</span>
                    {info.previousWebhookSecretUntil && <span className="text-[12px] ac-muted">The previous secret still verifies Razorpay’s retries until {new Date(info.previousWebhookSecretUntil).toLocaleString()}.</span>}
                </span>
            </Detail>
        </div>
    );
};

/** A Razorpay connection at a glance: verified, failing, or saved but not checked yet. */
function connectionTone(rz: Razorpay | null): Tone {
    if (!rz?.connected) return 'neutral';
    if (rz.status === 'verified') return 'ok';
    return rz.lastError ? 'bad' : 'warn';
}

function connectionLabel(rz: Razorpay | null): string {
    if (!rz) return '—';
    if (!rz.connected) return 'Not connected';
    return `${rz.mode === 'live' ? 'Live' : 'Test'} · ${rz.status ?? 'saved'}`;
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

export const OrgsPanel: React.FC<{ reauth: Reauth; routeId?: string; go: (section: string, id?: string) => void }> = ({ reauth, routeId, go }) =>
    routeId
        ? <OrgDetailView key={routeId} orgId={routeId} reauth={reauth} onBack={() => go('orgs')} />
        : <OrgList onOpen={id => go('orgs', id)} />;

/* ------------------------------ List ------------------------------- */

const OrgList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
    const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState<'org' | 'user' | null>(null);

    const load = useCallback(async () => {
        try {
            const r = await api<{ organizations: OrgRow[] }>(`/admin/orgs${q ? '?q=' + encodeURIComponent(q) : ''}`);
            setOrgs(r.organizations);
        } catch (e) { toast.error((e as ApiError).message); }
    }, [q]);

    useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

    return (
        <Card padding="lg">
            <div className="flex flex-wrap gap-2 mb-4">
                <Input className="flex-1 min-w-[12rem]" placeholder="Search by name or address name…" value={q} onChange={e => setQ(e.target.value)} />
                <Button icon={<Plus size={16} />} onClick={() => setCreating(creating === 'org' ? null : 'org')}>New organization</Button>
                <Button icon={<UserPlus size={16} />} onClick={() => setCreating(creating === 'user' ? null : 'user')}>New account</Button>
            </div>
            {creating === 'user' && <NewAccountForm onDone={() => setCreating(null)} />}
            {creating === 'org' && <NewOrgForm onDone={(id) => { setCreating(null); if (id) onOpen(id); else load(); }} />}
            {!orgs && <SkeletonRows rows={6} />}
            {orgs?.length === 0 && (
                <EmptyState icon={<Building2 size={20} />} title={q ? 'No matches' : 'No organizations yet'} body={q ? undefined : 'Approve an application, or create one here.'} />
            )}
            {orgs?.length ? (
                <ul className="ac-divide -mx-2">
                    {orgs.map(o => (
                        <li key={o.id}>
                            <button type="button" onClick={() => onOpen(o.id)}
                                className="ac-row w-full text-left px-2 py-3 grid items-center gap-x-4 gap-y-1 grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,0.9fr)_auto]">
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium truncate">{o.name}</span>
                                    <span className="block text-[12px] ac-faint truncate">{typeLabel(o.business_type)} · {o.owner_email ?? 'no owner'}</span>
                                </span>
                                <span className="hidden md:block text-[13px] ac-muted">{o.active_members} member{o.active_members === 1 ? '' : 's'}</span>
                                <span className="hidden md:block text-[12px] ac-faint truncate">Razorpay: {o.razorpay_status ?? 'not connected'}</span>
                                <span className="flex flex-wrap justify-end gap-1.5">
                                    <StatusPill status={o.status} />
                                    {!!o.is_demo && <StatusPill tone="info">demo</StatusPill>}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
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
    const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
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
    const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
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

interface Entitlements {
    limits: {
        limits: Record<string, number | null>;
        modules: Record<string, boolean>;
        features: Record<string, boolean>;
    };
    plan: { key: string; name: string; version: number; billingType: string } | null;
    subscription: { status: string; trialEndsAt: number | null; paymentWaived: boolean; currentPeriodEnd?: number | null };
    overrides: Record<string, unknown>;
    active: boolean;
    seats: { used: number; limit: number | null; remaining: number | null; overLimit: boolean };
}

interface PlanOption { id: string; name: string; versionId: string; version: number; billingType: string }

const BILLING_LABEL: Record<string, string> = { free: 'Free', trial: 'Trial', paid: 'Paid', manual: 'Manual billing', custom: 'Custom' };
const fmtLimit = (n: number | null | undefined) => (n === null || n === undefined ? 'Unlimited' : n.toLocaleString());

/**
 * An organization with its plan and payments account. Everything arrives
 * together, so the page appears once instead of growing card by card.
 */
function useOrgDetail(orgId: string) {
    const [org, setOrg] = useState<OrgDetail | null>(null);
    const [sub, setSub] = useState<Entitlements | null>(null);
    const [rz, setRz] = useState<Razorpay | null>(null);
    const [failed, setFailed] = useState<string | null>(null);

    const subPath = `/admin/orgs/${orgId}/subscription`;
    const rzPath = `/admin/orgs/${orgId}/payments/razorpay`;

    // Everything arrives together, so the page appears once instead of
    // growing card by card.
    const loadAll = useCallback(async () => {
        setFailed(null);
        const [o, s, r] = await Promise.allSettled([
            api<OrgDetail>(`/admin/orgs/${orgId}`), api<Entitlements>(subPath), api<Razorpay>(rzPath),
        ]);
        if (o.status === 'rejected') { setFailed((o.reason as ApiError).message); return; }
        setOrg(o.value);
        if (s.status === 'fulfilled') setSub(s.value); else toast.error((s.reason as ApiError).message);
        if (r.status === 'fulfilled') setRz(r.value); else toast.error((r.reason as ApiError).message);
    }, [orgId, subPath, rzPath]);
    useEffect(() => { loadAll(); }, [loadAll]);

    const reloadSub = useCallback(async () => {
        try { setSub(await api<Entitlements>(subPath)); } catch (e) { toast.error((e as ApiError).message); }
    }, [subPath]);
    const reloadRz = useCallback(async () => {
        try { setRz(await api<Razorpay>(rzPath)); } catch (e) { toast.error((e as ApiError).message); }
    }, [rzPath]);

    return { org, setOrg, sub, rz, setRz, failed, rzPath, loadAll, reloadSub, reloadRz };
}

const OrgLoadFailed: React.FC<{ message: string; onBack: () => void; onRetry: () => void }> = ({ message, onBack, onRetry }) => (
    <div className="space-y-6">
        <PageHeader back={{ label: 'All organizations', onClick: onBack }} title="Organization" />
        <Section>
            <EmptyState icon={<Building2 size={20} />} title="Could not load this organization" body={message}
                action={<Button onClick={onRetry}>Try again</Button>} />
        </Section>
    </div>
);

/** The real header and tile sizes, so nothing moves when the data lands. */
const OrgSkeleton: React.FC<{ onBack: () => void }> = ({ onBack }) => (
    <div className="space-y-6" aria-busy="true">
        <PageHeader
            back={{ label: 'All organizations', onClick: onBack }}
            title={<Skeleton inline className="inline-block align-middle h-5 w-64 max-w-full" />}
            description={<Skeleton inline className="inline-block align-middle h-3 w-56 max-w-full" />}
            actions={<Skeleton className="h-10 w-24 rounded-xl" />}
        />
        <div className={TILE_GRID}>
            {[0, 1, 2, 3].map(i => <Skeleton key={i} className={`${TILE_H} rounded-2xl`} />)}
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] items-start">
            <div className="space-y-6"><Skeleton className="h-80 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>
            <div className="space-y-6"><Skeleton className="h-72 rounded-2xl" /><Skeleton className="h-48 rounded-2xl" /></div>
        </div>
    </div>
);

/** Under the subscription tile: a waiver, the trial's end, or whether access is on. */
function subscriptionFoot(sub: Entitlements | null): string {
    if (sub?.subscription.paymentWaived) return 'Payment waived';
    if (sub?.subscription.trialEndsAt) return `Trial ends ${new Date(sub.subscription.trialEndsAt).toLocaleDateString()}`;
    return sub?.active ? 'Access on' : 'Access off';
}

function razorpayFoot(rz: Razorpay | null): string {
    if (!rz?.connected) return 'Razorpay not linked';
    return rz.hasWebhookSecret ? 'Webhook secret set' : 'No webhook secret';
}

/** Seats used as a share of the limit, the words under the tile, and the meter's colour (amber from 85%). */
function seatsInfo(seats: Entitlements['seats'] | undefined): { share: number; note: string; tone: 'ok' | 'warn' | 'bad' } {
    const share = seats?.limit ? Math.min(1, seats.used / seats.limit) : 0;
    if (!seats) return { share, note: '', tone: 'ok' };
    if (seats.overLimit) return { share, note: 'Over the limit', tone: 'bad' };
    return { share, note: seats.remaining === null ? 'No seat limit' : `${seats.remaining} left`, tone: share >= 0.85 ? 'warn' : 'ok' };
}

/** At a glance: the plan, the subscription, seats and the payments account. */
const GlanceTiles: React.FC<{ sub: Entitlements | null; rz: Razorpay | null }> = ({ sub, rz }) => {
    const seats = sub?.seats;
    const { share: seatShare, note: seatsNote, tone: seatTone } = seatsInfo(seats);
    const rzFoot = razorpayFoot(rz);
    const subFoot = subscriptionFoot(sub);
    const planFoot = sub?.plan ? BILLING_LABEL[sub.plan.billingType] ?? sub.plan.billingType : 'No plan assigned';
    return (
        <div className={TILE_GRID}>
            <Tile icon={<Layers size={15} />} label="Plan" value={sub?.plan ? `${sub.plan.name} v${sub.plan.version}` : 'Default limits'} foot={planFoot} />
            <Tile icon={<Gauge size={15} />} label="Subscription" value={sub ? <StatusPill status={sub.subscription.status} /> : '—'} foot={subFoot} />
            <Tile icon={<Users size={15} />} label="Seats"
                value={seats ? <span className="tabular-nums">{seats.used}<span className="ac-faint text-base"> / {seats.limit ?? '∞'}</span></span> : '—'}
                foot={seats ? <span className={seats.overLimit ? 'text-[var(--ac-bad)]' : ''}>{seatsNote}</span> : ''}
                meter={seats?.limit ? { share: seatShare, tone: seatTone } : undefined} />
            <Tile icon={<CreditCard size={15} />} label="Payments" value={<StatusPill tone={connectionTone(rz)}>{connectionLabel(rz)}</StatusPill>} foot={rzFoot} />
        </div>
    );
};

const OrgDetailView: React.FC<{ orgId: string; reauth: Reauth; onBack: () => void }> = ({ orgId, reauth, onBack }) => {
    const dialogs = useDialogs();
    const { org, setOrg, sub, rz, setRz, failed, rzPath, loadAll, reloadSub, reloadRz } = useOrgDetail(orgId);
    if (failed) return <OrgLoadFailed message={failed} onBack={onBack} onRetry={loadAll} />;
    if (!org) return <OrgSkeleton onBack={onBack} />;

    const setStatus = async (status: 'active' | 'suspended') => {
        const reason = await dialogs.prompt(status === 'suspended'
            ? { title: `Suspend ${org.name}?`, body: 'Its people lose access straight away. Nothing is deleted, and you can reactivate it at any time.', label: 'Reason', multiline: true, minLength: 3, confirmLabel: 'Suspend', danger: true }
            : { title: `Reactivate ${org.name}?`, body: 'Its people can use it again immediately.', label: 'Reason', minLength: 3, confirmLabel: 'Reactivate' });
        if (!reason) return;
        const next = await guarded(reauth, () => api<OrgDetail>(`/admin/orgs/${orgId}/status`, { method: 'POST', ...json({ status, reason }) }));
        if (next) { setOrg(next); toast.success(status === 'suspended' ? 'Suspended' : 'Reactivated'); }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                back={{ label: 'All organizations', onClick: onBack }}
                title={org.name}
                meta={<><StatusPill status={org.status} />{!!org.is_demo && <StatusPill tone="info">demo</StatusPill>}</>}
                description={`${typeLabel(org.business_type)} · since ${new Date(org.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`}
                actions={<>
                    {org.status === 'active' && <Button variant="danger" onClick={() => setStatus('suspended')}>Suspend</Button>}
                    {org.status === 'suspended' && <Button variant="primary" onClick={() => setStatus('active')}>Reactivate</Button>}
                </>}
            />

            {/* At a glance: the four things worth checking first. */}
            <GlanceTiles sub={sub} rz={rz} />

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] items-start">
                <div className="space-y-6 min-w-0">
                    {sub ? <PlanCard orgId={orgId} info={sub} reauth={reauth} onChanged={reloadSub} />
                        : <Section title="Plan and limits"><EmptyState title="Could not load the plan" action={<Button onClick={reloadSub}>Try again</Button>} /></Section>}
                    <MembersCard org={org} onChange={next => { setOrg(next); reloadSub(); }} />
                    <AppDataCard org={org} reauth={reauth} onChanged={loadAll} />
                </div>
                <div className="space-y-6 min-w-0">
                    {rz ? <RazorpayCard path={rzPath} info={rz} reauth={reauth} onChange={setRz} onReload={reloadRz} />
                        : <Section title="Customer payments"><EmptyState title="Could not load payments" action={<Button onClick={reloadRz}>Try again</Button>} /></Section>}
                    <OrgLogoCard orgId={orgId} logoUrl={org.logoUrl ?? null}
                        onChange={logoUrl => setOrg(o => (o ? { ...o, logoUrl } : o))} />
                    <Section title="Details">
                        <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
                            <Detail label="Business type">{typeLabel(org.business_type)}</Detail>
                            <Detail label="Web address name"><span className="[overflow-wrap:anywhere]">{org.slug}</span></Detail>
                            <Detail label="Country">{org.country}</Detail>
                            <Detail label="Time zone">{org.timezone}</Detail>
                            <Detail label="Created">{new Date(org.created_at).toLocaleString()}</Detail>
                            <Detail label="Members">{org.members.filter(m => m.status === 'active').length} active of {org.members.length}</Detail>
                            <div className="col-span-2">
                                <Detail label="Organization id"><span className="font-mono text-[12px] select-all">{org.id}</span></Detail>
                            </div>
                        </dl>
                    </Section>
                </div>
            </div>
        </div>
    );
};

const TILE_GRID = 'grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-5';
const TILE_H = STAT_TILE_H;
const Tile = StatTile;


const MembersCard: React.FC<{ org: OrgDetail; onChange: (o: OrgDetail) => void }> = ({ org, onChange }) => {
    const dialogs = useDialogs();
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('staff');
    const [busyId, setBusyId] = useState<string | null>(null);

    const patch = async (m: Member, change: Partial<Pick<Member, 'role' | 'status'>>) => {
        setBusyId(m.id);
        try {
            onChange(await api<OrgDetail>(`/admin/orgs/${org.id}/members/${m.id}`, { method: 'PATCH', ...json(change) }));
        } catch (e) { toast.error((e as ApiError).message); } finally { setBusyId(null); }
    };

    const toggle = async (m: Member) => {
        if (m.status === 'active' && !(await dialogs.confirm({
            title: `Disable ${m.name}?`, body: 'They lose access to this organization straight away. Their account and everything they made stay.',
            confirmLabel: 'Disable', danger: true,
        }))) return;
        patch(m, { status: m.status === 'active' ? 'disabled' : 'active' });
    };

    const add = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        try {
            onChange(await api<OrgDetail>(`/admin/orgs/${org.id}/members`, { method: 'POST', ...json({ email, role }) }));
            setEmail('');
            toast.success('Member added');
        } catch (err) { toast.error((err as ApiError).message); }
    };

    return (
        <Section title="Members" description="People with access to this organization. Adding someone needs an existing account."
            actions={<StatusPill tone="neutral">{org.members.length}</StatusPill>}>
            {org.members.length === 0 ? (
                <EmptyState icon={<Users size={20} />} title="No members yet" />
            ) : (
                <ul className="ac-divide -mx-2 mb-4">
                    {org.members.map(m => (
                        <li key={m.id} className="px-2 py-2.5 grid items-center gap-x-3 gap-y-2 grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                            <Avatar name={m.name} />
                            <div className="min-w-0">
                                <p className="text-sm font-medium truncate flex items-center gap-2">
                                    <span className="truncate">{m.name}</span>
                                    {m.status !== 'active' && <StatusPill status={m.status} />}
                                </p>
                                <p className="text-[12px] ac-faint truncate">{m.email}</p>
                            </div>
                            <div className="col-span-2 sm:col-span-1 flex items-center gap-2 justify-end">
                                <Select aria-label={`Role for ${m.email}`} className="!w-auto min-w-[8.5rem]" value={m.role}
                                    disabled={busyId === m.id} onChange={e => patch(m, { role: e.target.value })}>
                                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                                </Select>
                                <Button disabled={busyId === m.id} onClick={() => toggle(m)} className="min-w-[5.5rem] justify-center">
                                    {m.status === 'active' ? 'Disable' : 'Enable'}
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <form onSubmit={add} className="flex flex-wrap gap-2 rounded-2xl neu-inset p-3">
                <Input className="flex-1 min-w-[12rem]" type="email" required placeholder="Existing account email" value={email} onChange={e => setEmail(e.target.value)} />
                <Select aria-label="Role" className="!w-auto min-w-[8.5rem]" value={role} onChange={e => setRole(e.target.value)}>
                    {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </Select>
                <Button type="submit" icon={<UserPlus size={16} />}>Add member</Button>
            </form>
        </Section>
    );
};

/** "Studio v2 · Paid · paid up to 27 Oct 2026", or that no plan is assigned. */
function planSummary(info: Entitlements, paidUntil: string | null): string {
    if (!info.plan) return 'No plan assigned; the default limits apply.';
    const billing = BILLING_LABEL[info.plan.billingType] ?? info.plan.billingType;
    const until = paidUntil ? ` · paid up to ${paidUntil}` : '';
    return `${info.plan.name} v${info.plan.version} · ${billing}${until}`;
}

const fmtDay = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const PlanCard: React.FC<{ orgId: string; info: Entitlements; reauth: Reauth; onChanged: () => void }> = ({ orgId, info, reauth, onChanged }) => {
    const dialogs = useDialogs();
    const [options, setOptions] = useState<PlanOption[] | null>(null);
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);

    // The version list is only needed for changing plan, so it loads after the page shows.
    useEffect(() => {
        let live = true;
        (async () => {
            try {
                const { plans } = await api<{ plans: { id: string; name: string }[] }>('/admin/plans');
                const details = await Promise.all(plans.map(p =>
                    api<{ name: string; versions: { id: string; version: number; status: string; billing_type: string }[] }>(`/admin/plans/${p.id}`)
                        .then(d => ({ p, d }))));
                const opts: PlanOption[] = [];
                for (const { p, d } of details) {
                    for (const v of d.versions.filter(v => v.status === 'published')) {
                        opts.push({ id: p.id, name: d.name, versionId: v.id, version: v.version, billingType: v.billing_type });
                    }
                }
                if (live) setOptions(opts);
            } catch (e) { if (live) { setOptions([]); toast.error((e as ApiError).message); } }
        })();
        return () => { live = false; };
    }, []);

    const act = async (path: string, body: Record<string, unknown>) => {
        setBusy(true);
        const next = await guarded(reauth, () => api<Entitlements>(`/admin/orgs/${orgId}${path}`, { method: 'POST', ...json(body) }));
        setBusy(false);
        if (next) { toast.success('Updated'); onChanged(); }
    };

    // An organization that already has a plan keeps its status and dates when moved.
    const sub = info.subscription;
    const hasPlan = !!info.plan && sub.status !== 'none';
    const paidUntil = sub.currentPeriodEnd ? fmtDay(sub.currentPeriodEnd) : null;
    const stays = paidUntil ? ` and stays paid up to ${paidUntil}` : '';
    const paidUpTo = paidUntil ? ` (${paidUntil})` : '';

    const assign = async (waive: boolean) => {
        if (!choice) { toast.error('Choose a plan version first'); return; }
        const keep = hasPlan && !waive;
        let reason: string | null;
        if (waive) {
            reason = await dialogs.prompt({ title: 'Waive payment?', body: 'The organization is activated without paying. The reason is recorded.', label: 'Reason', multiline: true, minLength: 3, confirmLabel: 'Assign and waive' });
        } else {
            const body = keep
                ? `It keeps its status${stays}; nothing is charged now. The new limits apply straight away, and its next renewal is at the new plan's price. Nothing already stored is removed if the new plan is smaller.`
                : 'Its limits apply straight away. A paid plan waits for payment before the workspace opens. Nothing already stored is removed if it is smaller.';
            reason = (await dialogs.confirm({ title: keep ? 'Move to this plan?' : 'Assign this plan version?', body, confirmLabel: keep ? 'Move' : 'Assign' }))
                ? 'Plan changed from the control centre' : null;
        }
        if (!reason) return;
        act('/subscription', { planVersionId: choice, waivePayment: waive, keepPeriod: keep, reason });
    };

    /** Extra days on its trial or paid period, e.g. as an apology. */
    const extend = async () => {
        const what = sub.status === 'trialing' ? 'trial' : 'plan';
        const days = await dialogs.prompt({
            title: `Extend the ${what}`,
            body: what === 'trial' ? 'Days are added to the end of the trial.' : `Days are added to the date it has paid up to${paidUpTo}, or from today if that has passed. Nothing is charged.`,
            label: 'Extra days', defaultValue: '7', inputType: 'number', minLength: 1, confirmLabel: 'Next',
        });
        if (!days) return;
        const reason = await dialogs.prompt({ title: 'Why extend it?', label: 'Reason (kept in the audit log)', placeholder: 'e.g. Apology for the outage on 3 Oct', minLength: 3, confirmLabel: `Extend by ${days} days` });
        if (!reason) return;
        act('/subscription/extend', { days: Number(days), reason });
    };

    const override = async () => {
        const value = await dialogs.prompt({ title: 'Seat limit for this organization only', body: 'Overrides the plan for this organization. Leave empty for unlimited.', label: 'Employee seats', inputType: 'number', minLength: 0, confirmLabel: 'Next' });
        if (value === null) return;
        const reason = await dialogs.prompt({ title: 'Why the exception?', label: 'Reason (recorded in the audit log)', minLength: 3, confirmLabel: 'Save override' });
        if (!reason) return;
        act('/entitlements', { key: 'maxMembers', value: value.trim() === '' ? null : Number(value), reason });
    };

    const limits = info.limits.limits;
    const overridden = new Set(Object.keys(info.overrides));
    const included = [
        ...MODULE_FIELDS.filter(f => info.limits.modules[f.key]),
        ...FEATURE_FIELDS.filter(f => info.limits.features[f.key]),
    ];

    return (
        <Section title="Plan and limits"
            description={planSummary(info, paidUntil)}
            actions={<Gauge size={16} className="ac-faint" />}>
            {info.seats.overLimit && (
                <p className="mb-4 rounded-xl px-3 py-2 text-[13px] bg-[var(--ac-warn-bg)] text-[var(--ac-warn)]">
                    Over the seat limit. Existing members keep working; new ones are blocked until someone is disabled.
                </p>
            )}
            <dl className="ac-grid-fit !gap-x-5 !gap-y-4" style={{ ['--ac-min' as string]: '8.5rem' }}>
                {LIMIT_FIELDS.filter(f => f.key in limits).map(f => (
                    <Detail key={f.key} label={f.label}>
                        <span className="tabular-nums">{fmtLimit(limits[f.key])}</span>
                        {overridden.has(f.key) && <span className="ml-1.5 align-middle"><StatusPill tone="warn">override</StatusPill></span>}
                    </Detail>
                ))}
            </dl>

            <p className="mt-6 mb-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-gray-600 dark:text-gray-400">Included</p>
            <div className="flex flex-wrap gap-1.5">
                {included.length === 0 ? <span className="text-[13px] ac-faint">Nothing</span>
                    : included.map(f => (
                        <span key={f.key} className="neu-badge">
                            {f.label}
                            {overridden.has(f.key) && <span className="ml-1 text-[var(--ac-warn)]">· override</span>}
                        </span>
                    ))}
            </div>

            <div className="mt-6 rounded-2xl neu-inset p-3.5 space-y-3">
                <div className="flex flex-wrap gap-2 items-end">
                    <Field label="Change plan" htmlFor="sub-plan" className="flex-1 min-w-[min(100%,15rem)]">
                        <Select id="sub-plan" value={choice} onChange={e => setChoice(e.target.value)} disabled={!options}>
                            <option value="">{options ? 'Choose a published version…' : 'Loading versions…'}</option>
                            {(options ?? []).map(o => <option key={o.versionId} value={o.versionId}>{o.name} v{o.version} ({BILLING_LABEL[o.billingType] ?? o.billingType})</option>)}
                        </Select>
                    </Field>
                    <Button variant="primary" onClick={() => assign(false)} disabled={busy || !choice}>{hasPlan ? 'Move' : 'Assign'}</Button>
                    <Button onClick={() => assign(true)} disabled={busy || !choice}>Assign &amp; waive payment</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button onClick={extend} disabled={busy || !hasPlan}>{sub.status === 'trialing' ? 'Extend trial' : 'Extend plan'}</Button>
                    <Button onClick={override} disabled={busy}>Override seat limit</Button>
                </div>
            </div>
        </Section>
    );
};

/** Whether this organization's workspace can make payment links with this account right now. */
const LinksStatus: React.FC<{ info: Razorpay }> = ({ info }) => {
    if (info.status !== 'verified') return <StatusPill tone="bad">Blocked until the keys are verified</StatusPill>;
    if (info.mode === 'live') return <StatusPill tone="ok">Live: real payments</StatusPill>;
    return info.allowTestLinks
        ? <StatusPill tone="warn">TEST links allowed (no real money)</StatusPill>
        : <StatusPill tone="bad">Test keys: links refused in production</StatusPill>;
};

/** A connected account: its key, mode, status, webhook secret and whether the app's links use it. */
const RazorpayDetails: React.FC<{ info: Razorpay }> = ({ info }) => (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
        <Detail label="Key"><span className="font-mono text-[12px]">{info.keyIdHint}</span></Detail>
        <Detail label="Mode">{info.mode === 'live' ? 'Live' : 'Test'}</Detail>
        <Detail label="Status"><StatusPill tone={connectionTone(info)}>{info.status ?? 'saved'}</StatusPill></Detail>
        <Detail label="Last verified">{info.lastVerifiedAt ? timeAgo(info.lastVerifiedAt) : 'Never'}</Detail>
        <div className="col-span-2">
            <Detail label="Webhook secret">{info.hasWebhookSecret ? 'Set' : <span className="text-[var(--ac-warn)]">Not set: payment updates will not arrive</span>}</Detail>
        </div>
        {info.lastError && <p className="col-span-2 text-[13px] text-[var(--ac-bad)] break-words">{info.lastError}</p>}
        <div className="col-span-2">
            <Detail label="Payment links"><LinksStatus info={info} /></Detail>
        </div>
        <WebhookHealthRow info={info} />
        {info.legacyAppAccount && (
            <p className="col-span-2 text-[12px] text-[var(--ac-warn)]">The retired “use for the app’s payment links” setting still names this account. It no longer decides anything; clear it below.</p>
        )}
    </dl>
);

/** New keys for the account. The secrets are never shown again once saved. */
const RazorpayKeysForm: React.FC<{ path: string; reauth: Reauth; hasWebhookSecret: boolean; onSaved: (next: Razorpay) => void; onCancel: () => void }> = ({ path, reauth, hasWebhookSecret, onSaved, onCancel }) => {
    const [keyId, setKeyId] = useState('');
    const [keySecret, setKeySecret] = useState('');
    const [webhookSecret, setWebhookSecret] = useState('');
    const [busy, setBusy] = useState(false);
    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBusy(true);
        const next = await guarded(reauth, () => api<Razorpay>(path, { method: 'PUT', ...json({ keyId, keySecret, webhookSecret }) }));
        setBusy(false);
        if (!next) return;
        onSaved(next);
        toast.success('Razorpay keys saved. Verify them next.');
    };
    return (
        <form onSubmit={save} className="mt-4 grid gap-3 rounded-2xl neu-inset p-3.5">
            <Field label="Key ID" htmlFor="rz-id" hint="rzp_test_… for testing, rzp_live_… for real payments.">
                <Input id="rz-id" required value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Key secret" htmlFor="rz-secret">
                <Input id="rz-secret" type="password" required value={keySecret} onChange={e => setKeySecret(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Webhook secret" htmlFor="rz-wh" hint={hasWebhookSecret ? 'Leave blank to keep the current one. A new one replaces it; the old one keeps working for 24 hours for Razorpay’s retries.' : 'The secret you type when creating the webhook in Razorpay.'}>
                <Input id="rz-wh" type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save keys'}</Button>
                <Button type="button" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
};

const RazorpayCard: React.FC<{ path: string; info: Razorpay; reauth: Reauth; onChange: (r: Razorpay) => void; onReload: () => void }> = ({ path, info, reauth, onChange, onReload }) => {
    const dialogs = useDialogs();
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);

    const verify = async () => {
        setBusy(true);
        const r = await guarded(reauth, () => api<{ status: string; error: string | null }>(`${path}/verify`, { method: 'POST' }));
        setBusy(false);
        if (r) {
            if (r.status === 'verified') toast.success('Razorpay accepted the keys'); else toast.error(r.error ?? 'Verification failed');
            onReload();
        }
    };

    const clearLegacy = async () => {
        setBusy(true);
        const next = await guarded(reauth, () => api<Razorpay>(`${path}/app`, { method: 'DELETE' }));
        setBusy(false);
        if (next) { onChange(next); toast.success('Old setting cleared'); }
    };

    const setTestLinks = async (allow: boolean) => {
        if (allow && !(await dialogs.confirm({
            title: 'Allow TEST payment links?',
            body: "This account has test keys: customers paying these links aren't charged and the business receives nothing. Only for trying the flow. The app labels every such link TEST and leaves it out of its totals.",
            confirmLabel: 'Allow test links',
        }))) return;
        setBusy(true);
        const next = await guarded(reauth, () => api<Razorpay>(`${path}/test-links`, { method: 'PUT', ...json({ allow }) }));
        setBusy(false);
        if (next) { onChange(next); toast.success(allow ? 'Test links allowed' : 'Test links stopped'); }
    };

    const disconnect = async () => {
        if (!(await dialogs.confirm({ title: 'Disconnect Razorpay?', body: 'Payment links and payment notifications for this organization stop working until it is connected again. Links already made stay in its records.', confirmLabel: 'Disconnect', danger: true }))) return;
        const next = await guarded(reauth, () => api<Razorpay>(path, { method: 'DELETE' }));
        if (next) { onChange(next); toast.success('Disconnected'); }
    };

    return (
        <Section title="Customer payments"
            description="Payments this organization collects go to its own Razorpay account, never the platform's. Secrets are stored encrypted and never shown again."
            actions={<CreditCard size={16} className="ac-faint" />}>
            {info.connected ? (
                <RazorpayDetails info={info} />
            ) : (
                <EmptyState compact icon={<CreditCard size={20} />} title="No Razorpay account linked" body="Link one when this organization wants to take payments from its customers." />
            )}

            <details className="mt-4 group">
                <summary className="cursor-pointer text-[12px] ac-muted select-none list-none flex items-center gap-1">
                    <ChevronDown size={14} className="transition-transform group-open:rotate-180" /> Webhook set-up
                </summary>
                <div className="mt-2 text-[12px] space-y-1.5 ac-muted">
                    <p>Razorpay → Settings → Webhooks, this address:</p>
                    <p className="font-mono break-all select-all rounded-lg neu-inset px-2.5 py-2 text-[var(--ac-text)]">{info.webhookUrl}</p>
                    <p>Events: payment_link.paid, payment_link.partially_paid, payment_link.cancelled, payment_link.expired, refund.created, refund.processed, refund.failed. Use the same secret as the webhook secret here.</p>
                </div>
            </details>

            {editing ? (
                <RazorpayKeysForm path={path} reauth={reauth} hasWebhookSecret={!!info.hasWebhookSecret}
                    onSaved={next => { onChange(next); setEditing(false); }} onCancel={() => setEditing(false)} />
            ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant={info.connected ? 'default' : 'primary'} onClick={() => setEditing(true)}>{info.connected ? 'Replace keys' : 'Connect Razorpay'}</Button>
                    {info.connected && <Button onClick={verify} disabled={busy}>{busy ? 'Checking…' : 'Verify keys'}</Button>}
                    {info.connected && info.mode === 'test' && <Button onClick={() => void setTestLinks(!info.allowTestLinks)} disabled={busy}>{info.allowTestLinks ? 'Stop test links' : 'Allow test links'}</Button>}
                    {info.legacyAppAccount && <Button onClick={() => void clearLegacy()} disabled={busy}>Clear old app setting</Button>}
                    {info.connected && <Button variant="danger" onClick={disconnect}>Disconnect</Button>}
                </div>
            )}
        </Section>
    );
};
