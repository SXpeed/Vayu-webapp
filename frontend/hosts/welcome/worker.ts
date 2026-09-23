// ateliersupport.com (and www) — the public website: landing page at the
// root, /signup, /legal.
//
// This address used to be the app's, so anything that is not a website page
// is sent on to app.ateliersupport.com: old bookmarks, deep links and
// home-screen installs. Every request runs through here (run_worker_first).

import { ADMIN_ORIGIN, APP_ORIGIN, SITE_ORIGIN } from '../../brand';
import { type HostEnv, isAdminPath, isApi, redirect, toApi } from '../shared';

const SITE_HOST = new URL(SITE_ORIGIN).host;

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // One address for the website, so sign-in cookies live in one place.
    if (url.host !== SITE_HOST) return redirect(SITE_ORIGIN, url, path, 301);
    // /api/v2/* is the website's own (sign-up, plans, branding). The app's
    // original /api stays reachable here for now so a copy of the app still
    // open on this address can finish saving; see docs/PENDING.md.
    if (isApi(path)) return toApi(request, env);
    if (path === '/welcome' || path === '/welcome.html') return redirect(SITE_ORIGIN, url, '/', 301);
    if (isAdminPath(path)) return redirect(ADMIN_ORIGIN, url, '/');

    const page = await env.ASSETS.fetch(request);
    if (page.status !== 404) return page;
    // Not a website page: an old app address. Browsers opening a page go to
    // the app; anything else is a plain 404.
    if (request.headers.get('Sec-Fetch-Mode') === 'navigate') return redirect(APP_ORIGIN, url);
    return page;
  },
} satisfies ExportedHandler<HostEnv>;
