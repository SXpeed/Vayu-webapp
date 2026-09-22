// The public website: what it is, what it does, how to start, and pricing.
//
// Mostly static. The only live data is the branding and the plans the
// control centre has published as public — nothing internal is fetched.

import React, { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useBranding } from '../useBranding';
import { content } from './content';
import { PlanCard, SIGNUP_URL, SiteFooter, SiteHeader, Text, usePublicPlans } from './common';

export const Landing: React.FC = () => {
    const b = useBranding();
    const plans = usePublicPlans();
    const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');
    const hasPaid = plans?.some(p => p.billingType === 'paid');

    return (
        <div className="min-h-dvh bg-[var(--neu-bg)]">
            <SiteHeader />

            {/* Hero */}
            <section className="max-w-6xl mx-auto px-4 pt-16 pb-20 lg:pt-24 lg:pb-28 grid lg:grid-cols-[1.1fr_0.9fr] gap-12 items-center">
                <div>
                    <p className="text-[12px] uppercase tracking-[0.18em] text-gold-700 dark:text-gold-300">{content.hero.eyebrow}</p>
                    <h1 className="mt-4 font-serif text-4xl sm:text-5xl lg:text-6xl leading-[1.08] text-gray-900 dark:text-gray-100">
                        {content.hero.headline}
                    </h1>
                    <p className="mt-6 text-lg text-gray-700 dark:text-gray-300 max-w-xl">{content.hero.subline}</p>
                    <div className="mt-8 flex flex-wrap gap-3">
                        <a href={SIGNUP_URL} className="neu-button neu-button-primary !px-6 !py-3 text-base">
                            {content.hero.primaryCta} <ArrowRight size={18} />
                        </a>
                        <a href="#pricing" className="neu-button !px-6 !py-3 text-base">{content.hero.secondaryCta}</a>
                    </div>
                </div>
                <div className="neu-card p-6 lg:p-8">
                    <p className="text-[11px] uppercase tracking-[0.16em] text-gray-600 dark:text-gray-400">{b.appName}</p>
                    <ul className="mt-4 space-y-4">
                        {content.features.slice(0, 4).map((f, i) => (
                            <li key={f.title} className="flex gap-4">
                                <span className="w-9 h-9 rounded-xl neu-inset flex items-center justify-center font-serif text-gold-700 dark:text-gold-300 shrink-0">{i + 1}</span>
                                <span>
                                    <span className="block font-medium text-gray-900 dark:text-gray-100">{f.title}</span>
                                    <span className="block text-[13px] text-gray-600 dark:text-gray-400">{f.body}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>

            {/* What it does */}
            <section className="max-w-4xl mx-auto px-4 text-center">
                <h2 className="font-serif text-3xl text-gray-900 dark:text-gray-100">What it does</h2>
                <p className="mt-4 text-lg text-gray-700 dark:text-gray-300">{content.whatItDoes}</p>
            </section>

            {/* Features */}
            <section id="features" className="max-w-6xl mx-auto px-4 mt-24 scroll-mt-20">
                <h2 className="font-serif text-3xl text-gray-900 dark:text-gray-100">Features</h2>
                <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    {content.features.map(f => (
                        <div key={f.title} className="neu-card p-5">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{f.title}</p>
                            <p className="mt-1.5 text-[14px] text-gray-600 dark:text-gray-400">{f.body}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* How it works */}
            <section id="how" className="max-w-6xl mx-auto px-4 mt-24 scroll-mt-20">
                <h2 className="font-serif text-3xl text-gray-900 dark:text-gray-100">How it works</h2>
                <ol className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    {content.howItWorks.map((s, i) => (
                        <li key={s.title} className="neu-card p-5">
                            <span className="font-serif text-3xl text-gold-700 dark:text-gold-300">{i + 1}</span>
                            <p className="mt-2 font-medium text-gray-900 dark:text-gray-100">{s.title}</p>
                            <p className="mt-1.5 text-[14px] text-gray-600 dark:text-gray-400">{s.body}</p>
                        </li>
                    ))}
                </ol>
                <div className="mt-8">
                    <a href={SIGNUP_URL} className="neu-button neu-button-primary">Start your application <ArrowRight size={16} /></a>
                </div>
            </section>

            {/* Pricing */}
            <section id="pricing" className="max-w-6xl mx-auto px-4 mt-24 scroll-mt-20">
                <div className="flex flex-wrap items-end justify-between gap-4">
                    <h2 className="font-serif text-3xl text-gray-900 dark:text-gray-100">Pricing</h2>
                    {hasPaid && (
                        <div className="flex gap-2" role="group" aria-label="Billing period">
                            <button type="button" onClick={() => setCycle('monthly')} className={`neu-pill ${cycle === 'monthly' ? 'neu-pill-active' : ''}`}>Monthly</button>
                            <button type="button" onClick={() => setCycle('annual')} className={`neu-pill ${cycle === 'annual' ? 'neu-pill-active' : ''}`}>Yearly</button>
                        </div>
                    )}
                </div>
                {plans === null ? <p className="mt-6 text-sm text-gray-600">Loading plans…</p> : plans.length === 0 ? (
                    <p className="mt-6 text-gray-700 dark:text-gray-300">Plans are being finalised. <a href={SIGNUP_URL} className="text-gold-700 underline">Apply now</a> and we will set you up.</p>
                ) : (
                    <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {plans.map(p => (
                            <PlanCard key={p.key} plan={p} cycle={cycle} cta={`Start with ${p.name}`} href={`${SIGNUP_URL}?plan=${encodeURIComponent(p.key)}&cycle=${cycle}`} />
                        ))}
                    </div>
                )}
                <p className="mt-4 text-[12px] text-gray-600 dark:text-gray-400">Every application is reviewed before anything is charged.</p>
            </section>

            {/* About + contact */}
            <section className="max-w-6xl mx-auto px-4 mt-24 grid gap-6 lg:grid-cols-2">
                <div id="about" className="neu-card p-6 scroll-mt-20">
                    <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{content.about.title}</h2>
                    <p className="mt-3 text-gray-700 dark:text-gray-300"><Text copy={content.about.body} /></p>
                </div>
                <div id="contact" className="neu-card p-6 scroll-mt-20">
                    <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{content.contact.title}</h2>
                    <p className="mt-3 text-gray-700 dark:text-gray-300">{content.contact.note}</p>
                    <p className="mt-4 text-sm"><span className="text-gray-600 dark:text-gray-400">Email · </span><Text copy={content.contact.email} /></p>
                    <p className="mt-2 text-sm"><span className="text-gray-600 dark:text-gray-400">Address · </span><Text copy={content.contact.address} /></p>
                </div>
            </section>

            <SiteFooter />
        </div>
    );
};
