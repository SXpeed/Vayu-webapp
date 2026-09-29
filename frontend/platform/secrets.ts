// Encryption for third-party credentials stored in the platform database
// (organizations' own Razorpay keys, the platform's plan-payments keys).
//
// AES-256-GCM, a fresh random 96-bit nonce per value, and associated data
// that binds each ciphertext to its purpose: "<org>|<provider>|<field>" (or
// "platform|razorpay-billing|<field>"). A ciphertext copied into another
// organization's row, or into another field, fails to decrypt instead of
// leaking.
//
// Formats:
//   v2.<kid>.<iv b64>.<ct b64>  current. The key id is in the envelope and,
//                               with the version, in the associated data.
//   v1.<iv b64>.<ct b64>        the first format: always the key
//                               PAYMENT_SECRETS_KEY (key id "k0"). Still read.
//
// Keys (Worker secrets, 32 random bytes each, base64):
//   PAYMENT_SECRETS_KEY         key id "k0" (the original key).
//   PAYMENT_SECRETS_KEYS        optional JSON {"k1":"<b64>", ...}: further keys.
//   PAYMENT_SECRETS_ACTIVE_KID  which key encrypts new values (default "k0").
// Every configured key can decrypt; only the active one encrypts. Rotation:
// add a key, make it active, re-encrypt (secretRotation.ts), check nothing
// still uses the old key, and only then remove it.
//
// What this does NOT do: all keys live in the same Worker's secrets, so
// anyone who can read them (or run code in this Worker) can decrypt every
// organization's credentials. Per-organization separation here is purpose
// binding, not compromise isolation. See docs/PAYMENT_SECURITY.md.
//
// Plaintext secrets are never returned by any API, and never logged: failures
// report only the purpose, key id and a reason class.

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

/** A stored value that could not be decrypted. The message never contains secret material. */
export class SecretDecryptError extends Error {
  constructor(readonly reason: 'format' | 'unknown_key' | 'auth_failed', readonly kid: string | null) {
    const which = kid ? ', key ' + kid : '';
    super(`secret could not be decrypted (${reason}${which})`);
  }
}

export const LEGACY_KID = 'k0';
const KID_RE = /^k\d{1,6}$/;

/** The key's 32 bytes, or SecretsUnavailable saying what is wrong with it. */
function keyBytes(raw: string | undefined, name: string): Uint8Array {
  if (!raw) throw new SecretsUnavailable(`${name} is not set`);
  let bytes: Uint8Array;
  try { bytes = unb64(raw.trim()); } catch { throw new SecretsUnavailable(`${name} is not valid base64`); }
  if (bytes.length !== 32) throw new SecretsUnavailable(`${name} must be 32 bytes`);
  return bytes;
}

/** The keys in PAYMENT_SECRETS_KEYS, checked. */
function extraKeys(json: string | undefined): [string, string][] {
  if (!json) return [];
  let extra: unknown;
  try { extra = JSON.parse(json); } catch { throw new SecretsUnavailable('PAYMENT_SECRETS_KEYS is not valid JSON'); }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new SecretsUnavailable('PAYMENT_SECRETS_KEYS must be a JSON object');
  return Object.entries(extra as Record<string, unknown>).map(([kid, raw]) => {
    if (!KID_RE.test(kid) || kid === LEGACY_KID) throw new SecretsUnavailable(`PAYMENT_SECRETS_KEYS: key id "${kid.slice(0, 12)}" must look like k1, k2…`);
    if (typeof raw !== 'string') throw new SecretsUnavailable(`PAYMENT_SECRETS_KEYS: key ${kid} must be a base64 string`);
    keyBytes(raw, 'PAYMENT_SECRETS_KEYS.' + kid);
    return [kid, raw];
  });
}

/** Every configured key by id (raw base64), and the active one. Throws SecretsUnavailable when misconfigured. */
export function keyRing(env: Pick<Env, 'PAYMENT_SECRETS_KEY' | 'PAYMENT_SECRETS_KEYS' | 'PAYMENT_SECRETS_ACTIVE_KID'>): { keys: Map<string, string>; active: string } {
  const keys = new Map<string, string>();
  if (env.PAYMENT_SECRETS_KEY) {
    keyBytes(env.PAYMENT_SECRETS_KEY, 'PAYMENT_SECRETS_KEY');
    keys.set(LEGACY_KID, env.PAYMENT_SECRETS_KEY);
  }
  for (const [kid, raw] of extraKeys(env.PAYMENT_SECRETS_KEYS)) keys.set(kid, raw);
  if (keys.size === 0) throw new SecretsUnavailable('PAYMENT_SECRETS_KEY is not set');
  const active = env.PAYMENT_SECRETS_ACTIVE_KID?.trim() || LEGACY_KID;
  if (!keys.has(active)) throw new SecretsUnavailable(`PAYMENT_SECRETS_ACTIVE_KID "${active.slice(0, 12)}" is not a configured key`);
  return { keys, active };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(raw: string): Promise<CryptoKey> {
  let key = keyCache.get(raw);
  if (!key) {
    key = crypto.subtle.importKey('raw', unb64(raw.trim()), 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, key);
  }
  return key;
}

export function secretsConfigured(env: Env): boolean {
  try { keyRing(env); return true; } catch { return false; }
}

/** The active key id, or null when storage isn't configured. */
export function activeKid(env: Env): string | null {
  try { return keyRing(env).active; } catch { return null; }
}

const v2Aad = (kid: string, context: string) => new TextEncoder().encode(`v2|${kid}|${context}`);

export async function encryptSecret(env: Env, context: string, plaintext: string): Promise<string> {
  const { keys, active } = keyRing(env);
  const key = await importKey(keys.get(active)!);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: v2Aad(active, context) },
    key, new TextEncoder().encode(plaintext),
  ));
  return `v2.${active}.${b64(iv)}.${b64(ct)}`;
}

/** Which key a stored value uses ("k0" for v1), or null when it isn't a known format. */
export function envelopeKid(envelope: string): string | null {
  const parts = envelope.split('.');
  if (parts[0] === 'v1' && parts.length === 3) return LEGACY_KID;
  if (parts[0] === 'v2' && parts.length === 4 && KID_RE.test(parts[1])) return parts[1];
  return null;
}

async function open(raw: string, iv: string, ct: string, aad: Uint8Array, kid: string): Promise<string> {
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad }, await importKey(raw), unb64(ct));
  } catch {
    throw new SecretDecryptError('auth_failed', kid);
  }
  return new TextDecoder().decode(pt);
}

export async function decryptSecret(env: Env, context: string, envelope: string): Promise<string> {
  const { keys } = keyRing(env);
  const parts = envelope.split('.');
  if (parts[0] === 'v1' && parts.length === 3) {
    const raw = keys.get(LEGACY_KID);
    if (!raw) throw new SecretDecryptError('unknown_key', LEGACY_KID);
    return open(raw, parts[1], parts[2], new TextEncoder().encode(context), LEGACY_KID);
  }
  if (parts[0] === 'v2' && parts.length === 4 && KID_RE.test(parts[1])) {
    const raw = keys.get(parts[1]);
    if (!raw) throw new SecretDecryptError('unknown_key', parts[1]);
    return open(raw, parts[2], parts[3], v2Aad(parts[1], context), parts[1]);
  }
  throw new SecretDecryptError('format', null);
}

/**
 * The purpose part of a context for telemetry: "razorpay|key_secret" plus the
 * organization id (not secret). Never the value.
 */
function purposeOf(context: string): { org: string; purpose: string } {
  const [org, ...rest] = context.split('|');
  return { org: org.slice(0, 64), purpose: rest.join('|').slice(0, 64) };
}

/**
 * Logs a decryption failure as one structured line, without secret contents,
 * so it can be found and alerted on (Workers Logs: event=secret_decrypt_failed).
 */
export function reportDecryptFailure(context: string, e: unknown, where: string): void {
  const { org, purpose } = purposeOf(context);
  let reason = 'error';
  if (e instanceof SecretDecryptError) reason = e.reason;
  else if (e instanceof SecretsUnavailable) reason = 'unconfigured';
  const kid = e instanceof SecretDecryptError ? e.kid : null;
  console.error(JSON.stringify({ event: 'secret_decrypt_failed', where, org, purpose, kid, reason }));
}

/** decryptSecret, or null after reporting the failure (for callers that must degrade, not throw). */
export async function tryDecryptSecret(env: Env, context: string, envelope: string, where: string): Promise<string | null> {
  try {
    return await decryptSecret(env, context, envelope);
  } catch (e) {
    reportDecryptFailure(context, e, where);
    return null;
  }
}

/** "rzp_live_…WXYZ" style hint for showing which key is connected. */
export function maskKeyId(keyId: string): string {
  if (keyId.length <= 12) return `${keyId.slice(0, 4)}…`;
  return `${keyId.slice(0, 9)}…${keyId.slice(-4)}`;
}
