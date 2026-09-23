// Product illustrations for the welcome page, drawn in HTML and CSS in the
// app's own style — no video, canvas or image downloads. Every one shows a
// real capability with sample data, and says so in its caption.
//
// Statuses use the app's actual values: artworks are Available, Reserved or
// Sold; inquiries go New → Contacted → Interested → Converted; invoices are
// Draft, Sent or Paid.

import React, { useEffect, useRef, useState } from 'react';
import { Check, FileText, Pause, Play } from 'lucide-react';
import { useReducedMotion } from './motion';

interface Work { title: string; medium: string; price: string; status: 'Available' | 'Reserved' | 'Sold'; paint: string }

/** Sample works: soft painterly gradients stand in for photographs. */
const WORKS: Work[] = [
    { title: 'Golden Hour', medium: 'Oil on canvas', price: '₹85,000', status: 'Available', paint: 'linear-gradient(135deg, #8a5a2b, #c9a14a 55%, #ecd9a0)' },
    { title: 'Still Water', medium: 'Acrylic', price: '₹62,000', status: 'Available', paint: 'linear-gradient(160deg, #1f4750, #4d7f86 55%, #b3cfcb)' },
    { title: 'First Rain', medium: 'Mixed media', price: '₹48,000', status: 'Reserved', paint: 'linear-gradient(145deg, #4a2f45, #8a5470 55%, #d8a6ab)' },
    { title: 'Monsoon', medium: 'Watercolour', price: '₹36,000', status: 'Available', paint: 'linear-gradient(170deg, #2f3a5e, #5f6f9e 55%, #c0c8e2)' },
    { title: 'Terracotta', medium: 'Oil on linen', price: '₹54,000', status: 'Sold', paint: 'linear-gradient(135deg, #7a3b24, #b86a45 55%, #eabf9b)' },
    { title: 'Indigo Field', medium: 'Print', price: '₹18,000', status: 'Available', paint: 'linear-gradient(150deg, #1e2a4a, #3d5a8a 55%, #a6bbdb)' },
];
/** The three picked for the catalog, in order. */
const PICKED = [0, 1, 3];

const STATUS_DOT: Record<Work['status'], string> = { Available: 'bg-green-500', Reserved: 'bg-amber-500', Sold: 'bg-red-500' };

const Swatch: React.FC<{ paint: string; className?: string }> = ({ paint, className = '' }) => (
    <span aria-hidden className={`mk-swatch block rounded-[0.6em] ${className}`}
        style={{ backgroundImage: `radial-gradient(circle at 28% 24%, rgba(255,255,255,0.38), transparent 52%), radial-gradient(circle at 78% 82%, rgba(0,0,0,0.18), transparent 50%), ${paint}` }} />
);

const Caption: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-gray-500 dark:text-gray-400">{children}</p>
);

/* ─────────────────────────── Hero: artworks → catalog ────────────────── */

/**
 * Three works are picked from the inventory and a catalog assembles from
 * them — "Catalogs in minutes", shown rather than told. One CSS loop on a
 * shared clock (site.css). It pauses when off screen, when the tab is
 * hidden, or with the button; with reduced motion it shows the finished
 * catalog and does not move.
 */
export const HeroArt: React.FC = () => {
    const reduced = useReducedMotion();
    const ref = useRef<HTMLElement>(null);
    const [userPaused, setUserPaused] = useState(false);
    const [offscreen, setOffscreen] = useState(false);
    const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(([e]) => setOffscreen(!e.isIntersecting), { threshold: 0 });
        io.observe(el);
        const onVis = () => setHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', onVis);
        return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
    }, []);

    const paused = userPaused || offscreen || hidden;

    return (
        <figure ref={ref} className="mk-art relative w-full max-w-[560px] mx-auto" data-paused={paused ? 'true' : 'false'}
            aria-label="Illustration: three artworks are picked from the inventory and become a catalog">
            <div className="relative w-full aspect-[1.12]" aria-hidden="true">
                {/* Inventory */}
                <div className="absolute left-0 top-0 w-[76%] neu-card p-[3.4cqw]" style={{ borderRadius: '4cqw' }}>
                    <div className="flex items-center justify-between gap-2">
                        <span className="font-serif text-gold-700 dark:text-gold-300 text-[clamp(11px,3.4cqw,20px)] leading-none">Inventory</span>
                        <span className="text-[clamp(7px,1.7cqw,10px)] uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">36 works</span>
                    </div>
                    <div className="mt-[2.6cqw] grid grid-cols-3 gap-[2.2cqw]">
                        {WORKS.map((w, i) => {
                            const pick = PICKED.indexOf(i);
                            return (
                                <div key={w.title} className="relative mk-rise" style={{ ['--d' as string]: `${420 + i * 55}ms` }}>
                                    <div className="neu-card p-[1.3cqw]" style={{ borderRadius: '2.4cqw' }}>
                                        <Swatch paint={w.paint} className="aspect-square" />
                                        <p className="mt-[1.2cqw] font-serif text-[clamp(8px,2.1cqw,13px)] leading-tight text-gray-900 dark:text-gray-100 truncate">{w.title}</p>
                                        <p className="flex items-center justify-between gap-1 mt-[0.4cqw] text-[clamp(7px,1.6cqw,10px)] text-gray-600 dark:text-gray-400">
                                            <span className="truncate">{w.price}</span>
                                            <span className={`w-[1.2cqw] h-[1.2cqw] min-w-[4px] min-h-[4px] rounded-full ${STATUS_DOT[w.status]}`} />
                                        </p>
                                    </div>
                                    {pick >= 0 && (
                                        <span className={`mk-loop mk-pick-${pick + 1} absolute inset-0 pointer-events-none`}
                                            style={{ borderRadius: '2.4cqw', boxShadow: '0 0 0 2px #d4af37' }}>
                                            <span className="absolute -top-[1.4cqw] -right-[1.4cqw] w-[5cqw] h-[5cqw] min-w-[16px] min-h-[16px] rounded-full flex items-center justify-center text-[#241c04]"
                                                style={{ background: 'linear-gradient(145deg, #f0d68a, #d4af37)', boxShadow: '2px 2px 5px var(--neu-shadow-dark)' }}>
                                                <Check className="w-[60%] h-[60%]" strokeWidth={3} />
                                            </span>
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* The catalog that assembles from them */}
                <div className="mk-loop mk-page absolute right-0 bottom-0 w-[54%] p-[3.2cqw] bg-[#fbfaf6] dark:bg-[#2b2e35]"
                    style={{ borderRadius: '3.2cqw', boxShadow: '14px 16px 36px var(--neu-shadow-dark), -8px -8px 22px var(--neu-shadow-light)' }}>
                    <p className="text-[clamp(7px,1.6cqw,10px)] uppercase tracking-[0.18em] text-gold-700 dark:text-gold-300">Catalog</p>
                    <p className="mt-[0.6cqw] font-serif text-[clamp(11px,3.2cqw,19px)] leading-tight text-gray-900 dark:text-gray-100">Spring selection</p>
                    <p className="text-[clamp(7px,1.6cqw,10px)] text-gray-500 dark:text-gray-400">3 works</p>
                    <div className="mt-[2cqw] grid grid-cols-3 gap-[1.6cqw]">
                        {PICKED.map((wi, n) => (
                            <div key={wi} className={`mk-loop mk-thumb-${n + 1}`}>
                                <Swatch paint={WORKS[wi].paint} className="aspect-[4/5]" />
                                <p className="mt-[0.8cqw] font-serif text-[clamp(7px,1.7cqw,11px)] leading-tight text-gray-800 dark:text-gray-200 truncate">{WORKS[wi].title}</p>
                                <p className="text-[clamp(6px,1.4cqw,9px)] text-gray-500 dark:text-gray-400 truncate">{WORKS[wi].medium}</p>
                            </div>
                        ))}
                    </div>
                    <span className="mk-loop mk-chip mt-[2.2cqw] inline-flex items-center gap-[0.8cqw] rounded-full px-[1.8cqw] py-[0.8cqw] text-[clamp(7px,1.6cqw,10px)] font-semibold uppercase tracking-[0.1em] text-[#241c04]"
                        style={{ background: 'linear-gradient(145deg, #f0d68a, #d4af37)' }}>
                        <FileText className="w-[1.2em] h-[1.2em]" /> PDF ready
                    </span>
                </div>
            </div>

            <figcaption className="mt-5 flex items-center justify-between gap-3">
                <Caption>Illustration · sample artworks</Caption>
                {!reduced && (
                    <button type="button" onClick={() => setUserPaused(p => !p)} aria-pressed={userPaused}
                        aria-label={userPaused ? 'Play the animation' : 'Pause the animation'} title={userPaused ? 'Play' : 'Pause'}
                        className="w-8 h-8 shrink-0 rounded-full neu-raised-sm neu-btn flex items-center justify-center text-gray-600 dark:text-gray-300 active-scale">
                        {userPaused ? <Play size={13} /> : <Pause size={13} />}
                    </button>
                )}
            </figcaption>
        </figure>
    );
};

/* ─────────────────────────── Story scenes ────────────────────────────── */

/** Every scene fills the same frame; the last row sits at the bottom, so the four line up. */
const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="neu-card p-5 sm:p-6 h-full flex flex-col">{children}</div>
);

const Chip: React.FC<{ tone?: 'ok' | 'warn' | 'bad' | 'gold' | 'neutral'; children: React.ReactNode }> = ({ tone = 'neutral', children }) => {
    const ink = { ok: 'text-green-700 dark:text-green-400', warn: 'text-amber-700 dark:text-amber-400', bad: 'text-red-700 dark:text-red-400', gold: 'text-gold-700 dark:text-gold-300', neutral: 'text-gray-600 dark:text-gray-400' }[tone];
    return <span className={`neu-status inline-flex px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap ${ink}`}>{children}</span>;
};

const TONE: Record<Work['status'], 'ok' | 'warn' | 'bad'> = { Available: 'ok', Reserved: 'warn', Sold: 'bad' };

/** A row of statuses with the current one marked — the app's own sequence. */
const Progress: React.FC<{ steps: string[]; current: number }> = ({ steps, current }) => (
    <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((s, n) => (
            <li key={s} className="flex flex-col items-center gap-1.5 text-center min-w-0">
                <span className={`w-full h-1.5 rounded-full ${n <= current ? '' : 'neu-inset'}`}
                    style={n <= current ? { background: 'linear-gradient(90deg, #d4af37, #f0d68a)' } : undefined} />
                <span className={`text-[9.5px] uppercase tracking-[0.06em] ${n === current ? 'text-gold-700 dark:text-gold-300 font-semibold' : 'text-gray-500 dark:text-gray-400'}`}>{s}</span>
            </li>
        ))}
    </ol>
);

export const SceneInventory: React.FC = () => (
    <Frame>
        <div className="flex items-center justify-between">
            <p className="font-serif text-xl text-gold-700 dark:text-gold-300">Inventory</p>
            <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">36 works</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
            {['All', 'Available', 'Reserved', 'Sold'].map(f => (
                <span key={f} className={`neu-pill !px-3 !py-1 !text-[11px] pointer-events-none ${f === 'Available' ? 'neu-pill-active' : ''}`}>{f}</span>
            ))}
        </div>
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
            {WORKS.map((w, n) => (
                <div key={w.title} className={`neu-card p-2 !rounded-xl min-w-0 ${n >= 4 ? 'hidden sm:block' : ''}`}>
                    <Swatch paint={w.paint} className="aspect-[16/10]" />
                    <p className="mt-2 font-serif text-[13px] leading-tight text-gray-900 dark:text-gray-100 break-words">{w.title}</p>
                    <p className="mt-0.5 text-[11px] text-gray-600 dark:text-gray-400">{w.price}</p>
                    <div className="mt-1.5"><Chip tone={TONE[w.status]}>{w.status}</Chip></div>
                </div>
            ))}
        </div>
    </Frame>
);

export const SceneCatalog: React.FC = () => (
    <Frame>
        <div className="rounded-2xl p-5 bg-[#fbfaf6] dark:bg-[#2b2e35]" style={{ boxShadow: 'inset 2px 2px 6px var(--neu-shadow-dark), inset -2px -2px 6px var(--neu-shadow-light)' }}>
            <p className="text-[10px] uppercase tracking-[0.18em] text-gold-700 dark:text-gold-300">Catalog</p>
            <p className="mt-1 font-serif text-2xl text-gray-900 dark:text-gray-100">Spring selection</p>
            <p className="text-[12px] text-gray-500 dark:text-gray-400">3 works · prepared for a client</p>
            <div className="mt-4 grid grid-cols-3 gap-3">
                {PICKED.map(n => (
                    <div key={n} className="min-w-0">
                        <Swatch paint={WORKS[n].paint} className="aspect-[4/5]" />
                        <p className="mt-1.5 font-serif text-[12px] leading-tight text-gray-800 dark:text-gray-200 break-words">{WORKS[n].title}</p>
                        <p className="mt-0.5 text-[10px] leading-tight text-gray-500 dark:text-gray-400 break-words">{WORKS[n].medium}</p>
                    </div>
                ))}
            </div>
        </div>
        <div className="mt-auto pt-5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-[11px] text-gray-600 dark:text-gray-400">Print-ready PDF · cut-out photos</span>
            <span className="neu-button neu-button-primary !py-2 !px-4 !text-[12px] pointer-events-none"><FileText size={14} /> Share PDF</span>
        </div>
    </Frame>
);

export const SceneInquiry: React.FC = () => (
    <Frame>
        <div className="flex items-start gap-3">
            <span className="w-11 h-11 rounded-full neu-inset flex items-center justify-center font-serif text-gold-700 dark:text-gold-300 shrink-0">AR</span>
            <div className="min-w-0 flex-1">
                <p className="font-serif text-lg text-gray-900 dark:text-gray-100">Ananya R.</p>
                <p className="text-[12px] text-gray-600 dark:text-gray-400">Interested in <span className="font-medium text-gray-800 dark:text-gray-200">Still Water</span></p>
            </div>
            <Chip tone="gold">Interested</Chip>
        </div>
        <div className="mt-5"><Progress steps={['New', 'Contacted', 'Interested', 'Converted']} current={2} /></div>
        <div className="mt-5 space-y-3">
            {[
                ['Visit booked for Saturday', '2 days ago'],
                ['Sent the Spring selection catalog', '5 days ago'],
                ['First enquiry at the gallery', '1 week ago'],
            ].map(([note, when]) => (
                <div key={note} className="flex items-start gap-3">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gold-500 shrink-0" />
                    <p className="text-[13px] text-gray-800 dark:text-gray-200 flex-1 min-w-0">{note}</p>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">{when}</span>
                </div>
            ))}
        </div>
        <div className="mt-auto pt-5">
            <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Photos from the visit</p>
            <div className="mt-2 grid grid-cols-4 gap-2">
                {[1, 3, 5, 2].map(n => <Swatch key={n} paint={WORKS[n].paint} className="aspect-square" />)}
            </div>
        </div>
    </Frame>
);

export const SceneInvoice: React.FC = () => (
    <Frame>
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">Invoice</p>
                <p className="font-serif text-xl text-gray-900 dark:text-gray-100">INV-0142</p>
                <p className="text-[12px] text-gray-600 dark:text-gray-400">Billed to Ananya R.</p>
            </div>
            <Chip tone="ok">Paid</Chip>
        </div>
        <div className="mt-5"><Progress steps={['Draft', 'Sent', 'Paid']} current={2} /></div>
        <div className="mt-5 space-y-2.5 text-[13px]">
            {[['Still Water · Acrylic', '₹62,000'], ['Framing', '₹4,500']].map(([item, amount]) => (
                <div key={item} className="flex justify-between gap-3 text-gray-800 dark:text-gray-200">
                    <span className="truncate">{item}</span><span className="tabular-nums shrink-0">{amount}</span>
                </div>
            ))}
            <hr className="neu-divider border-0 my-3" />
            <div className="flex justify-between gap-3 font-medium text-gray-900 dark:text-gray-100">
                <span>Total</span><span className="font-serif text-lg tabular-nums">₹66,500</span>
            </div>
        </div>
        <div className="mt-auto pt-5">
            <div className="rounded-xl neu-inset px-4 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-[12px] text-gray-700 dark:text-gray-300">Paid by payment link</span>
                <span className="text-[11px] text-gray-500 dark:text-gray-400">into your own account</span>
            </div>
        </div>
    </Frame>
);

export const SCENES = [SceneInventory, SceneCatalog, SceneInquiry, SceneInvoice];
export { Caption };
