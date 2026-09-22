// Short-lived, single-use connection tickets for the realtime WebSocket.
//
// Browser WebSocket handshakes cannot carry an Authorization header, and a
// long-lived bearer token must never travel in a URL. Instead the client
// fetches a ticket from the authenticated POST /api/realtime/ticket endpoint
// and presents it once, when the socket opens. The ticket is:
//   - signed with an HMAC key shared by the Worker and the hub Durable Object,
//   - expired after TICKET_TTL_MS,
//   - bound to one user and one server-resolved workspace,
//   - single-use: the hub remembers the jti of every ticket it accepted.

export const TICKET_TTL_MS = 60_000;

export interface RealtimeTicketPayload {
  /** Unique ticket id — the hub marks it consumed on first use. */
  jti: string;
  uid: string;
  wid: string;
  /** Role at issuance; the session is re-checked when the ticket is issued. */
  role: string;
  /** Display name, signed so typing broadcasts can't be spoofed. */
  name: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCodePoint(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function signTicket(
  payload: RealtimeTicketPayload, key: CryptoKey,
): Promise<string> {
  const body = bytesToB64Url(encoder.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `v1.${body}.${bytesToB64Url(mac)}`;
}

export type TicketCheck =
  | { ok: true; payload: RealtimeTicketPayload }
  | { ok: false; reason: 'format' | 'signature' | 'expired' | 'json' };

export async function verifyTicket(
  ticket: string, key: CryptoKey, now = Date.now(),
): Promise<TicketCheck> {
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'format' };
  }
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', key, b64UrlToBytes(parts[2]), encoder.encode(parts[1]),
    );
    if (!valid) return { ok: false, reason: 'signature' };
    const payload = JSON.parse(new TextDecoder().decode(b64UrlToBytes(parts[1]))) as RealtimeTicketPayload;
    if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, reason: 'expired' };
    if (!payload.jti || !payload.uid || !payload.wid) return { ok: false, reason: 'json' };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: 'signature' };
  }
}

/** The lease a validated ticket grants before the client must re-auth. */
export const CONNECTION_LEASE_MS = 10 * 60_000;
