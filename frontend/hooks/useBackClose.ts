// Phone Back closes the open overlay (sheet, dialog, viewer) instead of
// leaving the screen and dropping whatever was typed into it.
//
// Opening an overlay adds a Back step ({ ...state, overlay: depth }); closing
// it any other way takes that step back off. A step whose overlay is gone
// (the screen was left with it open) is reused by the next overlay, so Back
// never lands on a step that does nothing. Screen state (view, modal) is
// copied into the step, so the screens' own Back handling sees no change.
//
// Steps are only ever added right after a tap. Chrome (and Android's Back)
// skips a history step when the page adds another without a tap, to stop
// pages trapping people, so a step added from code alone would make the next
// Back jump past a screen, or out of the app.

import { useEffect, useRef } from 'react';

/** Overlay depths that an open overlay currently owns. */
const owned = new Set<number>();

// Back onto a step whose overlay is gone (it navigated to another screen while
// open, e.g. a tapped notification): skip it, or that Back press does nothing.
globalThis.addEventListener?.('popstate', (e: PopStateEvent) => {
    const d: number = e.state?.overlay ?? 0;
    if (d && !owned.has(d)) globalThis.history.back();
});

/** Take a Back step for a newly opened overlay; returns its depth, or 0 for none. */
export function takeStep(h: History): number {
    const top: number = h.state?.overlay ?? 0;
    if (top && !owned.has(top)) {
        owned.add(top); // a stale step: reuse it rather than stack another
        return top;
    }
    // Opened by code, not a tap: no step yet (see above); useBackClose waits for the next tap.
    if (globalThis.navigator?.userActivation?.isActive === false) return 0;
    owned.add(top + 1);
    h.pushState({ ...h.state, overlay: top + 1 }, '');
    return top + 1;
}

const TAPS = ['pointerup', 'keydown'];

/** No step yet (opened by code): take it on the next tap or key press, which lets a step be added. Returns a cancel. */
export function stepOnNextTap(h: History, got: (depth: number) => void): () => void {
    const stop = () => { for (const t of TAPS) globalThis.removeEventListener(t, onTap, true); };
    const onTap = () => {
        const d = takeStep(h);
        if (!d) return;
        stop();
        got(d);
    };
    for (const t of TAPS) globalThis.addEventListener(t, onTap, true);
    return stop;
}

/** The overlay at `depth` closed by itself: take its step back off, if it's still on top and no one took it over. */
export function releaseStep(h: History, depth: number): void {
    if (owned.has(depth)) return;
    if (h.state?.overlay === depth) h.back();
}

export function useBackClose(open: boolean, close: () => void): void {
    const latest = useRef(close);
    latest.current = close;
    const depth = useRef(0);

    useEffect(() => {
        if (!open) return;
        const h = globalThis.history;
        if (depth.current) owned.add(depth.current); // React's dev double-run: keep the same step
        else depth.current = takeStep(h);
        let mine = depth.current;
        let active = true;
        const stopWaiting = mine ? undefined : stepOnNextTap(h, d => { depth.current = mine = d; });
        const onPop = (e: PopStateEvent) => {
            if ((e.state?.overlay ?? 0) >= mine) return;
            depth.current = 0;
            latest.current();
            // A close that asks first ("Discard your changes?") and is refused leaves the
            // overlay open: step forward onto its step again (it is still there; adding
            // a new one without a tap would make Chrome skip a step, see above).
            setTimeout(() => {
                if (!active) return;
                depth.current = mine;
                h.forward();
            });
        };
        globalThis.addEventListener('popstate', onPop);
        return () => {
            active = false;
            stopWaiting?.();
            globalThis.removeEventListener('popstate', onPop);
            owned.delete(mine);
            // Deferred, so an overlay opening in the same moment can take the step over
            // (and a dev double-run re-owns it) before it is removed.
            setTimeout(() => {
                if (depth.current === mine && owned.has(mine)) return;
                if (depth.current === mine) depth.current = 0;
                releaseStep(h, mine);
            });
        };
    }, [open]);
}
