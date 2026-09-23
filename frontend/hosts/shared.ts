// Shared by the three site Workers (app, admin, welcome). Each serves its own
// pages from its own build (dist/<site>) and hands /api to the API Worker
// (vayu-webapp) over a service binding. See docs/HOSTING.md.

export interface HostEnv {
  /** This site's own build output. */
  ASSETS: Fetcher;
  /** The API Worker. */
  API: Fetcher;
}

export const isApi = (path: string): boolean => path === '/api' || path.startsWith('/api/');

/**
 * Hands the request to the API Worker exactly as it arrived: same URL, cookies,
 * headers (including cf-connecting-ip, which rate limits and the audit log
 * use) and WebSocket upgrade. The API sees which address it came from, so
 * sign-in origins and the control-centre host check work unchanged, and file
 * links saved as /api/files/... keep working on every address.
 */
export const toApi = (request: Request, env: HostEnv): Promise<Response> => env.API.fetch(request);

export const notFound = (): Response =>
  new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Sends the browser to `path` (default: the same path) on another address, keeping the query. */
export const redirect = (origin: string, url: URL, path = url.pathname, status = 302): Response =>
  Response.redirect(origin + path + url.search, status);

export const isAdminPath = (path: string): boolean =>
  path === '/admin' || path === '/admin.html' || path.startsWith('/admin/');

/** The public website's pages, and where each lives on ateliersupport.com. */
export function sitePath(path: string): string | null {
  switch (path) {
    case '/welcome': case '/welcome.html': return '/';
    case '/signup': case '/signup.html': return '/signup';
    case '/legal': case '/legal.html': return '/legal';
    default: return null;
  }
}
