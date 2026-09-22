// Create an account and apply for a workspace.
//
//   account → business details → plan → review & submit → status
//
// Everything is saved as it goes, so the applicant can leave and come back.
// The status page shows the provider's questions or decision and lets the
// applicant answer. Access to a workspace only appears once it is approved
// and set up — before that, a new account opens nothing.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { createAuthClient } from 'better-auth/react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock, LogOut, MessageSquare, XCircle } from 'lucide-react';
import { Button, Card, Field, Input, Select, Textarea } from '../components/ui';
import { PlanCard, SiteHeader, usePublicPlans, type PublicPlan } from './common';

const authClient = createAuthClient({ basePath: '/api/v2/auth' });

interface ApiError { status: number; code?: string; message: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api/v2${path}`, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw { status: res.status, code: body.code, message: body.error || 'Something went wrong' } as ApiError;
    return body as T;
}

interface Application {
    id: string; status: string; reviewStatus: string; businessName: string; businessType: string; ownerName: string;
    phone: string; addressLine: string; city: string; region: string; postalCode: string; country: string; timezone: string;
    website: string; taxId: string; expectedEmployees: number | null; expectedStores: number | null;
    requestedPlanKey: string; billingCycle: 'monthly' | 'annual'; applicantNote: string; providerMessage: string | null; orgId: string | null;
}
interface AppEvent { at: number; actor_kind: string; action: string; message: string | null }

type Step = 'loading' | 'account' | 'business' | 'plan' | 'review' | 'status';

const BUSINESS_TYPES: [string, string][] = [
    ['artist', 'Individual artist'], ['studio', 'Studio'], ['gallery', 'Gallery'],
    ['store', 'Single store'], ['multi_store', 'Several stores'], ['other', 'Something else'],
];
const COUNTRIES: [string, string][] = [
    ['IN', 'India'], ['AE', 'United Arab Emirates'], ['GB', 'United Kingdom'], ['US', 'United States'],
    ['SG', 'Singapore'], ['AU', 'Australia'], ['CA', 'Canada'], ['DE', 'Germany'], ['FR', 'France'],
];
const REQUIRED: (keyof Application)[] = ['businessName', 'businessType', 'ownerName', 'phone', 'addressLine', 'city', 'country', 'timezone'];

const blank = (tz: string): Partial<Application> => ({
    businessName: '', businessType: '', ownerName: '', phone: '', addressLine: '', city: '', region: '', postalCode: '',
    country: 'IN', timezone: tz, website: '', taxId: '', expectedEmployees: null, expectedStores: null,
    requestedPlanKey: '', billingCycle: 'monthly', applicantNote: '',
});

export const Signup: React.FC = () => {
    const params = useMemo(() => new URLSearchParams(location.search), []);
    const plans = usePublicPlans();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const [step, setStep] = useState<Step>('loading');
    const [email, setEmail] = useState<string | null>(null);
    const [app, setApp] = useState<Application | null>(null);
    const [events, setEvents] = useState<AppEvent[]>([]);
    const [draft, setDraft] = useState<Partial<Application>>(blank(tz));
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        const session = await authClient.getSession();
        if (!session.data) { setEmail(null); setStep('account'); return; }
        setEmail(session.data.user.email);
        const res = await api<{ application: Application | null; events?: AppEvent[] }>('/apply');
        setApp(res.application);
        setEvents(res.events ?? []);
        if (!res.application) {
            setDraft(d => ({
                ...d,
                ownerName: d.ownerName || session.data!.user.name,
                requestedPlanKey: params.get('plan') ?? d.requestedPlanKey,
                billingCycle: params.get('cycle') === 'annual' ? 'annual' : d.billingCycle,
            }));
            setStep('business');
            return;
        }
        setDraft(res.application);
        const s = res.application.status;
        if (s === 'draft') {
            const missing = REQUIRED.some(k => !String(res.application![k] ?? '').trim());
            setStep(missing ? 'business' : res.application.requestedPlanKey ? 'review' : 'plan');
        } else {
            setStep('status');
        }
    }, [params]);

    useEffect(() => { load().catch(e => { toast.error((e as ApiError).message); setStep('account'); }); }, [load]);

    const save = async (next: Step | null, extra: Partial<Application> = {}) => {
        setBusy(true);
        try {
            const body = { ...draft, ...extra };
            const res = await api<{ application: Application; events: AppEvent[] }>('/apply', { method: 'PUT', body: JSON.stringify(body) });
            setApp(res.application);
            setEvents(res.events);
            setDraft(res.application);
            if (next) setStep(next);
            else toast.success('Saved. You can come back and finish any time.');
        } catch (e) {
            toast.error((e as ApiError).message);
        } finally { setBusy(false); }
    };

    const submit = async () => {
        setBusy(true);
        try {
            const res = await api<{ application: Application; events: AppEvent[] }>('/apply/submit', { method: 'POST' });
            setApp(res.application);
            setEvents(res.events);
            setStep('status');
            window.scrollTo({ top: 0 });
        } catch (e) {
            toast.error((e as ApiError).message);
        } finally { setBusy(false); }
    };

    const signOut = async () => { await authClient.signOut(); location.href = '/welcome'; };

    const set = (k: keyof Application) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setDraft(d => ({ ...d, [k]: e.target.value }));

    const stepIndex = ['business', 'plan', 'review'].indexOf(step);

    return (
        <div className="min-h-dvh bg-[var(--neu-bg)]">
            <SiteHeader minimal />
            <main className="max-w-3xl mx-auto px-4 py-10 lg:py-14 space-y-6">
                {email && step !== 'account' && (
                    <div className="flex items-center justify-between text-[13px] text-gray-600 dark:text-gray-400">
                        <span>Signed in as <strong className="text-gray-900 dark:text-gray-100">{email}</strong></span>
                        <button type="button" onClick={signOut} className="flex items-center gap-1 hover:text-gold-700"><LogOut size={14} /> Sign out</button>
                    </div>
                )}

                {stepIndex >= 0 && (
                    <ol className="flex gap-2 text-[12px]">
                        {['Business details', 'Plan', 'Review'].map((label, i) => (
                            <li key={label} className={`flex-1 px-3 py-2 rounded-xl ${i === stepIndex ? 'neu-inset text-gold-700 dark:text-gold-300 font-medium' : 'text-gray-600 dark:text-gray-400'}`}>
                                {i + 1}. {label}
                            </li>
                        ))}
                    </ol>
                )}

                {step === 'loading' && <p className="text-sm text-gray-600">Loading…</p>}
                {step === 'account' && <AccountStep initialMode={params.get('mode') === 'signin' ? 'signin' : 'signup'} onDone={() => load()} />}

                {step === 'business' && (
                    <Card padding="lg">
                        <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">About your business</h1>
                        <p className="text-[13px] mt-1 mb-5 text-gray-600 dark:text-gray-400">Fields marked * are needed to apply. Everything saves, so you can finish later.</p>
                        <form className="grid gap-4 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); save('plan'); }}>
                            <Field label="Business name *" htmlFor="b-name"><Input id="b-name" required value={draft.businessName ?? ''} onChange={set('businessName')} /></Field>
                            <Field label="Type of business *" htmlFor="b-type">
                                <Select id="b-type" required value={draft.businessType ?? ''} onChange={set('businessType')}>
                                    <option value="">Choose…</option>
                                    {BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </Select>
                            </Field>
                            <Field label="Your name *" htmlFor="b-owner"><Input id="b-owner" required value={draft.ownerName ?? ''} onChange={set('ownerName')} /></Field>
                            <Field label="Phone *" htmlFor="b-phone"><Input id="b-phone" required type="tel" value={draft.phone ?? ''} onChange={set('phone')} placeholder="+91 …" /></Field>
                            <Field label="Address *" htmlFor="b-addr" className="sm:col-span-2"><Input id="b-addr" required value={draft.addressLine ?? ''} onChange={set('addressLine')} /></Field>
                            <Field label="City *" htmlFor="b-city"><Input id="b-city" required value={draft.city ?? ''} onChange={set('city')} /></Field>
                            <Field label="State / region" htmlFor="b-region"><Input id="b-region" value={draft.region ?? ''} onChange={set('region')} /></Field>
                            <Field label="Postal code" htmlFor="b-post"><Input id="b-post" value={draft.postalCode ?? ''} onChange={set('postalCode')} /></Field>
                            <Field label="Country *" htmlFor="b-country">
                                <Select id="b-country" required value={draft.country ?? 'IN'} onChange={set('country')}>
                                    {COUNTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </Select>
                            </Field>
                            <Field label="Time zone *" htmlFor="b-tz"><Input id="b-tz" required value={draft.timezone ?? tz} onChange={set('timezone')} /></Field>
                            <Field label="Website" htmlFor="b-web"><Input id="b-web" type="url" value={draft.website ?? ''} onChange={set('website')} placeholder="https://" /></Field>
                            <Field label="People who will use it" htmlFor="b-emp"><Input id="b-emp" inputMode="numeric" value={draft.expectedEmployees ?? ''} onChange={set('expectedEmployees')} /></Field>
                            <Field label="Number of stores / locations" htmlFor="b-stores"><Input id="b-stores" inputMode="numeric" value={draft.expectedStores ?? ''} onChange={set('expectedStores')} /></Field>
                            <Field label="Tax ID (optional)" htmlFor="b-tax" hint="GST or similar, if you have one."><Input id="b-tax" value={draft.taxId ?? ''} onChange={set('taxId')} /></Field>
                            <Field label="Anything we should know?" htmlFor="b-note" className="sm:col-span-2"><Textarea id="b-note" rows={3} value={draft.applicantNote ?? ''} onChange={set('applicantNote')} /></Field>
                            <div className="sm:col-span-2 flex flex-wrap gap-2 justify-between">
                                <Button type="button" onClick={() => save(null)} disabled={busy}>Save for later</Button>
                                <Button type="submit" variant="primary" disabled={busy}>Continue <ArrowRight size={16} /></Button>
                            </div>
                        </form>
                    </Card>
                )}

                {step === 'plan' && (
                    <PlanStep plans={plans} value={draft.requestedPlanKey ?? ''} cycle={(draft.billingCycle as 'monthly' | 'annual') ?? 'monthly'}
                        busy={busy} onBack={() => setStep('business')}
                        onChoose={(key, cycle) => save('review', { requestedPlanKey: key, billingCycle: cycle })} />
                )}

                {step === 'review' && app && (
                    <Card padding="lg">
                        <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">Review and send</h1>
                        <p className="text-[13px] mt-1 mb-5 text-gray-600 dark:text-gray-400">We review every application before setting up a workspace or charging anything.</p>
                        <dl className="grid gap-4 sm:grid-cols-2 text-sm">
                            {[
                                ['Business', `${app.businessName} (${BUSINESS_TYPES.find(t => t[0] === app.businessType)?.[1] ?? app.businessType})`],
                                ['Your name', app.ownerName], ['Phone', app.phone],
                                ['Address', [app.addressLine, app.city, app.region, app.postalCode, app.country].filter(Boolean).join(', ')],
                                ['Time zone', app.timezone], ['Website', app.website || '—'],
                                ['Team · stores', `${app.expectedEmployees ?? '—'} · ${app.expectedStores ?? '—'}`],
                                ['Plan', `${plans?.find(p => p.key === app.requestedPlanKey)?.name ?? app.requestedPlanKey} · billed ${app.billingCycle === 'annual' ? 'yearly' : 'monthly'}`],
                            ].map(([k, v]) => (
                                <div key={k}><dt className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400">{k}</dt><dd className="text-gray-900 dark:text-gray-100">{v}</dd></div>
                            ))}
                        </dl>
                        <div className="mt-6 flex flex-wrap gap-2 justify-between">
                            <div className="flex gap-2">
                                <Button onClick={() => setStep('business')}><ArrowLeft size={16} /> Edit details</Button>
                                <Button onClick={() => setStep('plan')}>Change plan</Button>
                            </div>
                            <Button variant="primary" disabled={busy} onClick={submit}>Send application</Button>
                        </div>
                    </Card>
                )}

                {step === 'status' && app && (
                    <StatusStep app={app} events={events} onEdit={() => setStep('business')} onResubmit={submit} busy={busy} />
                )}
            </main>
        </div>
    );
};

/* ------------------------------ Account ------------------------------- */

const AccountStep: React.FC<{ initialMode: 'signup' | 'signin'; onDone: () => void }> = ({ initialMode, onDone }) => {
    const [mode, setMode] = useState(initialMode);
    const [methods, setMethods] = useState<{ emailPassword: { signIn: boolean; signUp: boolean } } | null>(null);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [agree, setAgree] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => { api<typeof methods>('/public/login-methods').then(setMethods).catch(() => setMethods(null)); }, []);
    const signUpOpen = methods?.emailPassword.signUp !== false;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        const result = mode === 'signup'
            ? await authClient.signUp.email({ name, email, password })
            : await authClient.signIn.email({ email, password });
        setBusy(false);
        if (result.error) { toast.error(result.error.message || 'That did not work'); return; }
        onDone();
    };

    if (mode === 'signup' && methods && !signUpOpen) {
        return (
            <Card padding="lg">
                <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">Sign-up is by invitation for now</h1>
                <p className="mt-2 text-gray-700 dark:text-gray-300">We are onboarding businesses personally at the moment. Get in touch and we will set you up.</p>
                <div className="mt-5 flex gap-2">
                    <a href="/welcome#contact" className="neu-button neu-button-primary">Contact us</a>
                    <Button onClick={() => setMode('signin')}>I already have an account</Button>
                </div>
            </Card>
        );
    }

    return (
        <Card padding="lg">
            <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
            <p className="text-[13px] mt-1 mb-5 text-gray-600 dark:text-gray-400">
                {mode === 'signup' ? 'Then tell us about your business. It takes a few minutes, and you can save and return.' : 'Sign in to continue your application or check its status.'}
            </p>
            <form className="space-y-4" onSubmit={submit}>
                {mode === 'signup' && (
                    <Field label="Your name" htmlFor="a-name"><Input id="a-name" required autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></Field>
                )}
                <Field label="Email" htmlFor="a-email"><Input id="a-email" required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
                <Field label="Password" htmlFor="a-pass" hint={mode === 'signup' ? 'At least 10 characters.' : undefined}>
                    <Input id="a-pass" required type="password" minLength={mode === 'signup' ? 10 : undefined}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} />
                </Field>
                {mode === 'signup' && (
                    <label className="flex items-start gap-2 text-[13px] text-gray-700 dark:text-gray-300">
                        <input type="checkbox" className="mt-0.5" checked={agree} onChange={e => setAgree(e.target.checked)} required />
                        <span>I agree to the <a href="/legal#terms" className="underline">terms</a> and <a href="/legal#privacy" className="underline">privacy policy</a>.</span>
                    </label>
                )}
                <Button type="submit" variant="primary" block disabled={busy}>
                    {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
                </Button>
            </form>
            <p className="mt-5 text-[13px] text-center text-gray-600 dark:text-gray-400">
                {mode === 'signup'
                    ? <>Already have an account? <button type="button" className="underline" onClick={() => setMode('signin')}>Sign in</button></>
                    : <>New here? <button type="button" className="underline" onClick={() => setMode('signup')}>Create an account</button></>}
            </p>
        </Card>
    );
};

/* -------------------------------- Plan -------------------------------- */

const PlanStep: React.FC<{ plans: PublicPlan[] | null; value: string; cycle: 'monthly' | 'annual'; busy: boolean; onBack: () => void; onChoose: (key: string, cycle: 'monthly' | 'annual') => void }> = ({ plans, value, cycle: initialCycle, busy, onBack, onChoose }) => {
    const [selected, setSelected] = useState(value);
    const [cycle, setCycle] = useState(initialCycle);
    return (
        <Card padding="lg">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">Choose a plan</h1>
                    <p className="text-[13px] mt-1 text-gray-600 dark:text-gray-400">You can change this later. Nothing is charged until we have reviewed your application.</p>
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setCycle('monthly')} className={`neu-pill ${cycle === 'monthly' ? 'neu-pill-active' : ''}`}>Monthly</button>
                    <button type="button" onClick={() => setCycle('annual')} className={`neu-pill ${cycle === 'annual' ? 'neu-pill-active' : ''}`}>Yearly</button>
                </div>
            </div>
            {plans === null ? <p className="mt-6 text-sm">Loading plans…</p> : plans.length === 0 ? (
                <p className="mt-6 text-sm text-gray-700 dark:text-gray-300">No plans are open yet. Save your details and we will be in touch.</p>
            ) : (
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    {plans.map(p => <PlanCard key={p.key} plan={p} cycle={cycle} selected={selected === p.key} onChoose={() => setSelected(p.key)} />)}
                </div>
            )}
            <div className="mt-6 flex justify-between">
                <Button onClick={onBack}><ArrowLeft size={16} /> Back</Button>
                <Button variant="primary" disabled={!selected || busy} onClick={() => onChoose(selected, cycle)}>Continue <ArrowRight size={16} /></Button>
            </div>
        </Card>
    );
};

/* ------------------------------- Status ------------------------------- */

const STATUS: Record<string, { title: string; body: string; icon: React.ReactNode }> = {
    pending_review: { title: 'Application received', body: 'We are reviewing it and will be in touch. You can still correct your details below.', icon: <Clock size={22} /> },
    needs_information: { title: 'We need a little more information', body: 'Please update your details and send the application again.', icon: <MessageSquare size={22} /> },
    rejected: { title: 'We could not approve this application', body: 'The reason is below. If something has changed, contact us.', icon: <XCircle size={22} /> },
    withdrawn: { title: 'Application withdrawn', body: 'You can start a new one at any time.', icon: <XCircle size={22} /> },
    provisioning: { title: 'Approved — setting up your workspace', body: 'This usually takes a moment.', icon: <Clock size={22} /> },
    provisioning_failed: { title: 'Approved — finishing your set-up', body: 'We hit a snag creating your workspace and are fixing it. There is nothing you need to do.', icon: <Clock size={22} /> },
    payment_required: { title: 'Approved — payment next', body: 'Your workspace is ready. We will contact you to set up payment before it opens.', icon: <CheckCircle2 size={22} /> },
    active: { title: 'Your workspace is set up', body: 'We will send you the link to start using it with this account.', icon: <CheckCircle2 size={22} /> },
    trial_expired: { title: 'Your trial has ended', body: 'Contact us to choose a plan and keep going. Nothing has been deleted.', icon: <Clock size={22} /> },
    suspended: { title: 'Your workspace is paused', body: 'Contact us to restore access. Your data is kept.', icon: <XCircle size={22} /> },
    closed: { title: 'This workspace is closed', body: 'Contact us if this is unexpected.', icon: <XCircle size={22} /> },
};

const StatusStep: React.FC<{ app: Application; events: AppEvent[]; onEdit: () => void; onResubmit: () => void; busy: boolean }> = ({ app, events, onEdit, onResubmit, busy }) => {
    const s = STATUS[app.status] ?? { title: app.status, body: '', icon: <Clock size={22} /> };
    const good = ['payment_required', 'active'].includes(app.status);
    return (
        <div className="space-y-6">
            <Card padding="lg">
                <div className={`flex items-start gap-3 ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-gold-700 dark:text-gold-300'}`}>
                    {s.icon}
                    <div>
                        <h1 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{s.title}</h1>
                        <p className="mt-1 text-gray-700 dark:text-gray-300">{s.body}</p>
                    </div>
                </div>
                {app.providerMessage && ['needs_information', 'rejected'].includes(app.status) && (
                    <blockquote className="mt-5 neu-inset rounded-xl p-4 text-gray-800 dark:text-gray-200">
                        <p className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400 mb-1">Message from us</p>
                        {app.providerMessage}
                    </blockquote>
                )}
                <div className="mt-5 flex flex-wrap gap-2">
                    {['pending_review', 'needs_information'].includes(app.status) && <Button onClick={onEdit}>Update details</Button>}
                    {app.status === 'needs_information' && <Button variant="primary" disabled={busy} onClick={onResubmit}>Send again</Button>}
                </div>
            </Card>
            <Card padding="lg">
                <p className="font-medium text-gray-900 dark:text-gray-100">{app.businessName}</p>
                <ol className="mt-3 space-y-2">
                    {events.map((e, i) => (
                        <li key={i} className="text-[13px] flex gap-3">
                            <span className="text-gray-600 dark:text-gray-400 w-44 shrink-0 whitespace-nowrap">{new Date(e.at).toLocaleString()}</span>
                            <span className="text-gray-800 dark:text-gray-200">{e.action.replace(/[._]/g, ' ')}{e.message ? ` — ${e.message}` : ''}</span>
                        </li>
                    ))}
                </ol>
            </Card>
        </div>
    );
};
