// UI size: Small shows the app at 90%, Default at 95%, Large at 100%. Kept per device,
// like the theme. index.html applies the saved choice before first paint by
// setting --ui-zoom on <html>; index.css zooms <body> by it.

export type UiSize = 'small' | 'default' | 'large';

const KEY = 'vayu_ui_size';
export const UI_ZOOM: Record<UiSize, number> = { small: 0.9, default: 0.95, large: 1 };

export function getUiSize(): UiSize {
    try {
        const saved = localStorage.getItem(KEY);
        return saved && Object.hasOwn(UI_ZOOM, saved) ? saved as UiSize : 'default';
    } catch { return 'default'; }
}

export function setUiSize(size: UiSize) {
    try { localStorage.setItem(KEY, size); } catch { /* private mode: applies to this visit only */ }
    document.documentElement.style.setProperty('--ui-zoom', String(UI_ZOOM[size]));
}

/**
 * Converts a getBoundingClientRect() coordinate into CSS px inside the zoomed
 * body, for positioning with style.top/left. Chromium and Firefox report rects
 * already scaled by the zoom; Safari reports them unscaled. Measuring the
 * body tells the two apart.
 */
export function toBodyPx(value: number): number {
    const b = document.body;
    const scale = b.offsetHeight ? b.getBoundingClientRect().height / b.offsetHeight : 1;
    return scale > 0 ? value / scale : value;
}
