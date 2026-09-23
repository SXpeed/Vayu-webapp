// admin.ateliersupport.com — the provider control centre, at the root.
//
// Only the paths listed in run_worker_first (wrangler.jsonc) reach this code;
// everything else is the control centre's own files, served from dist/admin.

import { type HostEnv, isAdminPath, isApi, notFound, redirect, toApi } from '../shared';

export default {
  async fetch(request: Request, env: HostEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // The platform API only (sign-in, /admin/*, public branding). The app's
    // own API is not reachable from this address.
    if (isApi(path)) return path.startsWith('/api/v2/') ? toApi(request, env) : notFound();
    // The panel used to live at /admin; the #section part of an old bookmark
    // survives the redirect.
    if (isAdminPath(path)) return redirect(url.origin, url, '/');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<HostEnv>;
