// The backdrop product photos sit on in tiles and thumbnails, chosen in
// Profile → App Settings. Like the UI size and theme it belongs to this
// device: it is saved in the browser and applied before first paint
// (index.html) as <html data-tile-bg="…">, which index.css turns into the
// --tile-bg the .tile-backdrop class paints. Showcase sections keep the
// backdrop their curator chose.

export type TileBackdrop = 'blue' | 'light' | 'dark' | 'offwhite' | 'sage' | 'clay';

export const TILE_BACKDROPS: { value: TileBackdrop; label: string }[] = [
    { value: 'blue', label: 'Blue' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'offwhite', label: 'Off-white' },
    { value: 'sage', label: 'Sage' },
    { value: 'clay', label: 'Clay' },
];

const KEY = 'vayu_tile_bg';
const DEFAULT: TileBackdrop = 'blue';

export function getTileBackdrop(): TileBackdrop {
    try {
        const saved = localStorage.getItem(KEY);
        return TILE_BACKDROPS.some(o => o.value === saved) ? saved as TileBackdrop : DEFAULT;
    } catch {
        return DEFAULT;
    }
}

export function setTileBackdrop(value: TileBackdrop): void {
    try { localStorage.setItem(KEY, value); } catch { /* private mode: applies to this visit only */ }
    document.documentElement.dataset.tileBg = value;
}
