// The platform's name and logo, as set in the control panel.
//
// The built-in values in brand.ts are the fallback, so the app still renders
// correctly before the platform layer exists (or if the lookup fails).

import { useEffect, useState } from 'react';
import { APP_NAME } from './brand';

export interface PublicBranding {
  appName: string;
  tagline: string;
  accentColor: string | null;
  logoUrl: string | null;
}

export const FALLBACK_BRANDING: PublicBranding = {
  appName: APP_NAME,
  tagline: '',
  accentColor: null,
  logoUrl: null,
};

let cache: PublicBranding | null = null;

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

export function useBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>(cache ?? FALLBACK_BRANDING);

  useEffect(() => {
    if (cache) return;
    let cancelled = false;
    fetch('/api/v2/public/branding')
      .then(res => (res.ok ? res.json() : null))
      .then((data: PublicBranding | null) => {
        if (!data || cancelled || typeof data.appName !== 'string') return;
        cache = { ...FALLBACK_BRANDING, ...data };
        setBranding(cache);
        applyBrandIcon(cache.logoUrl);
      })
      .catch(() => { /* keep the built-in name */ });
    return () => { cancelled = true; };
  }, []);

  return branding;
}
