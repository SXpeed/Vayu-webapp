// Tools on a plan's page in the control centre:
//   - a new price for new customers (organizations already on it keep theirs);
//   - moving everyone on a version to another plan or version, keeping their
//     status and the date they have paid up to;
//   - a limited-time offer;
//   - deleting a plan nobody uses.
// Convenience only: the server checks and refuses anything unsafe.

import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowRightLeft, BadgePercent, IndianRupee, Trash2 } from 'lucide-react';
import { Field, Input, Select, ToggleRow } from '../components/ui';
import { api, guarded as sharedGuarded, type ApiError, type Reauth } from './api';
import { Section, StatusPill, useDialogs } from './kit';
import type { PlanDetail, PlanVersion } from './PlansPanel';

export interface Offer { percentOff: number; label: string; startsAt: number; endsAt: number; includeRenewals: boolean }

const guarded = <T,>(reauth: Reauth, fn: () => Promise<T>) => sharedGuarded(reauth, fn, (m) => toast.error(m, { duration: 8000 }));
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const money = (minor: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(minor / 100);
const day = (ts: number) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
/** yyyy-mm-dd for a date input, in local time. */
const dateInput = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const rupees = (text: string) => Math.round(Number(text || '0') * 100);

/* ───────────────────────── New price ───────────────────────── */

export const RepriceForm: React.FC<{ planId: string; version: PlanVersion; reauth: Reauth; onDone: (p: PlanDetail) => void; onCancel: () => void }> = ({ planId, version, reauth, onDone, onCancel }) => {
    const [monthly, setMonthly] = useState(String(version.price_monthly / 100));
    const [annual, setAnnual] = useState(String(version.price_annual / 100));
    const [busy, setBusy] = useState(false);

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBusy(true);
        const next = await guarded(reauth, () => api<PlanDetail>(`/admin/plans/${planId}/versions/${version.id}/reprice`, post({ priceMonthly: rupees(monthly), priceAnnual: rupees(annual) })));
        setBusy(false);
        if (next) { toast.success('New price is live for new customers'); onDone(next); }
    };

    return (
        <form onSubmit={save} className="mt-5 grid gap-3 rounded-2xl neu-inset p-3.5">
            <p className="text-[13px] font-semibold flex items-center gap-1.5"><IndianRupee size={14} /> New price</p>
            <div className="grid grid-cols-2 gap-3">
                <Field label="Per month (₹)" htmlFor={`rp-m-${version.id}`}>
                    <Input id={`rp-m-${version.id}`} inputMode="decimal" value={monthly} onChange={e => setMonthly(e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
                <Field label="Per year (₹)" htmlFor={`rp-y-${version.id}`}>
                    <Input id={`rp-y-${version.id}`} inputMode="decimal" value={annual} onChange={e => setAnnual(e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
            </div>
            <p className="text-[12px] ac-muted">
                The {version.organizations} organization{version.organizations === 1 ? '' : 's'} on version {version.version} keep{version.organizations === 1 ? 's' : ''} {money(version.price_monthly)} / month, including when renewing.
                New customers, and anyone moving to this plan from another, pay the new price. Limits and features stay the same.
            </p>
            <div className="flex flex-wrap gap-2">
                <button type="submit" className="neu-button neu-button-primary" disabled={busy}>{busy ? 'Saving…' : 'Use the new price'}</button>
                <button type="button" className="neu-button" onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
};

/* ─────────────────────── Move organizations ────────────────────── */

interface Target { id: string; label: string }

export const MoveOrgsForm: React.FC<{ planId: string; version: PlanVersion; reauth: Reauth; onDone: (p: PlanDetail) => void; onCancel: () => void }> = ({ planId, version, reauth, onDone, onCancel }) => {
    const [targets, setTargets] = useState<Target[] | null>(null);
    const [to, setTo] = useState('');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api<{ plans: { name: string; published_version_id: string | null; published_version: number | null; billing_type: string | null; price_monthly: number | null }[] }>('/admin/plans')
            .then(({ plans }) => setTargets(plans
                .filter(p => p.published_version_id && p.published_version_id !== version.id)
                .map(p => {
                    const price = p.billing_type === 'paid' ? ` · ${money(p.price_monthly ?? 0)}/month` : ` · ${p.billing_type}`;
                    return { id: p.published_version_id as string, label: `${p.name} v${p.published_version}${price}` };
                })))
            .catch(e => { setTargets([]); toast.error((e as ApiError).message); });
    }, [version.id]);

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBusy(true);
        const res = await guarded(reauth, () => api<{ moved: number; plan: PlanDetail }>(`/admin/plans/${planId}/versions/${version.id}/move`, post({ toVersionId: to, reason })));
        setBusy(false);
        if (res) { toast.success(`Moved ${res.moved} organization${res.moved === 1 ? '' : 's'}`); onDone(res.plan); }
    };

    return (
        <form onSubmit={save} className="mt-5 grid gap-3 rounded-2xl neu-inset p-3.5">
            <p className="text-[13px] font-semibold flex items-center gap-1.5"><ArrowRightLeft size={14} /> Move the {version.organizations} organization{version.organizations === 1 ? '' : 's'} on version {version.version}</p>
            <Field label="Move them to" htmlFor={`mv-${version.id}`}>
                <Select id={`mv-${version.id}`} required value={to} onChange={e => setTo(e.target.value)} disabled={!targets}>
                    <option value="">{targets ? 'Choose a live plan version…' : 'Loading…'}</option>
                    {(targets ?? []).map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </Select>
            </Field>
            <Field label="Reason" htmlFor={`mv-r-${version.id}`} hint="Kept in the audit log.">
                <Input id={`mv-r-${version.id}`} required minLength={3} value={reason} onChange={e => setReason(e.target.value)} />
            </Field>
            <p className="text-[12px] ac-muted">
                Each keeps its status and the date it has paid up to; nothing is charged now. The new plan's limits apply straight away, and renewals are at the new plan's price.
                Moving to a free plan removes the paid-up-to date, as free never runs out.
            </p>
            <div className="flex flex-wrap gap-2">
                <button type="submit" className="neu-button neu-button-primary" disabled={busy || !to}>{busy ? 'Moving…' : 'Move them'}</button>
                <button type="button" className="neu-button" onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
};

/* ───────────────────────── Limited-time offer ──────────────────────── */

function offerState(offer: Offer): { tone: 'ok' | 'warn' | 'neutral'; text: string } {
    const now = Date.now();
    if (offer.endsAt <= now) return { tone: 'neutral', text: `Ended ${day(offer.endsAt)}` };
    if (offer.startsAt > now) return { tone: 'warn', text: `Starts ${day(offer.startsAt)}` };
    return { tone: 'ok', text: `Running until ${day(offer.endsAt)}` };
}

export const OfferSection: React.FC<{ plan: PlanDetail & { offer?: Offer | null }; onChange: (p: PlanDetail) => void }> = ({ plan, onChange }) => {
    const offer = plan.offer ?? null;
    const [percent, setPercent] = useState(String(offer?.percentOff ?? 20));
    const [label, setLabel] = useState(offer?.label ?? '');
    const [starts, setStarts] = useState(dateInput(offer?.startsAt ?? Date.now()));
    const [ends, setEnds] = useState(dateInput(offer?.endsAt ?? Date.now() + 14 * 86_400_000));
    const [renewals, setRenewals] = useState(offer?.includeRenewals ?? false);
    const [busy, setBusy] = useState(false);

    const save = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        const startsAt = new Date(`${starts}T00:00:00`).getTime();
        const body = {
            percentOff: Number(percent), label: label.trim(), includeRenewals: renewals,
            // Starting today means now; otherwise at the start of that day. It ends at the end of its last day.
            startsAt: starts === dateInput(Date.now()) ? Date.now() : startsAt,
            endsAt: new Date(`${ends}T23:59:59`).getTime(),
        };
        setBusy(true);
        try {
            onChange(await api<PlanDetail>(`/admin/plans/${plan.id}/offer`, { method: 'PUT', body: JSON.stringify(body) }));
            toast.success('Offer saved');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const end = async () => {
        setBusy(true);
        try {
            onChange(await api<PlanDetail>(`/admin/plans/${plan.id}/offer`, { method: 'DELETE' }));
            toast.success('Offer ended');
        } catch (err) { toast.error((err as ApiError).message); } finally { setBusy(false); }
    };

    const state = offer ? offerState(offer) : null;
    return (
        <Section title="Limited-time offer" description="A discount on this plan for a while. Shown on the pricing page and in the app; plan versions don't change."
            actions={<BadgePercent size={16} className="ac-faint" />}>
            {offer && state && (
                <p className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
                    <StatusPill tone={state.tone}>{state.text}</StatusPill>
                    <span>{offer.percentOff}% off{offer.label ? ` · ${offer.label}` : ''}</span>
                </p>
            )}
            <form onSubmit={save} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Discount (%)" htmlFor="of-pct">
                        <Input id="of-pct" inputMode="numeric" required value={percent} onChange={e => setPercent(e.target.value.replace(/\D/g, '').slice(0, 2))} />
                    </Field>
                    <Field label="Name (optional)" htmlFor="of-label">
                        <Input id="of-label" placeholder="e.g. Diwali offer" maxLength={60} value={label} onChange={e => setLabel(e.target.value)} />
                    </Field>
                    <Field label="Starts" htmlFor="of-start">
                        <Input id="of-start" type="date" required value={starts} onChange={e => setStarts(e.target.value)} />
                    </Field>
                    <Field label="Ends (end of day)" htmlFor="of-end">
                        <Input id="of-end" type="date" required value={ends} onChange={e => setEnds(e.target.value)} />
                    </Field>
                </div>
                <ToggleRow title="Also for renewals" description="Off: only organizations choosing this plan get it, not those renewing it."
                    checked={renewals} onChange={() => setRenewals(r => !r)} />
                <div className="flex flex-wrap gap-2">
                    <button type="submit" className="neu-button neu-button-primary" disabled={busy}>{offer ? 'Update offer' : 'Start offer'}</button>
                    {offer && <button type="button" className="neu-button" onClick={() => void end()} disabled={busy}>End offer now</button>}
                </div>
            </form>
        </Section>
    );
};

/* ───────────────────────────── Delete ─────────────────────────────── */

export const DeletePlanButton: React.FC<{ plan: PlanDetail; reauth: Reauth; onDeleted: () => void }> = ({ plan, reauth, onDeleted }) => {
    const dialogs = useDialogs();
    const del = async () => {
        const ok = await dialogs.confirm({
            title: `Delete ${plan.name}?`,
            body: 'Only a plan no organization has ever been on, paid for or applied for can be deleted. It and all its versions are removed for good.',
            confirmLabel: 'Delete plan', danger: true,
        });
        if (!ok) return;
        const res = await guarded(reauth, () => api<{ deleted: boolean }>(`/admin/plans/${plan.id}`, { method: 'DELETE' }));
        if (res) { toast.success(`${plan.name} deleted`); onDeleted(); }
    };
    return (
        <button type="button" className="neu-button neu-button-danger" onClick={() => void del()}>
            <Trash2 size={15} /> Delete plan
        </button>
    );
};
