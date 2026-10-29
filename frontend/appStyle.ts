// App style, chosen in Profile → App Settings: Classic (the soft-UI look) or
// Atelier (flat warm surfaces, blur-in motion, page transitions). Like the UI
// size and theme it belongs to this device: saved in the browser and applied
// before first paint (index.html) as <html data-skin="…">, which
// theme-atelier.css keys on. Layout is the same in both.

import { flushSync } from 'react-dom';

export type AppStyle = 'classic' | 'atelier' | 'lite';

export const APP_STYLES: { value: AppStyle; label: string }[] = [
    { value: 'classic', label: 'Classic' },
    { value: 'atelier', label: 'Atelier' },
    { value: 'lite', label: 'Lite' },
];

const KEY = 'vayu_app_style';
const OLED_KEY = 'vayu_oled';

export function getAppStyle(): AppStyle {
    try {
        const saved = localStorage.getItem(KEY);
        return saved === 'atelier' || saved === 'lite' ? saved : 'classic';
    } catch {
        return 'classic';
    }
}

/** Pure black in dark mode (theme-lite.css), for OLED screens. This device only. */
export function getOled(): boolean {
    try { return localStorage.getItem(OLED_KEY) === 'on'; } catch { return false; }
}

export function setOled(on: boolean): void {
    try { localStorage.setItem(OLED_KEY, on ? 'on' : 'off'); } catch { /* private mode: applies to this visit only */ }
    document.documentElement.dataset.oled = on ? 'on' : 'off';
    syncThemeColor();
}

export function setAppStyle(value: AppStyle): void {
    try { localStorage.setItem(KEY, value); } catch { /* private mode: applies to this visit only */ }
    document.documentElement.dataset.skin = value;
    syncThemeColor();
}

/** The browser bar colour: the page colour of the current style and light/dark mode. */
const PAGE_COLOUR = {
    classic: { light: '#e9edf4', dark: '#22252b' },
    atelier: { light: '#ecebe6', dark: '#0e0e0f' },
    lite: { light: '#f2f2f4', dark: '#141416' },
};

export function syncThemeColor(): void {
    const html = document.documentElement;
    const style = html.dataset.skin === 'atelier' || html.dataset.skin === 'lite' ? html.dataset.skin : 'classic';
    const mode = html.classList.contains('dark') ? 'dark' : 'light';
    const colour = mode === 'dark' && html.dataset.oled === 'on' ? '#000000' : PAGE_COLOUR[style][mode];
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colour);
}

/** True when the Atelier motion should run: that style, and the person hasn't asked for less motion. */
export function atelierMotion(): boolean {
    return document.documentElement.dataset.skin === 'atelier'
        && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const canTransition = (): boolean => atelierMotion() && typeof document.startViewTransition === 'function';

/**
 * Runs a screen change inside a view transition when Atelier motion is on
 * (the old screen blurs out, the new one in); otherwise just runs it.
 */
export function withViewTransition(update: () => void): void {
    if (!canTransition()) { update(); return; }
    document.startViewTransition(() => flushSync(update));
}

/**
 * Like withViewTransition, with one element morphing between the screens:
 * `from` (on the old screen) grows into whatever carries
 * view-transition-name: at-art on the new one, or, going back, `to` (on the
 * new screen) is what the named element shrinks into.
 */
export function withSharedElement(update: () => void, ends: { from?: HTMLElement | null; to?: HTMLElement | null }): void {
    if (!canTransition()) { update(); return; }
    const { from, to } = ends;
    if (from) from.style.viewTransitionName = 'at-art';
    const t = document.startViewTransition(() => {
        if (from) from.style.viewTransitionName = '';
        flushSync(update);
        if (to) to.style.viewTransitionName = 'at-art';
    });
    const clear = () => {
        if (from) from.style.viewTransitionName = '';
        if (to) to.style.viewTransitionName = '';
    };
    void t.finished.then(clear, clear);
}

/** The tile picture of this artwork on the current screen, if one is showing. */
export const artworkThumb = (id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-art-thumb="${CSS.escape(id)}"]`);
