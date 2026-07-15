// ── Web Push for Cloudflare Workers ─────────────────────────────────────────
// Implements RFC 8292 (VAPID) and RFC 8291 (aes128gcm payload encryption)
// using only WebCrypto, so no Node-only libraries are required.
//
// VAPID keys are generated once and persisted in KV under `push:vapid`.

export interface StoredPushSubscription {
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}

export interface VapidKeys {
  /** Raw uncompressed P-256 public key, base64url — used by the browser as applicationServerKey and in the `k=` VAPID param. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

// ── base64url helpers ────────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return new Uint8Array(atob(s).split('').map(c => c.charCodeAt(0)));
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ── VAPID key management ─────────────────────────────────────────────────────

const VAPID_KV_KEY = 'push:vapid';

export async function getOrCreateVapidKeys(kv: KVNamespace): Promise<VapidKeys> {
  const raw = await kv.get(VAPID_KV_KEY);
  if (raw) return JSON.parse(raw);
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  ) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const keys: VapidKeys = { publicKey: b64urlEncode(rawPub), privateJwk };
  await kv.put(VAPID_KV_KEY, JSON.stringify(keys));
  return keys;
}

// ── VAPID authorization header (RFC 8292) ───────────────────────────────────

async function vapidAuthHeader(endpoint: string, vapid: VapidKeys, subject: string): Promise<string> {
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  // WebCrypto ECDSA emits the raw r||s form that JWS ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput)
  ));
  return `vapid t=${signingInput}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

// ── Payload encryption (RFC 8291 / RFC 8188 aes128gcm) ──────────────────────

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, byteLength: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, byteLength * 8
  ));
}

async function encryptPayload(payload: string, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const uaPublic = b64urlDecode(p256dhB64);   // subscriber public key (65-byte uncompressed point)
  const authSecret = b64urlDecode(authB64);   // subscriber auth secret (16 bytes)

  // Ephemeral sender ECDH keypair; its public key travels in the header.
  const asKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  ) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  // workers-types spell the ECDH param `$public`, but the runtime expects `public`.
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKeys.privateKey, 256
  ));

  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single (final) record: payload || 0x02 delimiter.
  const plaintext = concatBytes(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, plaintext
  ));

  // aes128gcm body header: salt(16) | record size(4, BE) | keyid length(1) | keyid(65)
  const headerBytes = new Uint8Array(16 + 4 + 1 + asPublic.length);
  headerBytes.set(salt, 0);
  new DataView(headerBytes.buffer).setUint32(16, 4096);
  headerBytes[20] = asPublic.length;
  headerBytes.set(asPublic, 21);
  return concatBytes(headerBytes, ciphertext);
}

// ── Send ─────────────────────────────────────────────────────────────────────

/**
 * Sends an encrypted push message to a single subscription.
 * Returns the push service's HTTP status (404/410 mean the subscription is gone).
 */
export async function sendWebPush(
  sub: StoredPushSubscription,
  payload: string,
  vapid: VapidKeys,
  subject: string,
): Promise<number> {
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const authorization = await vapidAuthHeader(sub.endpoint, vapid, subject);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high',
    },
    body,
  });
  // Drain the body so the connection can be reused.
  await res.arrayBuffer().catch(() => { });
  return res.status;
}
