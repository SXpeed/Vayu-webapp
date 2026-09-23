// The public website: what it is, what it does, how to start, and pricing.
//
// Mostly static. The only live data is the branding and the plans the
// control centre has published as public — nothing internal is fetched,
// and none of the motion talks to the server.
//
// Motion here is the expressive half of the product's motion language
// (site.css, motion.tsx): a short hero entrance, one product illustration,
// sections that rise into place once, a story panel that follows the text,
// and steps that light up in order. The app itself stays quick and quiet.

import React, { useRef, useState } from 'react';
import {
    ArrowRight, BookOpen, CalendarDays, Clock, FileText, History, Image, Library, MessageCircle, Search, ShieldCheck,
} from 'lucide-react';
import { content } from './content';
import { PlanCard, SIGNUP_URL, SiteFooter, SiteHeader, Text, usePublicPlans } from './common';
import { useActiveId, useMarketingScroll, useReached, useReducedMotion, useReveals } from './motion';
import { Caption, HeroArt, SCENES } from './illustrations';
import './site.css';

const NAV_IDS = ['features', 'how', 'pricing', 'about', 'contact'];
const FEATURE_ICONS = [Image, BookOpen, Library, Search, FileText, MessageCircle, CalendarDays, Clock, ShieldCheck, History];

/** A --i index for staggered reveals and the hero delay, as inline style. */
const i = (n: number): React.CSSProperties => ({ ['--i' as string]: n });
const d = (ms: number): React.CSSProperties => ({ ['--d' as string]: `${ms}ms` });

const SectionHeading: React.FC<{ eyebrow: string; title: string; body?: string; id?: string; center?: boolean }> = ({ eyebrow, title, body, id, center = false }) => (
    <div className={center ? 'text-center max-w-2xl mx-auto' : 'max-w-2xl'}>
        <p data-reveal style={i(0)} className="text-[11px] font-medium uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300">{eyebrow}</p>
        <h2 id={id} data-reveal style={i(1)} className="mt-3 font-serif text-3xl sm:text-4xl lg:text-[2.6rem] leading-[1.12] text-gray-900 dark:text-gray-100">{title}</h2>
        {body && <p data-reveal style={i(2)} className="mt-4 text-base lg:text-lg font-light leading-relaxed text-gray-700 dark:text-gray-300">{body}</p>}
    </div>
);

export const Landing: React.FC = () => {
    const plans = usePublicPlans();
    const [cycle, setCycle] = useState<'monthly' | 'annual'>('monthly');
    const hasPaid = plans?.some(p => p.billingType === 'paid');

    const reduced = useReducedMotion();
    const root = useRef<HTMLDivElement>(null);
    const steps = useRef<HTMLOListElement>(null);
    useReveals(root);
    useMarketingScroll(!reduced);
    useReached(steps, '.mk-step');
    const activeSection = useActiveId(NAV_IDS);
    const story = content.story.steps;
    const activeStory = useActiveId(story.map(s => s.id), 0.55) ?? story[0].id;

    const words = content.hero.headline.split(' ');

    return (
        <div ref={root} className="mk min-h-dvh bg-[var(--neu-bg)] overflow-x-clip">
            <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 neu-button neu-button-primary">Skip to content</a>
            <SiteHeader active={activeSection} />

            <main id="main">
                {/* ── Hero ─────────────────────────────────────────────── */}
                <section aria-labelledby="hero-title"
                    className="relative max-w-6xl mx-auto px-5 pt-10 pb-20 sm:pt-16 lg:pt-20 lg:pb-28 grid lg:grid-cols-[1.02fr_0.98fr] gap-14 lg:gap-10 items-center">
                    <div>
                        <p className="mk-rise text-[11px] sm:text-[12px] uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300" style={d(40)}>{content.hero.eyebrow}</p>
                        {/* Words rise one after another; they stay real text, so the heading reads as one sentence. */}
                        <h1 id="hero-title" className="mt-4 font-serif text-[2.4rem] sm:text-5xl lg:text-[3.6rem] leading-[1.06] tracking-[-0.01em] text-gray-900 dark:text-gray-100">
                            {words.map((w, n) => (
                                <React.Fragment key={n}>
                                    <span className="mk-word mk-rise" style={d(110 + n * 45)}>{w}</span>{n < words.length - 1 ? ' ' : ''}
                                </React.Fragment>
                            ))}
                        </h1>
                        <p className="mk-rise mt-6 text-lg font-light leading-relaxed text-gray-700 dark:text-gray-300 max-w-xl" style={d(430)}>{content.hero.subline}</p>
                        <div className="mk-rise mt-8 flex flex-wrap gap-3" style={d(520)}>
                            <a href={SIGNUP_URL} className="neu-button neu-button-primary !px-6 !py-3 text-base">
                                {content.hero.primaryCta} <ArrowRight size={18} />
                            </a>
                            <a href="#pricing" className="neu-button !px-6 !py-3 text-base">{content.hero.secondaryCta}</a>
                        </div>
                        <p className="mk-rise mt-5 text-[12px] font-light text-gray-600 dark:text-gray-400" style={d(600)}>
                            Every application is reviewed before anything is charged.
                        </p>
                    </div>

                    <div className="relative mk-settle" style={d(260)}>
                        {/* A soft gold light behind the illustration; drifts slightly as the page scrolls. */}
                        <div aria-hidden data-parallax className="mk-glow absolute -inset-8 sm:-inset-12 pointer-events-none"
                            style={{ background: 'radial-gradient(closest-side, rgba(212,175,55,0.2), rgba(212,175,55,0.06) 55%, transparent)' }} />
                        <div className="relative"><HeroArt /></div>
                    </div>
                </section>

                {/* ── What it does ─────────────────────────────────────── */}
                <section aria-labelledby="what-title" className="max-w-4xl mx-auto px-5 py-14 lg:py-20 text-center">
                    <p id="what-title" data-reveal style={i(0)} className="text-[11px] font-medium uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300">What it does</p>
                    <p data-reveal style={i(1)} className="mt-5 font-serif text-[1.45rem] sm:text-2xl lg:text-[2rem] leading-[1.4] text-gray-900 dark:text-gray-100">
                        {content.whatItDoes}
                    </p>
                </section>

                {/* ── The workflow: a panel that follows the text ─────── */}
                <section aria-labelledby="story-title" className="max-w-6xl mx-auto px-5 py-14 lg:py-24">
                    <SectionHeading id="story-title" eyebrow={content.story.eyebrow} title={content.story.title} body={content.story.body} />
                    <div className="mt-12 lg:mt-4 lg:grid lg:grid-cols-2 lg:gap-16">
                        {/* Computer: one sticky panel; the illustration matches the paragraph being read. */}
                        <div className="hidden lg:block">
                            <div className="sticky top-24 pt-12">
                                {/* Every scene shares one grid cell, so the panel is as tall as the tallest and never crops. */}
                                <div className="grid">
                                    {SCENES.map((Scene, n) => (
                                        <div key={n} className="mk-scene [grid-area:1/1]" data-active={activeStory === story[n].id ? 'true' : 'false'}
                                            aria-hidden={activeStory !== story[n].id}>
                                            <Scene />
                                        </div>
                                    ))}
                                </div>
                                <div className="mt-4"><Caption>Illustration · sample data</Caption></div>
                            </div>
                        </div>
                        <ol className="space-y-16 lg:space-y-0">
                            {story.map((s, n) => {
                                const Scene = SCENES[n];
                                return (
                                    <li key={s.id} id={s.id} className="mk-story-item lg:min-h-[54vh] lg:flex lg:items-center"
                                        data-active={activeStory === s.id ? 'true' : 'false'}>
                                        <div className="w-full">
                                            {/* Phone and tablet: each paragraph carries its own illustration. */}
                                            <div className="lg:hidden mb-6" data-reveal="scale">
                                                <Scene />
                                                <div className="mt-3"><Caption>Illustration · sample data</Caption></div>
                                            </div>
                                            <p data-reveal style={i(0)} className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.2em] text-gold-700 dark:text-gold-300">
                                                <span className="w-7 h-7 rounded-full neu-inset flex items-center justify-center font-serif text-[13px] tracking-normal">{n + 1}</span>
                                                {s.label}
                                            </p>
                                            <h3 data-reveal style={i(1)} className="mt-4 font-serif text-2xl lg:text-[2rem] leading-tight text-gray-900 dark:text-gray-100">{s.title}</h3>
                                            <p data-reveal style={i(2)} className="mt-3 text-base lg:text-lg font-light leading-relaxed text-gray-700 dark:text-gray-300 max-w-md">{s.body}</p>
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    </div>
                </section>

                {/* ── Features ─────────────────────────────────────────── */}
                <section id="features" aria-labelledby="features-title" className="max-w-6xl mx-auto px-5 py-14 lg:py-24">
                    <SectionHeading id="features-title" eyebrow="Features" title="Everything in one workspace" />
                    <ul className="mt-10 grid gap-5 lg:gap-6 sm:grid-cols-2 lg:grid-cols-3">
                        {content.features.map((f, n) => {
                            const Icon = FEATURE_ICONS[n] ?? Image;
                            return (
                                <li key={f.title} data-reveal style={i(n % 3)} className="mk-feature neu-card p-5 lg:p-6">
                                    <span className="mk-icon w-11 h-11 rounded-2xl neu-inset flex items-center justify-center text-gold-600 dark:text-gold-300">
                                        <Icon size={19} strokeWidth={1.8} />
                                    </span>
                                    <p className="mt-4 font-serif text-lg text-gray-900 dark:text-gray-100">{f.title}</p>
                                    <p className="mt-1.5 text-[14px] font-light leading-relaxed text-gray-600 dark:text-gray-400">{f.body}</p>
                                </li>
                            );
                        })}
                    </ul>
                </section>

                {/* ── How it works ─────────────────────────────────────── */}
                <section id="how" aria-labelledby="how-title" className="max-w-6xl mx-auto px-5 py-14 lg:py-24">
                    <SectionHeading id="how-title" eyebrow="How it works" title="From application to your own workspace" />
                    <ol ref={steps} className="mt-12 grid gap-10 lg:gap-6 lg:grid-cols-4">
                        {content.howItWorks.map((s, n) => {
                            const last = n === content.howItWorks.length - 1;
                            return (
                                <li key={s.title} className="mk-step relative pl-16 lg:pl-0" style={i(n)}>
                                    {/* The rail to the next step: across on a computer, down on a phone. */}
                                    {!last && (
                                        <>
                                            <span aria-hidden className="mk-rail hidden lg:block absolute top-6 left-16 -right-3 h-[3px] rounded-full neu-inset"><span /></span>
                                            <span aria-hidden className="mk-rail mk-rail-v lg:hidden absolute left-6 top-14 -bottom-8 w-[3px] -translate-x-1/2 rounded-full neu-inset"><span /></span>
                                        </>
                                    )}
                                    <span className="mk-step-num absolute left-0 top-0 lg:static w-12 h-12 rounded-full flex items-center justify-center font-serif text-lg">
                                        {n + 1}
                                    </span>
                                    <p className="lg:mt-5 font-serif text-lg text-gray-900 dark:text-gray-100">{s.title}</p>
                                    <p className="mt-1.5 text-[14px] font-light leading-relaxed text-gray-600 dark:text-gray-400 max-w-xs">{s.body}</p>
                                </li>
                            );
                        })}
                    </ol>
                    <div data-reveal className="mt-12">
                        <a href={SIGNUP_URL} className="neu-button neu-button-primary">Start your application <ArrowRight size={16} /></a>
                    </div>
                </section>

                {/* ── Pricing ──────────────────────────────────────────── */}
                <section id="pricing" aria-labelledby="pricing-title" className="max-w-6xl mx-auto px-5 py-14 lg:py-24">
                    <div className="flex flex-wrap items-end justify-between gap-6">
                        <SectionHeading id="pricing-title" eyebrow="Pricing" title="Choose a plan" />
                        {hasPaid && (
                            <div data-reveal style={i(2)} className="flex gap-2" role="group" aria-label="Billing period">
                                <button type="button" onClick={() => setCycle('monthly')} aria-pressed={cycle === 'monthly'} className={`neu-pill ${cycle === 'monthly' ? 'neu-pill-active' : ''}`}>Monthly</button>
                                <button type="button" onClick={() => setCycle('annual')} aria-pressed={cycle === 'annual'} className={`neu-pill ${cycle === 'annual' ? 'neu-pill-active' : ''}`}>Yearly</button>
                            </div>
                        )}
                    </div>
                    {/* Space is kept while plans load, so the page below does not jump. */}
                    <div className="mt-10 min-h-[16rem]">
                        {plans === null ? (
                            <div className="grid gap-5 lg:gap-6 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading plans">
                                {[0, 1, 2].map(n => <div key={n} className="neu-card h-[22rem] opacity-60" />)}
                            </div>
                        ) : plans.length === 0 ? (
                            <p className="text-gray-700 dark:text-gray-300">Plans are being finalised. <a href={SIGNUP_URL} className="text-gold-700 underline">Apply now</a> and we will set you up.</p>
                        ) : (
                            <div className="grid gap-5 lg:gap-6 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
                                {plans.map((p, n) => (
                                    <div key={p.key} data-reveal="scale" style={i(n)} className="flex">
                                        <PlanCard plan={p} cycle={cycle} className="mk-plan w-full" cta={`Start with ${p.name}`}
                                            href={`${SIGNUP_URL}?plan=${encodeURIComponent(p.key)}&cycle=${cycle}`} />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </section>

                {/* ── About + contact ──────────────────────────────────── */}
                <section className="max-w-6xl mx-auto px-5 py-14 lg:py-20 grid gap-6 lg:grid-cols-2">
                    <div id="about" data-reveal style={i(0)} className="neu-card p-6 lg:p-8">
                        <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{content.about.title}</h2>
                        <p className="mt-3 font-light text-gray-700 dark:text-gray-300"><Text copy={content.about.body} /></p>
                    </div>
                    <div id="contact" data-reveal style={i(1)} className="neu-card p-6 lg:p-8">
                        <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100">{content.contact.title}</h2>
                        <p className="mt-3 font-light text-gray-700 dark:text-gray-300">{content.contact.note}</p>
                        <p className="mt-4 text-sm"><span className="text-gray-600 dark:text-gray-400">Email · </span><Text copy={content.contact.email} /></p>
                        <p className="mt-2 text-sm"><span className="text-gray-600 dark:text-gray-400">Address · </span><Text copy={content.contact.address} /></p>
                    </div>
                </section>

                {/* ── Closing call to action ───────────────────────────── */}
                <section aria-labelledby="cta-title" className="max-w-6xl mx-auto px-5 pt-6 pb-4 lg:pt-10">
                    <div data-reveal="scale" className="neu-card relative overflow-hidden px-6 py-12 sm:px-10 lg:px-16 lg:py-16 text-center">
                        <div aria-hidden className="absolute inset-0 pointer-events-none"
                            style={{ background: 'radial-gradient(60% 90% at 50% 0%, rgba(212,175,55,0.16), transparent 70%)' }} />
                        <div className="relative">
                            <h2 id="cta-title" className="font-serif text-3xl sm:text-4xl text-gray-900 dark:text-gray-100">Start your application</h2>
                            <p className="mt-3 font-light text-gray-700 dark:text-gray-300">Every application is reviewed before anything is charged.</p>
                            <div className="mt-8 flex flex-wrap justify-center gap-3">
                                <a href={SIGNUP_URL} className="neu-button neu-button-primary !px-6 !py-3 text-base">{content.hero.primaryCta} <ArrowRight size={18} /></a>
                                <a href="#pricing" className="neu-button !px-6 !py-3 text-base">{content.hero.secondaryCta}</a>
                            </div>
                        </div>
                    </div>
                </section>
            </main>

            <SiteFooter />
        </div>
    );
};
