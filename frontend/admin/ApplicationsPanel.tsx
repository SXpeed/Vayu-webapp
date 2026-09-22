// The approval queue.
//
//   #/applications        the queue, filterable and searchable
//   #/applications/:id    the same queue with one application open alongside
//
// Opening an application slides a panel over the list rather than replacing
// it, so the list keeps its place and scroll. Decisions use dialogs, never the
// browser's own pop-ups. Approval is safe to repeat: a failed set-up is
// retried by approving again, and nothing is ever duplicated.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, ClipboardList, MessageSquare, Search, XCircle } from 'lucide-react';
import { Field, Input, Select } from '../components/ui';
import { api, guarded, postJson, timeAgo, type ApiError, type Reauth } from './api';
import { Detail, Drawer, EmptyState, PageHeader, Section, Segmented, SkeletonRows, StatusPill, useDialogs } from './kit';

interface Row {
    id: string; review_status: string; provisioning_status: string; business_name: string; business_type: string;
    requested_plan_key: string; expected_employees: number | null; submitted_at: number | null; decided_at: number | null;
    org_id: string | null; email: string; email_verified: number; updated_at: number;
}

interface AppDetail {
    application: Record<string, unknown> & {
        id: string; status: string; reviewStatus: string; provisioningStatus: string; businessName: string; businessType: string;
        ownerName: string; phone: string; addressLine: string; city: string; region: string; postalCode: string; country: string;
        timezone: string; website: string; taxId: string; expectedEmployees: number | null; expectedStores: number | null;
        requestedPlanKey: string; billingCycle: string; applicantNote: string; providerMessage: string | null;
        provisioningError: string | null; billingExceptionReason: string | null; orgId: string | null;
    };
    applicant: { id: string; name: string; email: string; emailVerified: number; createdAt: string };
    events: { at: number; actor_kind: string; action: string; message: string | null; visible_to_applicant: number }[];
}

interface VersionOption { id: string; label: string; planKey: string }

const FILTERS = [
    { value: 'pending_review', label: 'To review' },
    { value: 'needs_information', label: 'Waiting on applicant' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'withdrawn', label: 'Withdrawn' },
    { value: '', label: 'All' },
];

/** Published plan versions, loaded once per visit. */
let versionsCache: Promise<VersionOption[]> | null = null;
function loadVersions(): Promise<VersionOption[]> {
    return (versionsCache ??= (async () => {
        const { plans } = await api<{ plans: { id: string; key: string; name: string }[] }>('/admin/plans');
        const details = await Promise.all(plans.map(p => api<{ versions: { id: string; version: number; status: string; billing_type: string }[] }>(`/admin/plans/${p.id}`).then(d => ({ p, d }))));
        return details.flatMap(({ p, d }) => d.versions.filter(v => v.status === 'published').map(v => ({ id: v.id, planKey: p.key, label: `${p.name} · v${v.version} · ${v.billing_type}` })));
    })().catch(e => { versionsCache = null; throw e; }));
}

export const ApplicationsPanel: React.FC<{ reauth: Reauth; routeId?: string; go: (section: string, id?: string) => void; onCountsChange?: () => void }> = ({ reauth, routeId, go, onCountsChange }) => {
    const [filter, setFilter] = useState('pending_review');
    const [q, setQ] = useState('');
    const [data, setData] = useState<{ applications: Row[]; counts: Record<string, number> } | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await api(`/admin/applications${filter ? `?status=${filter}` : ''}`));
        } catch (e) { toast.error((e as ApiError).message); }
    }, [filter]);
    // Switching filters keeps the old rows until the new ones arrive: no flash.
    useEffect(() => { load(); }, [load]);

    const term = q.trim().toLowerCase();
    const rows = useMemo(() => (data?.applications ?? []).filter(a => !term
        || a.business_name.toLowerCase().includes(term) || a.email.toLowerCase().includes(term)
        || a.requested_plan_key.toLowerCase().includes(term)), [data, term]);

    return (
        <div className="space-y-6">
            <PageHeader title="Applications" description="Businesses asking to join. Approving sets up their workspace; nothing is charged before you decide." />

            <Section>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between mb-4">
                    <Segmented value={filter} onChange={setFilter}
                        options={FILTERS.map(f => ({ value: f.value, label: f.label, count: f.value ? data?.counts[f.value] : undefined }))} />
                    <div className="relative lg:w-72">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 ac-faint pointer-events-none" />
                        <Input className="!pl-9" placeholder="Search business, email, plan…" value={q} onChange={e => setQ(e.target.value)} />
                    </div>
                </div>

                {!data ? <SkeletonRows rows={6} /> : rows.length === 0 ? (
                    <EmptyState icon={<ClipboardList size={20} />} title={term ? 'No matches' : 'Nothing here'}
                        body={filter === 'pending_review' && !term ? 'No application is waiting for a decision.' : undefined} />
                ) : (
                    <ul className="ac-divide -mx-2">
                        {rows.map(a => (
                            <li key={a.id}>
                                <button type="button" onClick={() => go('applications', a.id)}
                                    className="ac-row w-full text-left px-2 py-3 grid items-center gap-x-4 gap-y-1 grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                                    <span className="min-w-0">
                                        <span className="block text-sm font-medium truncate">{a.business_name || 'Untitled'}</span>
                                        <span className="block text-[12px] ac-faint truncate">{a.email}</span>
                                    </span>
                                    <span className="hidden md:block text-[13px] ac-muted truncate capitalize">{a.business_type.replace('_', ' ')} · {a.requested_plan_key || 'no plan'}</span>
                                    <span className="hidden md:block text-[12px] ac-faint">{timeAgo(a.submitted_at ?? a.updated_at)}</span>
                                    <span className="flex flex-wrap justify-end gap-1.5">
                                        {a.provisioning_status === 'failed' ? <StatusPill status="provisioning_failed" /> : <StatusPill status={a.review_status} />}
                                        {!a.email_verified && a.review_status === 'pending_review' && <StatusPill tone="neutral">unverified</StatusPill>}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <ApplicationDrawer id={routeId} reauth={reauth} onClose={() => go('applications')}
                onChanged={() => { load(); onCountsChange?.(); }} />
        </div>
    );
};

const ApplicationDrawer: React.FC<{ id?: string; reauth: Reauth; onClose: () => void; onChanged: () => void }> = ({ id, reauth, onClose, onChanged }) => {
    const dialogs = useDialogs();
    const [d, setD] = useState<AppDetail | null>(null);
    const [versions, setVersions] = useState<VersionOption[]>([]);
    const [versionId, setVersionId] = useState('');
    const [waive, setWaive] = useState(false);
    const [exception, setException] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setD(null); setVersionId(''); setWaive(false); setException('');
        if (!id) return;
        api<AppDetail>(`/admin/applications/${id}`).then(setD).catch(e => toast.error((e as ApiError).message));
        loadVersions().then(setVersions).catch(() => setVersions([]));
    }, [id]);

    const act = async (path: string, body: Record<string, unknown>, done: string) => {
        if (!id) return;
        setBusy(true);
        const next = await guarded(reauth, () => api<AppDetail>(`/admin/applications/${id}/${path}`, postJson(body)), m => toast.error(m));
        setBusy(false);
        if (next) { setD(next); toast.success(done); onChanged(); }
    };

    const a = d?.application;
    const open = !!a && ['pending_review', 'needs_information'].includes(a.reviewStatus);
    const retry = !!a && a.reviewStatus === 'approved' && a.provisioningStatus === 'failed';
    const defaultVersion = versions.find(v => v.planKey === a?.requestedPlanKey)?.id ?? '';
    const chosen = versionId || defaultVersion;

    const askInfo = async () => {
        const message = await dialogs.prompt({ title: 'Ask for more information', body: 'The applicant sees this on their status page and can reply by updating the application.', label: 'Your question', multiline: true, minLength: 3, confirmLabel: 'Send' });
        if (message) await act('request-info', { message }, 'Sent back for information');
    };
    const reject = async () => {
        const reason = await dialogs.prompt({ title: 'Reject this application?', body: 'The applicant sees the reason. This cannot be undone; they can apply again.', label: 'Reason', multiline: true, minLength: 3, confirmLabel: 'Reject', danger: true });
        if (reason) await act('reject', { reason }, 'Rejected');
    };
    const changePlan = async () => {
        const keys = [...new Set(versions.map(v => v.planKey))];
        const planKey = await dialogs.prompt({ title: 'Change the requested plan', label: `Plan key (${keys.join(', ') || 'none published'})`, defaultValue: a?.requestedPlanKey, minLength: 1, confirmLabel: 'Next' });
        if (!planKey) return;
        const reason = await dialogs.prompt({ title: 'Why the change?', label: 'Reason', minLength: 3, confirmLabel: 'Change plan', hint: 'Recorded on the application and in the audit log.' });
        if (reason) await act('change-plan', { planKey, reason }, 'Plan changed');
    };

    return (
        <Drawer open={!!id} onClose={onClose} width={720}
            title={a?.businessName ?? 'Application'}
            meta={a && <StatusPill status={a.status} />}
            subtitle={d && `${d.applicant.name} · ${d.applicant.email} · account created ${timeAgo(d.applicant.createdAt)}`}
            footer={(open || retry) && d ? (
                <>
                    {open && <button type="button" className="neu-button" onClick={askInfo} disabled={busy}><MessageSquare size={15} /> Ask for information</button>}
                    {open && <button type="button" className="neu-button neu-button-danger" onClick={reject} disabled={busy}><XCircle size={15} /> Reject</button>}
                    <button type="button" className="neu-button neu-button-primary" disabled={busy || !chosen || (waive && exception.trim().length < 3)}
                        onClick={() => act('approve', { planVersionId: chosen || undefined, waivePayment: waive, reason: waive ? exception : undefined }, retry ? 'Setup retried' : 'Approved')}>
                        <CheckCircle2 size={15} /> {busy ? 'Working…' : retry ? 'Retry setup' : 'Approve'}
                    </button>
                </>
            ) : undefined}>
            {!d || !a ? <SkeletonRows rows={6} /> : (
                <>
                    {!d.applicant.emailVerified && open && (
                        <div className="neu-inset rounded-[14px] p-3.5 flex items-start gap-2.5 text-[13px] text-[var(--ac-warn)]">
                            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                            <span>This email address is not verified yet (no email provider is connected). Make sure the applicant is genuine before approving.</span>
                        </div>
                    )}
                    {a.provisioningError && (
                        <div className="neu-inset rounded-[14px] p-3.5 flex items-start gap-2.5 text-[13px] text-[var(--ac-bad)]">
                            <XCircle size={16} className="mt-0.5 shrink-0" />
                            <span>Setup failed: {a.provisioningError}. Fix the cause, then press <strong>Retry setup</strong> — nothing is duplicated.</span>
                        </div>
                    )}

                    <Section title="Business">
                        <dl className="ac-grid-fit !gap-x-5 !gap-y-4" style={{ ['--ac-min' as string]: '11rem' }}>
                            <Detail label="Type"><span className="capitalize">{a.businessType.replace('_', ' ')}</span></Detail>
                            <Detail label="Owner">{a.ownerName}</Detail>
                            <Detail label="Phone">{a.phone}</Detail>
                            <Detail label="Address">{[a.addressLine, a.city, a.region, a.postalCode].filter(Boolean).join(', ')}</Detail>
                            <Detail label="Country · time zone">{`${a.country || '—'} · ${a.timezone || '—'}`}</Detail>
                            <Detail label="Website">{a.website ? <a href={a.website} target="_blank" rel="noreferrer noopener" className="text-[var(--ac-accent)] break-all">{a.website}</a> : null}</Detail>
                            <Detail label="Tax ID">{a.taxId}</Detail>
                            <Detail label="People · stores">{`${a.expectedEmployees ?? '—'} · ${a.expectedStores ?? '—'}`}</Detail>
                            <Detail label="Requested plan">{`${a.requestedPlanKey || '—'} · ${a.billingCycle}`}</Detail>
                        </dl>
                        {a.applicantNote && <div className="mt-4"><Detail label="Note from the applicant">{a.applicantNote}</Detail></div>}
                        {a.billingExceptionReason && <div className="mt-4"><Detail label="Billing exception">{a.billingExceptionReason}</Detail></div>}
                    </Section>

                    {(open || retry) && (
                        <Section title="Approval" description="Creates the organization, its own database, the owner and the subscription.">
                            <div className="space-y-4">
                                <Field label="Plan version" htmlFor="ap-ver" hint="Defaults to the latest published version of the plan they asked for.">
                                    <Select id="ap-ver" value={chosen} onChange={e => setVersionId(e.target.value)}>
                                        <option value="">Choose…</option>
                                        {versions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                                    </Select>
                                </Field>
                                <label className={`ac-check ${waive ? 'is-on' : ''}`}>
                                    <input type="checkbox" className="sr-only" checked={waive} onChange={e => setWaive(e.target.checked)} />
                                    <span className="box">{waive && <CheckCircle2 size={13} />}</span>
                                    <span><span className="block text-sm font-medium">Billing exception</span><span className="block text-[12px] ac-muted">Activate without payment. A reason is required and recorded.</span></span>
                                </label>
                                {/* Always rendered so ticking the box never shifts the layout. */}
                                <Field label="Reason for the exception" htmlFor="ap-reason">
                                    <Input id="ap-reason" disabled={!waive} value={exception} onChange={e => setException(e.target.value)} placeholder={waive ? 'e.g. pilot customer, free for 3 months' : 'Only needed for an exception'} />
                                </Field>
                                {open && <button type="button" className="text-[13px] text-[var(--ac-accent)] font-medium" onClick={changePlan}>Change the requested plan…</button>}
                            </div>
                        </Section>
                    )}

                    <Section title="History">
                        <ol className="relative space-y-4 pl-5 before:absolute before:left-[0.35rem] before:top-1 before:bottom-1 before:w-px before:bg-[var(--ac-line)]">
                            {d.events.map((e, i) => (
                                <li key={i} className="relative">
                                    <span className="absolute -left-[1.1rem] top-1.5 w-2.5 h-2.5 rounded-full bg-[var(--ac-accent)] shadow-[0_0_0_3px_var(--ac-bg)]" />
                                    <p className="text-sm">
                                        <span className="font-medium">{e.action.replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase())}</span>
                                        <span className="ac-faint"> · {e.actor_kind.replace('_', ' ')} · {timeAgo(e.at)}</span>
                                        {!e.visible_to_applicant && <StatusPill tone="neutral">internal</StatusPill>}
                                    </p>
                                    {e.message && <p className="mt-0.5 text-[13px] ac-muted break-words">{e.message}</p>}
                                </li>
                            ))}
                        </ol>
                    </Section>
                </>
            )}
        </Drawer>
    );
};
