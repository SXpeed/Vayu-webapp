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

