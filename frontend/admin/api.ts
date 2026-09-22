import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
    basePath: '/api/v2/auth',
    plugins: [twoFactorClient()],
});

export interface ApiError { status: number; code?: string; message: string }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`/api/v2${path}`, {
        ...init,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err: ApiError = { status: res.status, code: body.code, message: body.error || 'Request failed' };
        throw err;
    }
    return body as T;
}


/** Asks the person to sign in again; resolves true once they have. */
export type Reauth = () => Promise<boolean>;

/**
 * Runs a call. If the server wants a fresher sign-in (sensitive actions need
 * one newer than 30 minutes), asks once and retries. Other errors become a
 * toast, and the result is undefined.
 */
export async function guarded<T>(reauth: Reauth, fn: () => Promise<T>, onError: (message: string) => void): Promise<T | undefined> {
    try {
        return await fn();
    } catch (e) {
        const err = e as ApiError;
        if (err.code === 'reauth_required' && await reauth()) {
            try { return await fn(); } catch (e2) { onError((e2 as ApiError).message); return undefined; }
        }
        onError(err.message);
        return undefined;
    }
}

/** Request options for a JSON POST. */
export const postJson = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export function timeAgo(ms: number | string | null | undefined): string {
    if (!ms) return '—';
    const t = typeof ms === 'string' ? Date.parse(ms) : ms;
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d ago`;
    return new Date(t).toLocaleDateString();
}
