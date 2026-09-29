// Billing: the platform's own Razorpay account, which organizations pay their
// plans into (Admin → Plan in the app), and every plan payment with
// Razorpay's full record. Convenience only: the server checks everything.

import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ChevronDown, CreditCard, IndianRupee, Receipt, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Field, Input } from '../components/ui';
import { Detail, EmptyState, STAT_TILE_H, Section, Segmented, Skeleton, SkeletonRows, StatTile, StatusPill, useDialogs, type Tone } from './kit';
import { api, guarded as sharedGuarded, timeAgo, type ApiError, type Reauth } from './api';
import { PlanPaymentRow } from '../components/PlanPanel';
import { formatRupees } from '../components/PaymentAttempts';
import type { PlanPayment } from '../services/billingService';

interface Account {
    connected: boolean;
    webhookUrl: string;
    secretsConfigured: boolean;
    mode?: 'test' | 'live';
    keyIdHint?: string;
    hasWebhookSecret?: boolean;
    status?: 'unverified' | 'verified' | 'failed';
    lastVerifiedAt?: number | null;
    lastError?: string | null;
    connectedAt?: number;
}

type AdminPayment = PlanPayment & { orgId: string; orgName: string | null };

interface Summary { paidCount: number; paidAmount: number; paid30dCount: number; paid30dAmount: number; unfinished30dCount: number; testCount: number }

interface PaymentList {
    payments: AdminPayment[];
    summary: Summary;
}

const ACCOUNT_PATH = '/admin/billing/razorpay';

const guarded = <T,>(reauth: Reauth, fn: () => Promise<T>) => sharedGuarded(reauth, fn, (m) => toast.error(m));
const json = (body: unknown) => ({ body: JSON.stringify(body) });

const FILTERS = [
    { value: '', label: 'All' },
    { value: 'paid', label: 'Paid' },
    { value: 'attempted', label: 'Failed' },
    { value: 'created', label: 'Not completed' },
];

const recheck = (id: string) => api<{ payment: PlanPayment; checked: boolean; applied: boolean; reason: string | null }>(
    `/admin/billing/payments/${encodeURIComponent(id)}/recheck`, { method: 'POST' });

export const BillingPanel: React.FC<{ reauth: Reauth }> = ({ reauth }) => {
    const [account, setAccount] = useState<Account | null>(null);
    const [list, setList] = useState<PaymentList | null>(null);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(false);

    const loadAccount = useCallback(async () => {
        try { setAccount(await api<Account>(ACCOUNT_PATH)); } catch (e) { toast.error((e as ApiError).message); }
    }, []);
    const loadPayments = useCallback(async () => {
        setLoading(true);
        const query = filter ? `?status=${filter}` : '';
        try {
            setList(await api<PaymentList>(`/admin/billing/payments${query}`));
        } catch (e) {
            toast.error((e as ApiError).message);
        } finally {
            setLoading(false);
        }
    }, [filter]);
    useEffect(() => { void loadAccount(); }, [loadAccount]);
    useEffect(() => { void loadPayments(); }, [loadPayments]);

    return (
        <div className="space-y-6">
            <SummaryTiles summary={list?.summary} />

            {account ? <AccountCard info={account} reauth={reauth} onChange={setAccount} onReload={loadAccount} /> : <Skeleton className="h-48 rounded-2xl" />}

            <Section title="Plan payments"
                description="Every checkout an organization started from Admin → Plan in the app. Open one for Razorpay's full record; Recheck asks Razorpay again and applies a payment it finds paid."
                actions={<button type="button" onClick={() => void loadPayments()} className="neu-icon-btn-sm active-scale" aria-label="Refresh" title="Refresh">
                    <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
                </button>}>
                <div className="mb-4"><Segmented options={FILTERS} value={filter} onChange={setFilter} /></div>
                <PaymentRows payments={list?.payments} onChanged={() => void loadPayments()} />
            </Section>
        </div>
    );
};

const SummaryTiles: React.FC<{ summary: Summary | undefined }> = ({ summary: s }) => {
    if (!s) {
        return (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {[0, 1, 2].map(i => <Skeleton key={i} className={`${STAT_TILE_H} rounded-2xl`} />)}
            </div>
        );
    }
    const plural = s.paid30dCount === 1 ? '' : 's';
    const allTimeFoot = s.testCount ? `${s.paidCount} paid · ${s.testCount} test-mode not counted` : `${s.paidCount} paid`;
    return (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatTile icon={<IndianRupee size={16} />} label="Last 30 days" value={formatRupees(s.paid30dAmount)} foot={`${s.paid30dCount} payment${plural}`} />
            <StatTile icon={<Receipt size={16} />} label="All time" value={formatRupees(s.paidAmount)} foot={allTimeFoot} />
            <StatTile icon={<TriangleAlert size={16} />} label="Unfinished, 30 days" value={s.unfinished30dCount}
                tone={s.unfinished30dCount ? 'warn' : undefined} foot="Tried but not paid" />
        </div>
    );
};

const PaymentRows: React.FC<{ payments: AdminPayment[] | undefined; onChanged: () => void }> = ({ payments, onChanged }) => {
    const [open, setOpen] = useState<string | null>(null);
    if (!payments) return <SkeletonRows rows={4} />;
    if (payments.length === 0) {
        return <EmptyState compact icon={<Receipt size={20} />} title="No plan payments yet" body="They appear here as soon as an organization starts paying for a plan." />;
    }
    return (
        <ul className="space-y-2">
            {payments.map(p => (
                <PlanPaymentRow key={p.id} payment={p} open={open === p.id}
                    onToggle={() => setOpen(o => (o === p.id ? null : p.id))}
                    onChanged={onChanged}
                    recheck={recheck}
                    extra={<span className="font-medium text-[var(--neu-text)]">{p.orgName ?? 'Removed organization'} · </span>} />
            ))}
        </ul>
    );
};

/** The account's status as a pill: taking payments, failed, or waiting to be verified. */
function statusPill(info: Account): { tone: Tone; label: string } {
    if (info.status === 'verified') return { tone: 'ok', label: 'Taking payments' };
    return { tone: info.lastError ? 'bad' : 'warn', label: info.status ?? 'saved' };
}

const AccountDetails: React.FC<{ info: Account }> = ({ info }) => {
    if (!info.connected) {
        return <EmptyState compact icon={<CreditCard size={20} />} title="No account connected" body="Until one is connected and verified, organizations see their plans but can't pay for them in the app." />;
    }
    const pill = statusPill(info);
    return (
        <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
            <Detail label="Key"><span className="font-mono text-[12px]">{info.keyIdHint}</span></Detail>
            <Detail label="Mode">{info.mode === 'live' ? 'Live' : 'Test (no real money)'}</Detail>
            <Detail label="Status"><StatusPill tone={pill.tone}>{pill.label}</StatusPill></Detail>
            <Detail label="Last verified">{info.lastVerifiedAt ? timeAgo(info.lastVerifiedAt) : 'Never'}</Detail>
            <div className="col-span-2">
                <Detail label="Webhook secret">{info.hasWebhookSecret ? 'Set' : <span className="text-[var(--ac-warn)]">Not set: payments are still confirmed from the app and by Recheck, but a payment whose window was closed early waits for a recheck</span>}</Detail>
            </div>
            {info.lastError && <p className="col-span-2 text-[13px] text-[var(--ac-bad)] break-words">{info.lastError}</p>}
        </dl>
    );
};

/** Key ID, key secret and webhook secret. The secrets go to the server once and are never shown again. */
const KeysForm: React.FC<{ hasWebhookSecret: boolean; reauth: Reauth; onSaved: (a: Account) => void; onCancel: () => void }> = ({ hasWebhookSecret, reauth, onSaved, onCancel }) => {
    const [keyId, setKeyId] = useState('');
    const [keySecret, setKeySecret] = useState('');
    const [webhookSecret, setWebhookSecret] = useState('');
    const [busy, setBusy] = useState(false);

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBusy(true);
        const next = await guarded(reauth, () => api<Account>(ACCOUNT_PATH, { method: 'PUT', ...json({ keyId, keySecret, webhookSecret }) }));
        setBusy(false);
        if (next) {
            onSaved(next);
            toast.success('Razorpay keys saved. Verify them next; organizations can pay once they are verified.');
        }
    };

    return (
        <form onSubmit={save} className="mt-4 grid gap-3 rounded-2xl neu-inset p-3.5">
            <Field label="Key ID" htmlFor="bill-id" hint="rzp_test_… for testing, rzp_live_… for real payments.">
                <Input id="bill-id" required value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Key secret" htmlFor="bill-secret">
                <Input id="bill-secret" type="password" required value={keySecret} onChange={e => setKeySecret(e.target.value)} autoComplete="off" />
            </Field>
            <Field label="Webhook secret" htmlFor="bill-wh" hint={hasWebhookSecret ? 'Leave blank to keep the current one.' : 'The secret you type when creating the webhook in Razorpay.'}>
                <Input id="bill-wh" type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save keys'}</Button>
                <Button type="button" onClick={onCancel}>Cancel</Button>
            </div>
        </form>
    );
};

const AccountCard: React.FC<{ info: Account; reauth: Reauth; onChange: (a: Account) => void; onReload: () => void }> = ({ info, reauth, onChange, onReload }) => {
    const dialogs = useDialogs();
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);

    const verify = async () => {
        setBusy(true);
        const r = await guarded(reauth, () => api<{ status: string; error: string | null }>(`${ACCOUNT_PATH}/verify`, { method: 'POST' }));
        setBusy(false);
        if (!r) return;
        if (r.status === 'verified') toast.success('Razorpay accepted the keys. Organizations can now pay for plans.');
        else toast.error(r.error ?? 'Verification failed');
        onReload();
    };

    const disconnect = async () => {
        if (!(await dialogs.confirm({
            title: 'Disconnect the plan payments account?',
            body: 'Organizations can no longer pay for plans in the app until an account is connected again. Payments already made stay in Razorpay; checking them needs these same keys back.',
            confirmLabel: 'Disconnect', danger: true,
        }))) return;
        const next = await guarded(reauth, () => api<Account>(ACCOUNT_PATH, { method: 'DELETE' }));
        if (next) { onChange(next); toast.success('Disconnected'); }
    };

    return (
        <Section title="Plan payments account"
            description="The platform's own Razorpay account: what organizations pay for their plans lands here. Separate from each organization's account for its customers. Secrets are stored encrypted and never shown again."
            actions={<CreditCard size={16} className="ac-faint" />}>
            {!info.secretsConfigured && (
                <p className="mb-4 text-[13px] text-[var(--ac-bad)]">Credential storage isn't configured on the server (PAYMENT_SECRETS_KEY), so keys can't be saved yet.</p>
            )}
            <AccountDetails info={info} />

            <details className="mt-4 group">
                <summary className="cursor-pointer text-[12px] ac-muted select-none list-none flex items-center gap-1">
                    <ChevronDown size={14} className="transition-transform group-open:rotate-180" /> Webhook set-up
                </summary>
                <div className="mt-2 text-[12px] space-y-1.5 ac-muted">
                    <p>Razorpay → Settings → Webhooks → Add new webhook, this address:</p>
                    <p className="font-mono break-all select-all rounded-lg neu-inset px-2.5 py-2 text-[var(--ac-text)]">{info.webhookUrl}</p>
                    <p>Events: order.paid, payment.captured, payment.failed. Use the same secret as the webhook secret here.</p>
                </div>
            </details>

            {editing ? (
                <KeysForm hasWebhookSecret={!!info.hasWebhookSecret} reauth={reauth}
                    onSaved={next => { onChange(next); setEditing(false); }} onCancel={() => setEditing(false)} />
            ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant={info.connected ? 'default' : 'primary'} onClick={() => setEditing(true)} disabled={!info.secretsConfigured}>
                        {info.connected ? 'Replace keys' : 'Connect Razorpay'}
                    </Button>
                    {info.connected && <Button onClick={verify} disabled={busy}>{busy ? 'Checking…' : 'Verify keys'}</Button>}
                    {info.connected && <Button variant="danger" onClick={disconnect}>Disconnect</Button>}
                </div>
            )}
        </Section>
    );
};
