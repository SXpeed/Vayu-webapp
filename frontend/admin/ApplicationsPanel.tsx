// The approval queue: every business that has applied, and the decisions.
//
// Approve · ask for more information · reject with a reason · change the
// requested plan · approve with a documented billing exception. Approval is
// safe to repeat: a failed setup is retried by approving again.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, MessageSquare, XCircle } from 'lucide-react';
import { Badge, Button, Card, Field, Input, SectionTitle, Select, Textarea } from '../components/ui';
import { api, guarded, postJson, timeAgo, type ApiError, type Reauth } from './api';

interface Row {
    id: string; review_status: string; provisioning_status: string; business_name: string; business_type: string;
    requested_plan_key: string; expected_employees: number | null; submitted_at: number | null; decided_at: number | null;
    org_id: string | null; email: string; email_verified: number;
}

interface Detail {
    application: Record<string, unknown> & {
        id: string; status: string; reviewStatus: string; provisioningStatus: string; businessName: string; businessType: string;
        requestedPlanKey: string; billingCycle: string; providerMessage: string | null; provisioningError: string | null;
        billingExceptionReason: string | null; orgId: string | null;
    };
    applicant: { id: string; name: string; email: string; emailVerified: number; createdAt: string };
    events: { at: number; actor_kind: string; action: string; message: string | null; visible_to_applicant: number }[];
}

const FILTERS: [string, string][] = [
    ['pending_review', 'To review'], ['needs_information', 'Waiting on applicant'], ['approved', 'Approved'],
    ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['', 'All'],
];

const STATUS_LABEL: Record<string, string> = {
    draft: 'Draft', pending_review: 'To review', needs_information: 'Waiting on applicant', approved: 'Approved',
    rejected: 'Rejected', withdrawn: 'Withdrawn', provisioning: 'Setting up', provisioning_failed: 'Setup failed',
    payment_required: 'Awaiting payment', active: 'Active', suspended: 'Suspended', trial_expired: 'Trial expired', closed: 'Closed',
};

export const ApplicationsPanel: React.FC<{ reauth: Reauth; focusId?: string; onCountsChange?: () => void }> = ({ reauth, focusId, onCountsChange }) => {
    const [openId, setOpenId] = useState<string | null>(focusId ?? null);
    useEffect(() => { if (focusId) setOpenId(focusId); }, [focusId]);
    return openId
        ? <ApplicationDetail id={openId} reauth={reauth} onBack={() => { setOpenId(null); onCountsChange?.(); }} onChange={onCountsChange} />
        : <ApplicationList onOpen={setOpenId} />;
};

const ApplicationList: React.FC<{ onOpen: (id: string) => void }> = ({ onOpen }) => {
    const [filter, setFilter] = useState('pending_review');
    const [data, setData] = useState<{ applications: Row[]; counts: Record<string, number> } | null>(null);

    useEffect(() => {
        setData(null);
        api<{ applications: Row[]; counts: Record<string, number> }>(`/admin/applications${filter ? `?status=${filter}` : ''}`)
            .then(setData).catch(e => toast.error((e as ApiError).message));
    }, [filter]);

    return (
        <Card padding="lg">
            <SectionTitle actions={<ClipboardList size={16} />}>Applications</SectionTitle>
            <div className="flex flex-wrap gap-2 mb-4">
                {FILTERS.map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setFilter(value)}
                        className={`neu-pill ${filter === value ? 'neu-pill-active' : ''}`}>
                        {label}{value && data?.counts[value] ? ` · ${data.counts[value]}` : ''}
                    </button>
                ))}
            </div>
            {!data ? <p className="text-sm">Loading…</p> : data.applications.length === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">Nothing here.</p>
            ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                    {data.applications.map(a => (
                        <li key={a.id}>
                            <button type="button" onClick={() => onOpen(a.id)} className="w-full text-left py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
                                <span className="font-medium text-gray-900 dark:text-gray-100">{a.business_name || 'Untitled'}</span>
                                <span className="text-[12px] text-gray-600 dark:text-gray-400">{a.business_type} · {a.requested_plan_key || 'no plan'}</span>
                                {!a.email_verified && <Badge>email unverified</Badge>}
                                {a.provisioning_status === 'failed' && <Badge>setup failed</Badge>}
                                <span className="text-[12px] text-gray-600 dark:text-gray-400 ml-auto">
                                    {a.email} · {timeAgo(a.submitted_at)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
};

interface VersionOption { id: string; label: string; planKey: string }

const ApplicationDetail: React.FC<{ id: string; reauth: Reauth; onBack: () => void; onChange?: () => void }> = ({ id, reauth, onBack, onChange }) => {
    const [d, setD] = useState<Detail | null>(null);
    const [versions, setVersions] = useState<VersionOption[]>([]);
    const [versionId, setVersionId] = useState('');
    const [waive, setWaive] = useState(false);
    const [exceptionReason, setExceptionReason] = useState('');
    const [messageText, setMessageText] = useState('');
    const [mode, setMode] = useState<'none' | 'info' | 'reject' | 'plan'>('none');
    const [newPlanKey, setNewPlanKey] = useState('');
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try { setD(await api<Detail>(`/admin/applications/${id}`)); } catch (e) { toast.error((e as ApiError).message); }
    }, [id]);
    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        (async () => {
            const { plans } = await api<{ plans: { id: string; key: string; name: string }[] }>('/admin/plans');
            const opts: VersionOption[] = [];
            for (const p of plans) {
                const detail = await api<{ versions: { id: string; version: number; status: string; billing_type: string }[] }>(`/admin/plans/${p.id}`);
                for (const v of detail.versions.filter(x => x.status === 'published')) {
                    opts.push({ id: v.id, planKey: p.key, label: `${p.name} v${v.version} (${v.billing_type})` });
                }
            }
            setVersions(opts);
        })().catch(() => setVersions([]));
    }, []);

    if (!d) return <Card><p className="text-sm">Loading application…</p></Card>;
    const a = d.application;
    const open = ['pending_review', 'needs_information'].includes(a.reviewStatus);
    const canRetry = a.reviewStatus === 'approved' && a.provisioningStatus === 'failed';
    const defaultVersion = versions.find(v => v.planKey === a.requestedPlanKey)?.id ?? '';

    const act = async (path: string, body: Record<string, unknown>, done: string) => {
        setBusy(true);
        const next = await guarded(reauth, () => api<Detail>(`/admin/applications/${id}/${path}`, postJson(body)), m => toast.error(m));
        setBusy(false);
        if (next) {
            setD(next);
            setMode('none');
            setMessageText('');
            toast.success(done);
            onChange?.();
        }
    };

    const field = (label: string, value: unknown) => (
        <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400">{label}</p>
            <p className="text-sm text-gray-900 dark:text-gray-100 break-words">{value === null || value === '' || value === undefined ? '—' : String(value)}</p>
        </div>
    );

    return (
        <div className="space-y-6">
            <Card padding="lg">
                <button type="button" onClick={onBack} className="text-[12px] text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
                    <ArrowLeft size={14} /> All applications
                </button>
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-serif text-xl text-gray-900 dark:text-gray-100">{a.businessName}</h2>
                    <Badge>{STATUS_LABEL[a.status] ?? a.status}</Badge>
                </div>
                <p className="text-[12px] text-gray-600 dark:text-gray-400 mt-1">
                    {d.applicant.name} · {d.applicant.email} · account created {timeAgo(d.applicant.createdAt)}
                </p>
                {!d.applicant.emailVerified && (
                    <p className="mt-3 text-[12px] flex items-start gap-2 text-amber-700 dark:text-amber-400">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        This email address has not been verified (no email provider is configured yet). Confirm the applicant is who they say before approving.
                    </p>
                )}
                {a.provisioningError && (
                    <p className="mt-3 text-[12px] flex items-start gap-2 text-red-700 dark:text-red-400">
                        <XCircle size={14} className="mt-0.5 shrink-0" />Setup failed: {a.provisioningError}. Fix the cause, then approve again to retry — nothing is duplicated.
                    </p>
                )}
            </Card>

            <Card padding="lg">
                <SectionTitle>Business details</SectionTitle>
                <div className="grid gap-4 sm:grid-cols-3">
                    {field('Business type', a.businessType)}
                    {field('Owner', a.ownerName)}
                    {field('Phone', a.phone)}
                    {field('Address', [a.addressLine, a.city, a.region, a.postalCode].filter(Boolean).join(', '))}
                    {field('Country · time zone', `${a.country || '—'} · ${a.timezone || '—'}`)}
                    {field('Website', a.website)}
                    {field('Tax ID', a.taxId)}
                    {field('Expected employees · stores', `${a.expectedEmployees ?? '—'} · ${a.expectedStores ?? '—'}`)}
                    {field('Requested plan', `${a.requestedPlanKey} (${a.billingCycle})`)}
                </div>
                {a.applicantNote ? <div className="mt-4">{field('Note from the applicant', a.applicantNote)}</div> : null}
                {a.billingExceptionReason && <div className="mt-4">{field('Billing exception', a.billingExceptionReason)}</div>}
            </Card>

            {(open || canRetry) && (
                <Card padding="lg">
                    <SectionTitle actions={<CheckCircle2 size={16} />}>Decision</SectionTitle>
                    <div className="grid gap-3 sm:grid-cols-2 items-end">
                        <Field label="Approve with plan version" htmlFor="ap-ver" hint="Defaults to the latest published version of the plan they asked for.">
                            <Select id="ap-ver" value={versionId || defaultVersion} onChange={e => setVersionId(e.target.value)}>
                                <option value="">Choose…</option>
                                {versions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                            </Select>
                        </Field>
                        <label className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-200 pb-2">
                            <input type="checkbox" checked={waive} onChange={e => setWaive(e.target.checked)} />
                            Billing exception: activate without payment
                        </label>
                    </div>
                    {waive && (
                        <Field label="Reason for the exception" htmlFor="ap-reason" hint="Recorded on the application and in the audit log." className="mt-3">
                            <Input id="ap-reason" value={exceptionReason} onChange={e => setExceptionReason(e.target.value)} placeholder="e.g. pilot customer, free for 3 months" />
                        </Field>
                    )}
                    <div className="mt-4 flex flex-wrap gap-2">
                        <Button variant="primary" disabled={busy}
                            onClick={() => act('approve', { planVersionId: versionId || defaultVersion || undefined, waivePayment: waive, reason: waive ? exceptionReason : undefined },
                                canRetry ? 'Setup retried' : 'Approved')}>
                            {canRetry ? 'Retry setup' : 'Approve'}
                        </Button>
                        {open && <Button icon={<MessageSquare size={16} />} onClick={() => setMode(mode === 'info' ? 'none' : 'info')}>Ask for information</Button>}
                        {open && <Button onClick={() => setMode(mode === 'plan' ? 'none' : 'plan')}>Change plan</Button>}
                        {open && <Button variant="danger" onClick={() => setMode(mode === 'reject' ? 'none' : 'reject')}>Reject</Button>}
                    </div>

                    {(mode === 'info' || mode === 'reject') && (
                        <div className="mt-4 space-y-2">
                            <Field label={mode === 'info' ? 'What do you need from them?' : 'Why is it being rejected?'} htmlFor="ap-msg"
                                hint="The applicant sees this on their status page.">
                                <Textarea id="ap-msg" rows={3} value={messageText} onChange={e => setMessageText(e.target.value)} />
                            </Field>
                            <Button variant={mode === 'reject' ? 'danger' : 'primary'} disabled={busy}
                                onClick={() => mode === 'info'
                                    ? act('request-info', { message: messageText }, 'Sent back for information')
                                    : act('reject', { reason: messageText }, 'Rejected')}>
                                {mode === 'info' ? 'Send request' : 'Reject application'}
                            </Button>
                        </div>
                    )}
                    {mode === 'plan' && (
                        <div className="mt-4 grid gap-3 sm:grid-cols-2 items-end">
                            <Field label="New plan" htmlFor="ap-plan">
                                <Select id="ap-plan" value={newPlanKey} onChange={e => setNewPlanKey(e.target.value)}>
                                    <option value="">Choose…</option>
                                    {[...new Set(versions.map(v => v.planKey))].map(k => <option key={k} value={k}>{k}</option>)}
                                </Select>
                            </Field>
                            <Field label="Reason" htmlFor="ap-plan-reason">
                                <Input id="ap-plan-reason" value={messageText} onChange={e => setMessageText(e.target.value)} />
                            </Field>
                            <Button disabled={busy} onClick={() => act('change-plan', { planKey: newPlanKey, reason: messageText }, 'Plan changed')}>Save plan change</Button>
                        </div>
                    )}
                </Card>
            )}

            <Card padding="lg">
                <SectionTitle>History</SectionTitle>
                <ol className="space-y-3">
                    {d.events.map((e, i) => (
                        <li key={i} className="flex gap-3 text-[13px]">
                            <span className="text-[11px] text-gray-600 dark:text-gray-400 w-24 shrink-0">{timeAgo(e.at)}</span>
                            <span className="flex-1">
                                <span className="font-medium text-gray-900 dark:text-gray-100">{e.action.replace(/_/g, ' ')}</span>
                                <span className="text-gray-600 dark:text-gray-400"> · {e.actor_kind.replace('_', ' ')}</span>
                                {!e.visible_to_applicant && <span className="text-[11px] text-gray-500"> · internal</span>}
                                {e.message && <span className="block text-gray-700 dark:text-gray-300">{e.message}</span>}
                            </span>
                        </li>
                    ))}
                </ol>
            </Card>
        </div>
    );
};
