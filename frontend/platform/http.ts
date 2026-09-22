// Response helpers shared by the platform route modules. Platform responses
// are never cacheable unless a route opts in, and errors carry a short code
// and a plain message, never internal details.

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };

export function reply(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}

export function fail(status: number, code: string, message: string): Response {
  return reply({ error: message, code }, status);
}

/** A JSON object body, or an empty object for anything else. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const b = await request.json().catch(() => null);
  return (b && typeof b === 'object' && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
}
