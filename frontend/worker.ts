// worker.ts - Cloudflare Worker handling API routes with KV and R2

// Bindings are defined in wrangler.json as VAYU_KV (KV) and VAYU_R2 (R2 bucket)

interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
}

// Utility to parse JSON body
async function parseJson(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return request.json();
  }
  return null;
}

// Helper to respond with JSON
function jsonResponse(data: any, init?: ResponseInit) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' }, ...init });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    const path = pathname.replace(/^\/api/, '');
    try {
      if (path === '/users' && method === 'POST') {
        const user = await parseJson(request);
        if (!user) return new Response('Invalid JSON', { status: 400 });
        const key = `user:${user.phone}`;
        await env.VAYU_KV.put(key, JSON.stringify(user));
        return jsonResponse({ success: true });
      }
      if (path.startsWith('/users/') && method === 'GET') {
        const phone = decodeURIComponent(path.split('/')[2]);
        const value = await env.VAYU_KV.get(`user:${phone}`);
        return value ? jsonResponse(JSON.parse(value)) : new Response('Not found', { status: 404 });
      }
      // Additional handlers for other entities omitted for brevity
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response('Server error: ' + (err as any).message, { status: 500 });
    }
  },
};
