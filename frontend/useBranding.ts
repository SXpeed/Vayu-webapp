// The platform's name and logo, as set in the control panel.
//
// The built-in values in brand.ts are the fallback, so the app still renders
// correctly before the platform layer exists (or if the lookup fails). Until
// the first answer arrives `loaded` is false, so a page can hold the logo's
// place instead of flashing a built-in mark. The last answer is remembered in
// this browser, so a return visit shows the real logo straight away.

import { useEffect, useState } from 'react';
import { APP_NAME } from './brand';

export interface PublicBranding {
  appName: string;
  tagline: string;
  accentColor: string | null;
  logoUrl: string | null;
  /** False until the platform has answered (or a remembered answer was found). */
  loaded: boolean;
}

export const FALLBACK_BRANDING: PublicBranding = {
  appName: APP_NAME,
  tagline: '',
  accentColor: null,
  logoUrl: null,
  loaded: false,
};

const STORAGE_KEY = 'ac.branding';

/** The answer this browser saw last time, or null. */
function remembered(): PublicBranding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<PublicBranding>;
    if (typeof data.appName !== 'string') return null;
    return { ...FALLBACK_BRANDING, ...data, loaded: true };
  } catch {
    return null;
  }
}

function remember(b: PublicBranding): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ appName: b.appName, tagline: b.tagline, accentColor: b.accentColor, logoUrl: b.logoUrl }));
  } catch { /* storage blocked: the next visit just asks again */ }
}

let cache: PublicBranding | null = null;
let fresh = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<(b: PublicBranding) => void>();

/**
 * Pages whose tab icon follows the platform logo mark it `data-brand-icon`
 * (the website and the control centre; the installed app keeps its own
 * icons). Without a logo, the built-in icon.
 */
function applyBrandIcon(logoUrl: string | null): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-brand-icon]')) {
    const next = logoUrl ?? '/icon.png';
    if (link.getAttribute('href') !== next) link.href = next;
  }
}

/** Asks the platform again and updates every page part using the branding. */
export function refreshBranding(): Promise<void> {
  inflight ??= fetch('/api/v2/public/branding', { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .then((data: Omit<PublicBranding, 'loaded'> | null) => {
      if (!data || typeof data.appName !== 'string') return;
      cache = { ...FALLBACK_BRANDING, ...data, loaded: true };
      fresh = true;
      remember(cache);
      applyBrandIcon(cache.logoUrl);
      for (const notify of listeners) notify(cache);
    })
    .catch(() => { /* keep what we have */ })
    .finally(() => { inflight = null; });
  return inflight;
}

export function useBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>(() => {
    cache ??= remembered();
    return cache ?? FALLBACK_BRANDING;
  });

  useEffect(() => {
    listeners.add(setBranding);
    // The remembered answer is shown at once, then checked once per page load.
    if (!fresh) {
      void refreshBranding().then(() => {
        // The lookup failed: stop holding the logo's place.
        if (!cache) setBranding(b => (b.loaded ? b : { ...b, loaded: true }));
      });
    }
    return () => { listeners.delete(setBranding); };
  }, []);

  return branding;
}
