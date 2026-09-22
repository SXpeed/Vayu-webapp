// Encryption for third-party credentials stored in the platform database
// (organizations' own Razorpay keys).
//
// AES-256-GCM with a key from PAYMENT_SECRETS_KEY (32 random bytes, base64,
// a Worker secret — never the auth secret). The associated data binds each
// ciphertext to "<org>|<provider>|<field>": copying a ciphertext into another
// organization's row makes it fail to decrypt instead of leaking the secret.
//
// Format: "v1.<iv b64>.<ciphertext b64>". Plaintext secrets are never
// returned by any API; only masked hints are.

import type { Env } from '../workerEnv';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCodePoint(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.codePointAt(0) ?? 0);
}

export class SecretsUnavailable extends Error {}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) throw new SecretsUnavailable('PAYMENT_SECRETS_KEY is not set');
  let bytes: Uint8Array;
  try { bytes = unb64(raw.trim()); } catch { throw new SecretsUnavailable('PAYMENT_SECRETS_KEY is not valid base64'); }
  if (bytes.length !== 32) throw new SecretsUnavailable('PAYMENT_SECRETS_KEY must be 32 bytes');
  let key = keyCache.get(raw);
  if (!key) {
    key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, key);
  }
  return key;
}

export function secretsConfigured(env: Env): boolean {
  try { importKey(env.PAYMENT_SECRETS_KEY); return true; } catch { return false; }
}

export async function encryptSecret(env: Env, context: string, plaintext: string): Promise<string> {
  const key = await importKey(env.PAYMENT_SECRETS_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
    key, new TextEncoder().encode(plaintext),
  ));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

export async function decryptSecret(env: Env, context: string, envelope: string): Promise<string> {
  const [version, ivB64, ctB64] = envelope.split('.');
  if (version !== 'v1' || !ivB64 || !ctB64) throw new Error('unknown secret format');
  const key = await importKey(env.PAYMENT_SECRETS_KEY);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64), additionalData: new TextEncoder().encode(context) },
    key, unb64(ctB64),
  );
  return new TextDecoder().decode(pt);
}

/** "rzp_live_…WXYZ" style hint for showing which key is connected. */
export function maskKeyId(keyId: string): string {
  if (keyId.length <= 12) return `${keyId.slice(0, 4)}…`;
  return `${keyId.slice(0, 9)}…${keyId.slice(-4)}`;
}
