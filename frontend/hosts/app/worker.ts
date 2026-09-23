// app.ateliersupport.com — the organization app.
//
// Only the paths listed in run_worker_first (wrangler.jsonc) reach this code;
// everything else is the app's own files, served straight from dist/app.

import { ADMIN_ORIGIN, SITE_ORIGIN } from '../../brand';
import { type HostEnv, isAdminPath, isApi, redirect, sitePath, toApi } from '../shared';

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (isApi(path)) return toApi(request, env);
    // A client's private viewing room: its own small page, not the app.
    if (path.startsWith('/room/')) return env.ASSETS.fetch(new Request(new URL('/room', url), request));
    // Old links from when every page was served on every address.
    if (isAdminPath(path)) return redirect(ADMIN_ORIGIN, url, '/');
    const site = sitePath(path);
    if (site) return redirect(SITE_ORIGIN, url, site);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<HostEnv>;
