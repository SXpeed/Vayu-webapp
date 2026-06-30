interface Env {
  VAYU_KV: KVNamespace;
  VAYU_R2: R2Bucket;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method;

    try {
      // POST /api/users — create or update a user (keyed by phone)
      if (path === '/users' && method === 'POST') {
        const body = await request.json().catch(() => null) as { phone?: string } | null;
        if (!body || !body.phone) {
          return jsonResponse({ error: 'Missing required field: phone' }, { status: 400 });
        }
        await env.VAYU_KV.put(`user:${body.phone}`, JSON.stringify(body));
        return jsonResponse({ success: true });
      }

      // GET /api/users/:phone — fetch a user by phone
      if (path.startsWith('/users/') && method === 'GET') {
        const phone = decodeURIComponent(path.slice('/users/'.length));
        if (!phone) return jsonResponse({ error: 'Missing phone' }, { status: 400 });
        const value = await env.VAYU_KV.get(`user:${phone}`);
        return value
          ? jsonResponse(JSON.parse(value))
          : jsonResponse({ error: 'Not found' }, { status: 404 });
      }

      return jsonResponse({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      return jsonResponse({ error: (err as Error).message }, { status: 500 });
    }
  },
};
