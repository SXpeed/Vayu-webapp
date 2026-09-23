// Motion for the public website.
//
// One place for the timings, a reduced-motion hook that follows the setting
// live, scroll reveals that run once per visit, and smooth scrolling for the
// welcome page only (Lenis, already a dependency of the app). Nothing here
// talks to the server, and nothing updates React state on scroll frames.

import { useEffect, useLayoutEffect, useState } from 'react';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

/** The CSS side lives in site.css as --mk-* custom properties. */
export const MOTION = {
    /** Smooth-scroll glide for wheel and anchors, in seconds. */
    scrollDuration: 1.05,
    /** Parallax strength for decorative artwork (fraction of scroll). */
    parallax: 0.12,
} as const;

const REDUCE = '(prefers-reduced-motion: reduce)';

/** True when the visitor asked for less motion; updates if they change it. */
export function useReducedMotion(): boolean {
    const [reduced, setReduced] = useState(() => globalThis.matchMedia?.(REDUCE).matches ?? false);
    useEffect(() => {
        const mq = globalThis.matchMedia?.(REDUCE);
        if (!mq) return;
        const on = () => setReduced(mq.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, []);
    return reduced;
}

/* ───────────────────────────── Reveals ───────────────────────────────── */

/**
 * Reveals every [data-reveal] element inside `root` the first time it
 * enters the viewport. The root is only marked ready (which is what hides
 * elements beforehand) once the observer exists, so if this never runs the
 * page simply shows everything. New elements (plans arriving later) are
 * picked up by a MutationObserver. The reveal is recorded as a data
 * attribute set on the element, so React re-renders never undo it.
 */
export function useReveals(root: React.RefObject<HTMLElement | null>) {
    useLayoutEffect(() => {
        const el = root.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;

        const io = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                (e.target as HTMLElement).dataset.revealIn = '';
                io.unobserve(e.target);
            }
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

        const watch = (scope: ParentNode) => {
            scope.querySelectorAll<HTMLElement>('[data-reveal]:not([data-reveal-in])').forEach(n => io.observe(n));
        };
        watch(el);
        const mo = new MutationObserver(records => {
            for (const r of records) {
                r.addedNodes.forEach(n => {
                    if (!(n instanceof HTMLElement)) return;
                    if (n.matches('[data-reveal]')) io.observe(n);
                    watch(n); // and anything to reveal inside it
                });
            }
        });
        mo.observe(el, { childList: true, subtree: true });
        el.classList.add('mk-reveal-ready');

        return () => { io.disconnect(); mo.disconnect(); el.classList.remove('mk-reveal-ready'); };
    }, [root]);
}

/**
 * Marks elements matching `selector` with data-reached the first time
 * they cross the given point of the screen — for the "How it works" steps.
 */
export function useReached(root: React.RefObject<HTMLElement | null>, selector: string, rootMargin = '0px 0px -30% 0px') {
    useEffect(() => {
        const el = root.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            el?.querySelectorAll<HTMLElement>(selector).forEach(n => { n.dataset.reached = ''; });
            return;
        }
        const io = new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) { (e.target as HTMLElement).dataset.reached = ''; io.unobserve(e.target); }
        }, { rootMargin, threshold: 0.5 });
        el.querySelectorAll(selector).forEach(n => io.observe(n));
        return () => io.disconnect();
    }, [root, selector, rootMargin]);
}

/**
 * Which of the given sections is being read: the last one whose top has
 * passed a line `line` of the way down the screen (and the last of all once
 * the page is scrolled to the end). Worked out when an observer fires — a
 * handful of times per section — never per scroll frame, and state changes
 * only when the answer does.
 */
export function useActiveId(ids: string[], line = 0.4): string | null {
    const [active, setActive] = useState<string | null>(null);
    const key = ids.join('|');
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return;
        const els = key.split('|').map(id => document.getElementById(id)).filter((n): n is HTMLElement => !!n);
        if (!els.length) return;
        const pick = () => {
            const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
            const limit = atEnd ? window.innerHeight : window.innerHeight * line;
            let current: string | null = null;
            for (const el of els) if (el.getBoundingClientRect().top <= limit) current = el.id;
            setActive(prev => (prev === current ? prev : current));
        };
        // A thin band at the reading line fires exactly when a section's top
        // crosses it; the second observer catches the end of the page.
        const pct = Math.round(line * 100);
        const band = new IntersectionObserver(pick, { rootMargin: `-${pct}% 0px -${99 - pct}% 0px` });
        const edges = new IntersectionObserver(pick, { threshold: [0, 1] });
        els.forEach(n => { band.observe(n); edges.observe(n); });
        // A marker at the very end of the page: reaching it selects the last section.
        const end = document.createElement('div');
        end.setAttribute('aria-hidden', 'true');
        end.style.cssText = 'height:1px;margin-top:-1px;pointer-events:none';
        document.body.appendChild(end);
        edges.observe(end);
        return () => { band.disconnect(); edges.disconnect(); end.remove(); };
    }, [key, line]);
    return active;
}

/* ───────────────────────────── Smooth scroll ─────────────────────────── */

/** Same-page hash links: "#pricing" or "/welcome#pricing" while on /welcome. */
function samePageHash(a: HTMLAnchorElement): string | null {
    if (!a.hash || a.target && a.target !== '_self' || a.hasAttribute('download')) return null;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) return null;
    return url.hash;
}

function targetFor(hash: string): HTMLElement | null {
    if (!hash || hash === '#') return null;
    try { return document.getElementById(decodeURIComponent(hash.slice(1))); } catch { return null; }
}

/** Anchor targets take focus without jumping, so keyboard users continue from there. */
function focusTarget(el: HTMLElement) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
}

/**
 * Smooth scrolling for the welcome page (the document scrolls here; the app
 * keeps its own scroller and is not touched). Wheel scrolling glides; touch
 * stays native. Same-page links glide to their section, stop below the
 * header, update the address (so Back works) and move focus. Turns itself
 * off — and falls back to plain browser behaviour — for reduced motion.
 * Decorative [data-parallax] elements drift a little with the scroll on
 * pointer devices.
 */
export function useMarketingScroll(enabled: boolean) {
    // Content arrives after the browser's own jump to #hash, so make it again
    // — once, on arrival, whatever the motion setting.
    useEffect(() => {
        const initial = targetFor(location.hash);
        if (initial) requestAnimationFrame(() => initial.scrollIntoView({ block: 'start' }));
    }, []);

    useEffect(() => {
        if (!enabled) return;

        const lenis = new Lenis({
            autoRaf: true, // Lenis runs one requestAnimationFrame loop and stops it on destroy.
            duration: MOTION.scrollDuration,
            smoothWheel: true,
            syncTouch: false,
        });

        const onClick = (e: MouseEvent) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = (e.target as Element | null)?.closest?.('a');
            if (!(a instanceof HTMLAnchorElement)) return;
            const hash = samePageHash(a);
            if (!hash) return;
            const el = targetFor(hash);
            if (!el) return;
            e.preventDefault();
            if (location.hash !== hash) history.pushState(null, '', hash);
            lenis.scrollTo(el, { onComplete: () => focusTarget(el) }); // lands at the element's scroll-margin
        };
        // Back and Forward between sections glide as well.
        const onPop = () => {
            const el = targetFor(location.hash);
            if (el) lenis.scrollTo(el);
            else lenis.scrollTo(0);
        };
        document.addEventListener('click', onClick);
        window.addEventListener('popstate', onPop);

        // Parallax: written straight to the element's style, never to React state.
        const drifters = globalThis.matchMedia('(pointer: fine)').matches
            ? Array.from(document.querySelectorAll<HTMLElement>('[data-parallax]'))
            : [];
        const unsubscribe = drifters.length
            ? lenis.on('scroll', (l: Lenis) => {
                const y = Math.min(l.scroll, 900) * MOTION.parallax;
                for (const d of drifters) d.style.setProperty('--mk-parallax', `${y.toFixed(1)}px`);
            })
            : undefined;

        return () => {
            unsubscribe?.();
            document.removeEventListener('click', onClick);
            window.removeEventListener('popstate', onPop);
            drifters.forEach(d => d.style.removeProperty('--mk-parallax'));
            lenis.destroy();
        };
    }, [enabled]);
}
