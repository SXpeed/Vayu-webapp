// Create an account and apply for a workspace.
//
//   account → business details → plan → review & submit → status
//
// Everything is saved as it goes, so the applicant can leave and come back.
// The status page shows the provider's questions or decision and lets the
// applicant answer. Access to a workspace only appears once it is approved
// and set up — before that, a new account opens nothing.
//
// The account step offers Google (when switched on in the control centre)
// and email. Google returns here; the page picks the session up and carries
// on with the application.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { createAuthClient } from 'better-auth/react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock, Eye, EyeOff, LogOut, MessageSquare, XCircle } from 'lucide-react';
import { Button, Card, Field, Input, Select, Textarea } from '../components/ui';
import { useBranding } from '../useBranding';
import { HOME_URL, PlanCard, SiteHeader, usePublicPlans, type PublicPlan } from './common';
import './site.css';

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
interface LoginMethods { emailPassword: { signIn: boolean; signUp: boolean }; google: { signIn: boolean; signUp: boolean } }

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

/** A rise-in delay for the page's entrance (site.css). */
const rise = (ms: number) => ({ ['--d' as string]: `${ms}ms` }) as React.CSSProperties;

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
    // Sending an application needs a confirmed email once email is set up.
    const [emailCheck, setEmailCheck] = useState({ verified: true, required: false });
    const noteEmail = (res: { emailVerified?: boolean; emailRequired?: boolean }) =>
        setEmailCheck({ verified: res.emailVerified !== false, required: !!res.emailRequired });

    const load = useCallback(async () => {
        const session = await authClient.getSession();
        if (!session.data) { setEmail(null); setStep('account'); return; }
        setEmail(session.data.user.email);
        const res = await api<{ application: Application | null; events?: AppEvent[]; emailVerified?: boolean; emailRequired?: boolean }>('/apply');
        noteEmail(res);
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
            if (missing) setStep('business');
            else setStep(res.application.requestedPlanKey ? 'review' : 'plan');
        } else {
            setStep('status');
        }
    }, [params]);

    useEffect(() => { load().catch(e => { toast.error((e as ApiError).message); setStep('account'); }); }, [load]);

    const save = async (next: Step | null, extra: Partial<Application> = {}) => {
        setBusy(true);
        try {
            const body = { ...draft, ...extra };
            const res = await api<{ application: Application; events: AppEvent[]; emailVerified?: boolean; emailRequired?: boolean }>('/apply', { method: 'PUT', body: JSON.stringify(body) });
            noteEmail(res);
            setApp(res.application);
            setEvents(res.events);
            setDraft(res.application);
            if (next) { setStep(next); window.scrollTo({ top: 0 }); }
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

    const signOut = async () => { await authClient.signOut(); location.href = HOME_URL; };

    const set = (k: keyof Application) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
        setDraft(d => ({ ...d, [k]: e.target.value }));

    const stepIndex = ['business', 'plan', 'review'].indexOf(step);

    return (
        <div className="mk min-h-dvh bg-[var(--neu-bg)]">
            <SiteHeader minimal />

            {step === 'loading' && <p className="max-w-3xl mx-auto px-5 py-16 text-sm text-gray-600 dark:text-gray-400">Loading…</p>}

            {step === 'account' && params.get('mode') === 'reset' && (
                <ResetPassword token={params.get('token')} failed={params.get('error') === 'INVALID_TOKEN'} />
            )}
            {step === 'account' && params.get('mode') !== 'reset' && (
                <AccountStep initialMode={params.get('mode') === 'signin' ? 'signin' : 'signup'} returnError={params.get('error')} onDone={() => load()} />
            )}

            {step !== 'account' && step !== 'loading' && (
                <main className="max-w-3xl mx-auto px-5 pt-8 pb-16 lg:pt-12 space-y-6">
                    {email && (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-gray-600 dark:text-gray-400">
                            <span className="min-w-0 break-all">Signed in as <strong className="font-medium text-gray-900 dark:text-gray-100">{email}</strong></span>
                            <button type="button" onClick={signOut} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 hover:text-gold-700 dark:hover:text-gold-300">
                                <LogOut size={14} /> Sign out
                            </button>
                        </div>
                    )}

                    {stepIndex >= 0 && <Progress current={stepIndex} />}

                    {email && emailCheck.required && !emailCheck.verified && step !== 'status' && <ConfirmEmailNotice email={email} />}

                    {step === 'business' && (
                        <Card padding="lg">
                            <h1 className="font-serif text-[1.75rem] leading-tight text-gray-900 dark:text-gray-100">About your business</h1>
                            <p className="text-[13px] mt-1.5 text-gray-600 dark:text-gray-400">Fields marked * are needed to apply. Everything saves, so you can finish later.</p>
                            <form className="mt-6 space-y-7" onSubmit={e => { e.preventDefault(); save('plan'); }}>
                                <FormSection title="The business">
                                    <Field label="Business name *" htmlFor="b-name"><Input id="b-name" required value={draft.businessName ?? ''} onChange={set('businessName')} /></Field>
                                    <Field label="Type of business *" htmlFor="b-type">
                                        <Select id="b-type" required value={draft.businessType ?? ''} onChange={set('businessType')}>
                                            <option value="">Choose…</option>
                                            {BUSINESS_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                        </Select>
                                    </Field>
                                    <Field label="Your name *" htmlFor="b-owner"><Input id="b-owner" required autoComplete="name" value={draft.ownerName ?? ''} onChange={set('ownerName')} /></Field>
                                    <Field label="Phone *" htmlFor="b-phone"><Input id="b-phone" required type="tel" autoComplete="tel" value={draft.phone ?? ''} onChange={set('phone')} placeholder="+91 …" /></Field>
                                    <Field label="Website" htmlFor="b-web"><Input id="b-web" type="url" value={draft.website ?? ''} onChange={set('website')} placeholder="https://" /></Field>
                                    <Field label="Tax ID (optional)" htmlFor="b-tax" hint="GST or similar, if you have one."><Input id="b-tax" value={draft.taxId ?? ''} onChange={set('taxId')} /></Field>
                                </FormSection>
                                <FormSection title="Where you are">
                                    <Field label="Address *" htmlFor="b-addr" className="sm:col-span-2"><Input id="b-addr" required autoComplete="street-address" value={draft.addressLine ?? ''} onChange={set('addressLine')} /></Field>
                                    <Field label="City *" htmlFor="b-city"><Input id="b-city" required autoComplete="address-level2" value={draft.city ?? ''} onChange={set('city')} /></Field>
                                    <Field label="State / region" htmlFor="b-region"><Input id="b-region" autoComplete="address-level1" value={draft.region ?? ''} onChange={set('region')} /></Field>
                                    <Field label="Postal code" htmlFor="b-post"><Input id="b-post" autoComplete="postal-code" value={draft.postalCode ?? ''} onChange={set('postalCode')} /></Field>
                                    <Field label="Country *" htmlFor="b-country">
                                        <Select id="b-country" required value={draft.country ?? 'IN'} onChange={set('country')}>
                                            {COUNTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                        </Select>
                                    </Field>
                                    <Field label="Time zone *" htmlFor="b-tz"><Input id="b-tz" required value={draft.timezone ?? tz} onChange={set('timezone')} /></Field>
                                </FormSection>
                                <FormSection title="Size (optional)">
                                    <Field label="People who will use it" htmlFor="b-emp"><Input id="b-emp" inputMode="numeric" value={draft.expectedEmployees ?? ''} onChange={set('expectedEmployees')} /></Field>
                                    <Field label="Stores or locations" htmlFor="b-stores"><Input id="b-stores" inputMode="numeric" value={draft.expectedStores ?? ''} onChange={set('expectedStores')} /></Field>
                                    <Field label="Anything we should know?" htmlFor="b-note" className="sm:col-span-2"><Textarea id="b-note" rows={3} value={draft.applicantNote ?? ''} onChange={set('applicantNote')} /></Field>
                                </FormSection>
                                <div className="flex flex-wrap gap-2 justify-between pt-1">
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
                            <h1 className="font-serif text-[1.75rem] leading-tight text-gray-900 dark:text-gray-100">Review and send</h1>
                            <p className="text-[13px] mt-1.5 mb-6 text-gray-600 dark:text-gray-400">We review every application before setting up a workspace or charging anything.</p>
                            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 text-sm">
                                {[
                                    ['Business', `${app.businessName} (${BUSINESS_TYPES.find(t => t[0] === app.businessType)?.[1] ?? app.businessType})`],
                                    ['Your name', app.ownerName], ['Phone', app.phone],
                                    ['Address', [app.addressLine, app.city, app.region, app.postalCode, app.country].filter(Boolean).join(', ')],
                                    ['Time zone', app.timezone], ['Website', app.website || '—'],
                                    ['Team · stores', `${app.expectedEmployees ?? '—'} · ${app.expectedStores ?? '—'}`],
                                    ['Plan', `${plans?.find(p => p.key === app.requestedPlanKey)?.name ?? app.requestedPlanKey} · billed ${app.billingCycle === 'annual' ? 'yearly' : 'monthly'}`],
                                ].map(([k, v]) => (
                                    <div key={k} className="min-w-0">
                                        <dt className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400">{k}</dt>
                                        <dd className="mt-0.5 text-gray-900 dark:text-gray-100 break-words">{v}</dd>
                                    </div>
                                ))}
                            </dl>
                            <div className="mt-7 flex flex-wrap gap-2 justify-between">
                                <div className="flex flex-wrap gap-2">
                                    <Button onClick={() => setStep('business')}><ArrowLeft size={16} /> Edit details</Button>
                                    <Button onClick={() => setStep('plan')}>Change plan</Button>
                                </div>
                                <Button variant="primary" disabled={busy || (emailCheck.required && !emailCheck.verified)} onClick={submit}
                                    title={emailCheck.required && !emailCheck.verified ? 'Confirm your email address first' : undefined}>Send application</Button>
                            </div>
                        </Card>
                    )}

                    {step === 'status' && app && (
                        <StatusStep app={app} events={events} onEdit={() => setStep('business')} onResubmit={submit} busy={busy} />
                    )}
                </main>
            )}
        </div>
    );
};

/** The three application steps, with the ones already done ticked. */
const Progress: React.FC<{ current: number }> = ({ current }) => (
    <ol className="grid grid-cols-3 gap-2" aria-label="Application steps">
        {['Business details', 'Plan', 'Review'].map((label, i) => {
            const done = i < current;
            const here = i === current;
            let badge = 'neu-inset text-gray-600 dark:text-gray-400';
            if (here) badge = 'neu-accent text-[#241c04]';
            else if (done) badge = 'bg-gold-500/15 text-gold-700 dark:text-gold-300';
            return (
                <li key={label} aria-current={here ? 'step' : undefined} className="flex flex-col gap-2">
                    <span className={`h-1 rounded-full ${i <= current ? 'bg-gold-500/70' : 'bg-gray-300/70 dark:bg-white/10'}`} />
                    <span className="flex items-center gap-2 min-w-0">
                        <span className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold ${badge}`}>
                            {done ? <Check size={13} strokeWidth={3} /> : i + 1}
                        </span>
                        <span className={`text-[12px] sm:text-[13px] leading-[1.35] ${here ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}`}>{label}</span>
                    </span>
                </li>
            );
        })}
    </ol>
);

const FormSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-gold-700 dark:text-gold-300">{title}</legend>
        {children}
    </fieldset>
);

/* ------------------------------ Account ------------------------------- */

/** Google's standard multicolour "G", as its sign-in guidelines ask. */
const GoogleMark: React.FC = () => (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
);

/** Why a Google sign-in came back without a session, in plain words. */
function googleErrorText(code: string): string {
    if (/signup_disabled|sign_up_disabled/i.test(code)) return 'New accounts with Google are not open right now. If you already have an account, sign in.';
    if (/not_linked|link/i.test(code)) return 'This email already has an account with a password. Sign in with your email and password instead.';
    if (/access_denied|cancel/i.test(code)) return 'Google sign-in was cancelled.';
    return "Google sign-in didn't finish. Please try again, or use your email.";
}

type Mode = 'signup' | 'signin';
type Busy = 'email' | 'google' | null;

const AccountStep: React.FC<{ initialMode: Mode; returnError: string | null; onDone: () => void }> = ({ initialMode, returnError, onDone }) => {
    const [mode, setMode] = useState<Mode>(initialMode);
    const [methods, setMethods] = useState<LoginMethods | null>(null);
    const [busy, setBusy] = useState<Busy>(null);
    const [problem, setProblem] = useState<string | null>(returnError ? googleErrorText(returnError) : null);
    const [forgot, setForgot] = useState(false);

    useEffect(() => { api<LoginMethods>('/public/login-methods').then(setMethods).catch(() => setMethods(null)); }, []);

    const { googleHere, emailHere, signUpOpen } = availableMethods(methods, mode);
    const switchMode = (next: Mode) => { setMode(next); setProblem(null); };

    const withGoogle = async () => {
        setBusy('google');
        setProblem(null);
        // Google brings the browser back here; the page then finds the session.
        const here = `${location.pathname}${mode === 'signin' ? '?mode=signin' : ''}`;
        const { error } = await authClient.signIn.social({ provider: 'google', callbackURL: here, errorCallbackURL: `${location.pathname}?mode=${mode}` });
        if (error) { setBusy(null); setProblem(error.message || googleErrorText('')); }
    };

    const withEmail = async (details: { name: string; email: string; password: string }) => {
        setBusy('email');
        setProblem(null);
        const result = mode === 'signup'
            // The confirmation link brings them back here, signed in.
            ? await authClient.signUp.email({ ...details, callbackURL: location.pathname })
            : await authClient.signIn.email({ email: details.email, password: details.password });
        setBusy(null);
        if (result.error) { setProblem(result.error.message || 'That did not work. Check the details and try again.'); return; }
        onDone();
    };

    const invitationOnly = !signUpOpen && mode === 'signup';
    if (forgot) {
        return (
            <main className="max-w-md mx-auto px-5 pt-10 pb-16 mk-settle">
                <ForgotPassword onBack={() => { setForgot(false); switchMode('signin'); }} />
            </main>
        );
    }
    return (
        <main className="max-w-6xl mx-auto px-5 pt-6 pb-16 lg:pt-14 grid gap-10 lg:grid-cols-[1fr_minmax(0,27rem)] lg:gap-16 items-start">
            <JoinStory />
            <div className="order-1 lg:order-2 mk-settle" style={rise(120)}>
                {invitationOnly ? (
                    <InvitationOnly onSignIn={() => switchMode('signin')} />
                ) : (
                    <Card padding="lg" className="!p-6 sm:!p-8">
                        <ModeTabs mode={mode} onChange={switchMode} />
                        <h1 className="mt-7 font-serif text-[1.7rem] leading-tight text-gray-900 dark:text-gray-100">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
                        <p className="mt-1.5 text-[13px] text-gray-600 dark:text-gray-400">
                            {mode === 'signup'
                                ? 'Then tell us about your business. It takes a few minutes, and you can save and come back.'
                                : 'Sign in to continue your application or see where it stands.'}
                        </p>
                        {problem && (
                            <p role="alert" className="mt-5 rounded-xl px-3.5 py-2.5 text-[13px] leading-snug bg-red-500/10 text-red-700 dark:text-red-300">{problem}</p>
                        )}
                        {googleHere && <GoogleButton mode={mode} busy={busy} onClick={withGoogle} />}
                        {googleHere && emailHere && (
                            <div className="my-6 flex items-center gap-3 text-[12px] text-gray-500 dark:text-gray-400" aria-hidden="true">
                                <span className="h-px flex-1 bg-gray-300/80 dark:bg-white/10" /> or use your email <span className="h-px flex-1 bg-gray-300/80 dark:bg-white/10" />
                            </div>
                        )}
                        {emailHere && <EmailForm key={mode} mode={mode} busy={busy} spaced={!googleHere} onSubmit={withEmail} onForgot={() => setForgot(true)} />}
                        {!googleHere && !emailHere && methods && (
                            <p className="mt-6 text-sm text-gray-700 dark:text-gray-300">Signing in is switched off at the moment. Please contact us.</p>
                        )}
                        <SwitchModeLine mode={mode} onChange={switchMode} />
                    </Card>
                )}
            </div>
        </main>
    );
};

/** Which ways in to show for this mode, from the control centre's login settings. */
function availableMethods(methods: LoginMethods | null, mode: Mode) {
    const google = methods?.google;
    const email = methods?.emailPassword;
    const googleUp = !!(google?.signIn && google.signUp);
    return {
        googleHere: mode === 'signin' ? !!google?.signIn : googleUp,
        emailHere: mode === 'signin' ? email?.signIn !== false : email?.signUp !== false,
        // Unknown settings (still loading): assume open rather than flash "invitation only".
        signUpOpen: methods === null || !!email?.signUp || googleUp,
    };
}

/** The three steps of joining. On phones it follows the form, so signing in comes first. */
const JoinStory: React.FC = () => {
    const brand = useBranding();
    return (
        <section aria-labelledby="signup-story" className="order-2 lg:order-1 lg:pt-6">
            <p className="mk-rise text-[11px] uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300" style={rise(40)}>Open your workspace</p>
            <h2 id="signup-story" className="mk-rise mt-3 font-serif text-[2rem] sm:text-[2.6rem] leading-[1.08] tracking-[-0.01em] text-gray-900 dark:text-gray-100 text-balance" style={rise(110)}>
                Your inventory, catalogs and clients, in one calm place.
            </h2>
            <p className="mk-rise mt-4 max-w-lg font-light leading-relaxed text-gray-700 dark:text-gray-300" style={rise(180)}>
                Joining {brand.appName} takes three steps. You can stop at any point and pick up where you left off.
            </p>
            <ol className="mt-8 space-y-5 max-w-lg">
                {[
                    ['Create your account', 'With Google or your email. About a minute.'],
                    ['Tell us about your business', 'What you do, where you are, and a plan that fits. Saved as you go.'],
                    ['We review and set you up', 'Every application is reviewed before anything is charged.'],
                ].map(([title, text], i) => (
                    <li key={title} className="mk-rise flex gap-4" style={rise(260 + i * 60)}>
                        <span className="w-8 h-8 shrink-0 rounded-full neu-raised-sm flex items-center justify-center font-serif text-gold-700 dark:text-gold-300">{i + 1}</span>
                        <span className="pt-1">
                            <span className="block font-medium text-gray-900 dark:text-gray-100">{title}</span>
                            <span className="block text-[14px] font-light text-gray-600 dark:text-gray-400">{text}</span>
                        </span>
                    </li>
                ))}
            </ol>
        </section>
    );
};

const ModeTabs: React.FC<{ mode: Mode; onChange: (m: Mode) => void }> = ({ mode, onChange }) => (
    <div role="tablist" aria-label="Account" className="grid grid-cols-2 gap-1 p-1 rounded-2xl neu-inset">
        {(['signup', 'signin'] as const).map(m => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => onChange(m)}
                className={`py-2 rounded-xl text-[13px] font-medium transition-colors ${mode === m ? 'neu-raised-sm text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'}`}>
                {m === 'signup' ? 'Create account' : 'Sign in'}
            </button>
        ))}
    </div>
);

const GoogleButton: React.FC<{ mode: Mode; busy: Busy; onClick: () => void }> = ({ mode, busy, onClick }) => (
    <>
        <button type="button" onClick={onClick} disabled={busy !== null}
            className="mt-6 w-full h-12 rounded-2xl neu-raised-sm neu-btn flex items-center justify-center gap-3 text-[15px] font-medium text-gray-900 dark:text-gray-100 disabled:opacity-60 active-scale">
            <GoogleMark />
            {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
        </button>
        {mode === 'signup' && (
            <p className="mt-2.5 text-[12px] text-center text-gray-500 dark:text-gray-400">
                By continuing with Google you agree to the <a href="/legal#terms" className="underline underline-offset-2">terms</a> and <a href="/legal#privacy" className="underline underline-offset-2">privacy policy</a>.
            </p>
        )}
    </>
);

const EmailForm: React.FC<{
    mode: Mode; busy: Busy; spaced: boolean;
    onSubmit: (details: { name: string; email: string; password: string }) => void;
    onForgot: () => void;
}> = ({ mode, busy, spaced, onSubmit, onForgot }) => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [agree, setAgree] = useState(false);
    const signup = mode === 'signup';
    const submitLabel = signup ? 'Create account' : 'Sign in';
    return (
        <form className={`space-y-4 ${spaced ? 'mt-6' : ''}`} onSubmit={e => { e.preventDefault(); onSubmit({ name, email, password }); }}>
            {signup && (
                <Field label="Your name" htmlFor="a-name"><Input id="a-name" required autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></Field>
            )}
            <Field label="Email" htmlFor="a-email"><Input id="a-email" required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
            <Field label="Password" htmlFor="a-pass" hint={signup ? 'At least 10 characters.' : undefined}>
                <div className="relative">
                    <Input id="a-pass" required type={showPassword ? 'text' : 'password'} minLength={signup ? 10 : undefined}
                        autoComplete={signup ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)}
                        className="!pr-11" />
                    <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-900 dark:hover:text-gray-100">
                        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                </div>
            </Field>
            {!signup && (
                <div className="-mt-2 text-right">
                    <button type="button" onClick={onForgot} className="text-[13px] text-gray-600 dark:text-gray-400 underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-100">
                        Forgot password?
                    </button>
                </div>
            )}
            {signup && (
                <label className="flex items-start gap-2.5 text-[13px] text-gray-700 dark:text-gray-300">
                    <input type="checkbox" className="mt-0.5 accent-[#c9a227]" checked={agree} onChange={e => setAgree(e.target.checked)} required />
                    <span>I agree to the <a href="/legal#terms" className="underline underline-offset-2">terms</a> and <a href="/legal#privacy" className="underline underline-offset-2">privacy policy</a>.</span>
                </label>
            )}
            <Button type="submit" variant="primary" block disabled={busy !== null}>
                {busy === 'email' ? 'One moment…' : submitLabel}
            </Button>
        </form>
    );
};

const SwitchModeLine: React.FC<{ mode: Mode; onChange: (m: Mode) => void }> = ({ mode, onChange }) => {
    const link = 'font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2';
    return (
        <p className="mt-6 text-[13px] text-center text-gray-600 dark:text-gray-400">
            {mode === 'signup'
                ? <>Already have an account? <button type="button" className={link} onClick={() => onChange('signin')}>Sign in</button></>
                : <>New here? <button type="button" className={link} onClick={() => onChange('signup')}>Create an account</button></>}
        </p>
    );
};

const InvitationOnly: React.FC<{ onSignIn: () => void }> = ({ onSignIn }) => (
    <Card padding="lg" className="!p-6 sm:!p-8">
        <h1 className="font-serif text-[1.7rem] leading-tight text-gray-900 dark:text-gray-100">Sign-up is by invitation for now</h1>
        <p className="mt-2 text-gray-700 dark:text-gray-300">We are onboarding businesses personally at the moment. Get in touch and we will set you up.</p>
        <div className="mt-6 flex flex-wrap gap-2">
            <a href={`${HOME_URL}#contact`} className="neu-button neu-button-primary">Contact us</a>
            <Button onClick={onSignIn}>I already have an account</Button>
        </div>
    </Card>
);

/* -------------------------------- Passwords and email confirmation */

/** Asks for a reset link. The answer is the same whether or not the address has an account. */
const ForgotPassword: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [sentTo, setSentTo] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setProblem(null);
        const { error } = await authClient.requestPasswordReset({ email, redirectTo: `${location.pathname}?mode=reset` });
        setBusy(false);
        if (error) setProblem(error.message || 'That did not work. Try again in a minute.');
        else setSentTo(email);
    };
    return (
        <Card padding="lg" className="!p-6 sm:!p-8">
            <h1 className="font-serif text-[1.7rem] leading-tight text-gray-900 dark:text-gray-100">Reset your password</h1>
            {sentTo ? (
                <>
                    <p className="mt-3 text-[14px] text-gray-700 dark:text-gray-300">
                        If there is an account for <strong className="font-medium break-all">{sentTo}</strong>, we have emailed it a link to choose a new password. The link works for one hour.
                    </p>
                    <p className="mt-2 text-[13px] text-gray-600 dark:text-gray-400">Nothing after a few minutes? Check your spam folder, or try again.</p>
                </>
            ) : (
                <form className="mt-5 space-y-4" onSubmit={send}>
                    <p className="text-[13px] text-gray-600 dark:text-gray-400">Enter the email you sign in with. We will send you a link to choose a new password.</p>
                    {problem && <p role="alert" className="rounded-xl px-3.5 py-2.5 text-[13px] bg-red-500/10 text-red-700 dark:text-red-300">{problem}</p>}
                    <Field label="Email" htmlFor="f-email"><Input id="f-email" required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></Field>
                    <Button type="submit" variant="primary" block disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button>
                </form>
            )}
            <p className="mt-6 text-[13px] text-center">
                <button type="button" onClick={onBack} className="font-medium text-gray-900 dark:text-gray-100 underline underline-offset-2">Back to sign in</button>
            </p>
        </Card>
    );
};

const EXPIRED_LINK = 'This link has expired or was already used. Ask for a new one.';

/** Where the reset email's link lands: choose a new password. */
const ResetPassword: React.FC<{ token: string | null; failed: boolean }> = ({ token, failed }) => {
    const [password, setPassword] = useState('');
    const [again, setAgain] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [expired, setExpired] = useState(failed || !token);
    const signInUrl = `${location.pathname}?mode=signin`;

    const save = async (e: React.FormEvent) => {
        e.preventDefault();
        if (password !== again) { setProblem('The two passwords are different.'); return; }
        setBusy(true);
        setProblem(null);
        const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? '' });
        setBusy(false);
        if (!error) setDone(true);
        else if (/token/i.test(error.message ?? '')) setExpired(true);
        else setProblem(error.message || 'That did not work. Try again.');
    };

    if (expired) {
        return (
            <main className="max-w-md mx-auto px-5 pt-10 pb-16 space-y-4">
                <p role="alert" className="rounded-xl px-3.5 py-2.5 text-[13px] bg-red-500/10 text-red-700 dark:text-red-300">{EXPIRED_LINK}</p>
                <ForgotPassword onBack={() => { location.href = signInUrl; }} />
            </main>
        );
    }
    return (
        <main className="max-w-md mx-auto px-5 pt-10 pb-16">
            <Card padding="lg" className="!p-6 sm:!p-8">
                <h1 className="font-serif text-[1.7rem] leading-tight text-gray-900 dark:text-gray-100">{done ? 'Password changed' : 'Choose a new password'}</h1>
                {done ? (
                    <>
                        <p className="mt-3 text-[14px] text-gray-700 dark:text-gray-300">You are signed out on every device. Sign in again with your new password.</p>
                        <a href={signInUrl} className="mt-6 neu-button neu-button-primary w-full justify-center">Sign in</a>
                    </>
                ) : (
                    <form className="mt-5 space-y-4" onSubmit={save}>
                        {problem && <p role="alert" className="rounded-xl px-3.5 py-2.5 text-[13px] bg-red-500/10 text-red-700 dark:text-red-300">{problem}</p>}
                        <Field label="New password" htmlFor="r-pass" hint="At least 10 characters.">
                            <Input id="r-pass" required type="password" minLength={10} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
                        </Field>
                        <Field label="Type it again" htmlFor="r-pass2">
                            <Input id="r-pass2" required type="password" minLength={10} autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} />
                        </Field>
                        <Button type="submit" variant="primary" block disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</Button>
                    </form>
                )}
            </Card>
        </main>
    );
};

/** Shown while the address is unconfirmed: the application can be filled in, not sent. */
const ConfirmEmailNotice: React.FC<{ email: string }> = ({ email }) => {
    const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const resend = async () => {
        setState('sending');
        const { error } = await authClient.sendVerificationEmail({ email, callbackURL: location.pathname });
        if (error) { toast.error(error.message || 'Could not send the link. Try again in a minute.'); setState('idle'); }
        else setState('sent');
    };
    const label = { idle: 'Send the link again', sending: 'Sending…', sent: 'Link sent' }[state];
    return (
        <div role="status" className="rounded-2xl px-4 py-3.5 bg-gold-500/10 text-[14px] text-gray-800 dark:text-gray-200 flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex-1 min-w-[14rem]">
                <strong className="font-medium">Confirm your email.</strong> We sent a link to <span className="[overflow-wrap:anywhere]">{email}</span>. You can fill everything in now; sending the application needs the confirmed address.
            </p>
            <Button onClick={resend} disabled={state !== 'idle'}>{label}</Button>
        </div>
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
                    <h1 className="font-serif text-[1.75rem] leading-tight text-gray-900 dark:text-gray-100">Choose a plan</h1>
                    <p className="text-[13px] mt-1.5 text-gray-600 dark:text-gray-400">You can change this later. Nothing is charged until we have reviewed your application.</p>
                </div>
                <div className="flex gap-1 p-1 rounded-2xl neu-inset">
                    <button type="button" onClick={() => setCycle('monthly')} aria-pressed={cycle === 'monthly'} className={`px-3.5 py-1.5 rounded-xl text-[13px] ${cycle === 'monthly' ? 'neu-raised-sm text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-600 dark:text-gray-400'}`}>Monthly</button>
                    <button type="button" onClick={() => setCycle('annual')} aria-pressed={cycle === 'annual'} className={`px-3.5 py-1.5 rounded-xl text-[13px] ${cycle === 'annual' ? 'neu-raised-sm text-gray-900 dark:text-gray-100 font-medium' : 'text-gray-600 dark:text-gray-400'}`}>Yearly</button>
                </div>
            </div>
            {plans === null && <p className="mt-6 text-sm">Loading plans…</p>}
            {plans?.length === 0 && (
                <p className="mt-6 text-sm text-gray-700 dark:text-gray-300">No plans are open yet. Save your details and we will be in touch.</p>
            )}
            {plans && plans.length > 0 && (
                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                    {plans.map(p => <PlanCard key={p.key} plan={p} cycle={cycle} selected={selected === p.key} onChoose={() => setSelected(p.key)} />)}
                </div>
            )}
            <div className="mt-7 flex justify-between">
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
                <div className="flex items-start gap-4">
                    <span className={`w-11 h-11 shrink-0 rounded-full neu-inset flex items-center justify-center ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-gold-700 dark:text-gold-300'}`}>{s.icon}</span>
                    <div className="min-w-0">
                        <h1 className="font-serif text-[1.6rem] leading-tight text-gray-900 dark:text-gray-100">{s.title}</h1>
                        <p className="mt-1.5 text-gray-700 dark:text-gray-300">{s.body}</p>
                    </div>
                </div>
                {app.providerMessage && ['needs_information', 'rejected'].includes(app.status) && (
                    <blockquote className="mt-5 neu-inset rounded-xl p-4 text-gray-800 dark:text-gray-200">
                        <p className="text-[11px] uppercase tracking-[0.12em] text-gray-600 dark:text-gray-400 mb-1">Message from us</p>
                        {app.providerMessage}
                    </blockquote>
                )}
                <div className="mt-6 flex flex-wrap gap-2">
                    {['pending_review', 'needs_information'].includes(app.status) && <Button onClick={onEdit}>Update details</Button>}
                    {app.status === 'needs_information' && <Button variant="primary" disabled={busy} onClick={onResubmit}>Send again</Button>}
                </div>
            </Card>
            <Card padding="lg">
                <p className="font-medium text-gray-900 dark:text-gray-100">{app.businessName}</p>
                <ol className="mt-4 space-y-2.5">
                    {events.map((e, i) => (
                        <li key={i} className="text-[13px] grid gap-0.5 sm:grid-cols-[11rem_1fr] sm:gap-3">
                            <span className="text-gray-600 dark:text-gray-400 tabular-nums">{new Date(e.at).toLocaleString()}</span>
                            <span className="text-gray-800 dark:text-gray-200 break-words">{e.action.replace(/[._]/g, ' ')}{e.message ? ` — ${e.message}` : ''}</span>
                        </li>
                    ))}
                </ol>
            </Card>
        </div>
    );
};
